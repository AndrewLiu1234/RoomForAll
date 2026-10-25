import {
  NUMERIC_EPSILON,
  PATCH_CONSTRAINTS,
  applyGroupDeltaToMemberTransform,
  withUpdatedSceneHash,
  type Evaluation,
  type EvaluationComparisonResult,
  type LayoutPatch,
  type PatchValidationResult,
  type ProfileId,
  type SceneSnapshot,
  type StructuralError,
  type Vec3,
} from '../shared/index.js';
import { validateSceneStructure } from './structural.js';

const STEP_TOLERANCE = 1e-4;

function snap4(n: number): number {
  const rounded = Number(n.toFixed(4));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function isStepMultiple(val: number, step: number): boolean {
  const nearest = Math.round(val / step) * step;
  return Math.abs(val - nearest) <= STEP_TOLERANCE;
}

function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

/**
 * Validates and applies a `LayoutPatch` to `currentSnapshot` while enforcing
 * per-proposal step/axis/yaw limits, non-overlapping target rules, cumulative
 * baseline displacement limits against `baselineSnapshot`, and structural validity (PRD §4, §5).
 */
export function applyAndValidatePatch(
  baselineSnapshot: SceneSnapshot,
  currentSnapshot: SceneSnapshot,
  patch: LayoutPatch,
): PatchValidationResult {
  if (patch.parentSceneHash !== currentSnapshot.sceneHash) {
    return {
      valid: false,
      errors: [
        {
          code: 'STALE_SCENE_HASH',
          message: `Patch parentSceneHash (${patch.parentSceneHash}) does not match current sceneHash (${currentSnapshot.sceneHash}).`,
        },
      ],
    };
  }

  if (!Array.isArray(patch.operations)) {
    return {
      valid: false,
      errors: [
        {
          code: 'MALFORMED_GEOMETRY',
          message: 'Patch operations must be an array.',
        },
      ],
    };
  }

  if (patch.operations.length > PATCH_CONSTRAINTS.maxOperations) {
    return {
      valid: false,
      errors: [
        {
          code: 'PATCH_LIMIT_EXCEEDED',
          message: `Patch contains ${patch.operations.length} operations, exceeding maxOperations (${PATCH_CONSTRAINTS.maxOperations}).`,
        },
      ],
    };
  }

  const nextSnapshot = structuredClone(currentSnapshot);
  const objectMap = new Map(nextSnapshot.objects.map((o) => [o.id, o]));
  const groupMap = new Map(nextSnapshot.chairGroups.map((g) => [g.id, g]));
  const baselineObjectMap = new Map(
    baselineSnapshot.objects.map((o) => [o.id, o]),
  );
  const baselineGroupMap = new Map(
    baselineSnapshot.chairGroups.map((g) => [g.id, g]),
  );

  // Build group membership map (combining ChairGroup.memberObjectIds and SceneObject.groupId)
  const groupMembersMap = new Map<string, Set<string>>();
  for (const grp of nextSnapshot.chairGroups) {
    groupMembersMap.set(grp.id, new Set(grp.memberObjectIds));
  }
  for (const obj of nextSnapshot.objects) {
    if (obj.groupId) {
      let set = groupMembersMap.get(obj.groupId);
      if (!set) {
        set = new Set();
        groupMembersMap.set(obj.groupId, set);
      }
      set.add(obj.id);
    }
  }

  // Check overlapping targets (duplicate targetId, or group + member object in same patch)
  const errors: StructuralError[] = [];
  const seenTargetIds = new Set<string>();
  const targetedGroupIds = new Set<string>();
  const targetedObjectIds = new Set<string>();

  for (const op of patch.operations) {
    if (seenTargetIds.has(op.targetId)) {
      errors.push({
        code: 'OVERLAPPING_PATCH_TARGETS',
        message: `Duplicate patch operation targeting ${op.targetId}.`,
        targetId: op.targetId,
      });
    }
    seenTargetIds.add(op.targetId);

    if (op.targetType === 'group') {
      targetedGroupIds.add(op.targetId);
    } else if (op.targetType === 'object') {
      targetedObjectIds.add(op.targetId);
    }
  }

  // Check if any targeted group overlaps with any targeted member object or another targeted group
  const seenGroupMemberObjects = new Set<string>();
  for (const gid of targetedGroupIds) {
    const members = groupMembersMap.get(gid);
    if (!members) continue;
    for (const memberId of members) {
      if (targetedObjectIds.has(memberId)) {
        errors.push({
          code: 'OVERLAPPING_PATCH_TARGETS',
          message: `Patch simultaneously targets ChairGroup ${gid} and its member object ${memberId}.`,
          targetId: memberId,
        });
      }
      if (seenGroupMemberObjects.has(memberId)) {
        errors.push({
          code: 'OVERLAPPING_PATCH_TARGETS',
          message: `Multiple targeted ChairGroups share member object ${memberId}.`,
          targetId: memberId,
        });
      }
      seenGroupMemberObjects.add(memberId);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Validate and apply each operation
  for (const op of patch.operations) {
    if (
      !Array.isArray(op.deltaPositionM) ||
      op.deltaPositionM.length !== 3 ||
      typeof op.deltaPositionM[0] !== 'number' ||
      typeof op.deltaPositionM[1] !== 'number' ||
      typeof op.deltaPositionM[2] !== 'number' ||
      !Number.isFinite(op.deltaPositionM[0]) ||
      !Number.isFinite(op.deltaPositionM[1]) ||
      !Number.isFinite(op.deltaPositionM[2]) ||
      typeof op.deltaYawDeg !== 'number' ||
      !Number.isFinite(op.deltaYawDeg)
    ) {
      errors.push({
        code: 'MALFORMED_GEOMETRY',
        message: `Operation on ${op.targetId} has non-finite deltaPositionM or deltaYawDeg.`,
        targetId: op.targetId,
      });
      continue;
    }

    const dx = op.deltaPositionM[0];
    const dy = op.deltaPositionM[1];
    const dz = op.deltaPositionM[2];

    // Check vertical lifting (dy must be 0)
    if (Math.abs(dy) > NUMERIC_EPSILON) {
      errors.push({
        code: 'PATCH_LIMIT_EXCEEDED',
        message: `Operation on ${op.targetId} attempts vertical translation (dy=${dy}); only horizontal movement is allowed.`,
        targetId: op.targetId,
      });
      continue;
    }

    // Check per-axis delta bounds (|dx| <= 0.60, |dz| <= 0.60)
    if (
      Math.abs(dx) > PATCH_CONSTRAINTS.maxAxisDeltaM + STEP_TOLERANCE ||
      Math.abs(dz) > PATCH_CONSTRAINTS.maxAxisDeltaM + STEP_TOLERANCE
    ) {
      errors.push({
        code: 'PATCH_LIMIT_EXCEEDED',
        message: `Operation on ${op.targetId} exceeds maxAxisDeltaM (${PATCH_CONSTRAINTS.maxAxisDeltaM}m): dx=${dx}, dz=${dz}.`,
        targetId: op.targetId,
      });
      continue;
    }

    // Check 0.05m step quantization
    if (
      !isStepMultiple(dx, PATCH_CONSTRAINTS.translationStepM) ||
      !isStepMultiple(dz, PATCH_CONSTRAINTS.translationStepM)
    ) {
      errors.push({
        code: 'PATCH_LIMIT_EXCEEDED',
        message: `Operation on ${op.targetId} uses non-${PATCH_CONSTRAINTS.translationStepM}m step increment: dx=${dx}, dz=${dz}.`,
        targetId: op.targetId,
      });
      continue;
    }

    // Check yaw delta bound (|deltaYawDeg| <= 10)
    if (
      Math.abs(op.deltaYawDeg) >
      PATCH_CONSTRAINTS.maxYawDeltaDeg + STEP_TOLERANCE
    ) {
      errors.push({
        code: 'PATCH_LIMIT_EXCEEDED',
        message: `Operation on ${op.targetId} exceeds maxYawDeltaDeg (${PATCH_CONSTRAINTS.maxYawDeltaDeg}°): deltaYawDeg=${op.deltaYawDeg}.`,
        targetId: op.targetId,
      });
      continue;
    }

    if (op.targetType === 'object') {
      const obj = objectMap.get(op.targetId);
      if (!obj) {
        errors.push({
          code: 'MISSING_REFERENCE',
          message: `Patch target object ${op.targetId} does not exist.`,
          targetId: op.targetId,
        });
        continue;
      }

      if (
        !obj.editable ||
        obj.category === 'fixed_structure' ||
        obj.category === 'stage' ||
        obj.category === 'wheelchair_bay_frame'
      ) {
        errors.push({
          code: 'FIXED_OBJECT_MODIFIED',
          message: `Object ${obj.id} (category ${obj.category}) is fixed and cannot be modified by a patch.`,
          targetId: obj.id,
        });
        continue;
      }

      obj.transform = {
        position: [
          snap4(obj.transform.position[0] + dx),
          snap4(obj.transform.position[1]),
          snap4(obj.transform.position[2] + dz),
        ],
        yawDeg: snap4(obj.transform.yawDeg + op.deltaYawDeg),
      };

      const frozenBaselinePos =
        baselineObjectMap.get(obj.id)?.baselineTransform.position ??
        obj.baselineTransform.position;
      const totalDisp = horizontalDistance(
        obj.transform.position,
        frozenBaselinePos,
      );
      if (
        totalDisp >
        PATCH_CONSTRAINTS.maxTotalDisplacementFromBaselineM + STEP_TOLERANCE
      ) {
        errors.push({
          code: 'PATCH_LIMIT_EXCEEDED',
          message: `Object ${obj.id} total displacement from baseline (${totalDisp.toFixed(4)}m) exceeds ${PATCH_CONSTRAINTS.maxTotalDisplacementFromBaselineM}m.`,
          targetId: obj.id,
        });
      }
    } else if (op.targetType === 'group') {
      const group = groupMap.get(op.targetId);
      if (!group) {
        errors.push({
          code: 'MISSING_REFERENCE',
          message: `Patch target group ${op.targetId} does not exist.`,
          targetId: op.targetId,
        });
        continue;
      }

      const groupOrigin: Vec3 = [...group.transform.position];
      const memberIds = Array.from(
        groupMembersMap.get(group.id) ?? group.memberObjectIds,
      );
      let groupMemberError = false;

      for (const memberId of memberIds) {
        const member = objectMap.get(memberId);
        if (!member) {
          errors.push({
            code: 'MISSING_REFERENCE',
            message: `ChairGroup ${group.id} references missing member object ${memberId}.`,
            targetId: group.id,
          });
          groupMemberError = true;
          continue;
        }
        if (
          !member.editable ||
          member.category === 'fixed_structure' ||
          member.category === 'stage' ||
          member.category === 'wheelchair_bay_frame'
        ) {
          errors.push({
            code: 'FIXED_OBJECT_MODIFIED',
            message: `ChairGroup ${group.id} contains non-editable member object ${member.id}.`,
            targetId: member.id,
          });
          groupMemberError = true;
        }
      }

      if (groupMemberError) continue;

      const deltaPos: [number, 0, number] = [dx, 0, dz];
      for (const memberId of memberIds) {
        const member = objectMap.get(memberId)!;
        const updatedTransform = applyGroupDeltaToMemberTransform(
          member.transform,
          groupOrigin,
          deltaPos,
          op.deltaYawDeg,
        );
        member.transform = {
          position: [
            snap4(updatedTransform.position[0]),
            snap4(updatedTransform.position[1]),
            snap4(updatedTransform.position[2]),
          ],
          yawDeg: snap4(updatedTransform.yawDeg),
        };

        const memberBasePos =
          baselineObjectMap.get(member.id)?.baselineTransform.position ??
          member.baselineTransform.position;
        const memberDisp = horizontalDistance(
          member.transform.position,
          memberBasePos,
        );
        if (
          memberDisp >
          PATCH_CONSTRAINTS.maxTotalDisplacementFromBaselineM + STEP_TOLERANCE
        ) {
          errors.push({
            code: 'PATCH_LIMIT_EXCEEDED',
            message: `Group member ${member.id} total displacement from baseline (${memberDisp.toFixed(4)}m) exceeds ${PATCH_CONSTRAINTS.maxTotalDisplacementFromBaselineM}m.`,
            targetId: member.id,
          });
        }
      }

      group.transform = {
        position: [
          snap4(group.transform.position[0] + dx),
          snap4(group.transform.position[1]),
          snap4(group.transform.position[2] + dz),
        ],
        yawDeg: snap4(group.transform.yawDeg + op.deltaYawDeg),
      };

      const groupBasePos =
        baselineGroupMap.get(group.id)?.baselineTransform.position ??
        group.baselineTransform.position;
      const groupDisp = horizontalDistance(
        group.transform.position,
        groupBasePos,
      );
      if (
        groupDisp >
        PATCH_CONSTRAINTS.maxTotalDisplacementFromBaselineM + STEP_TOLERANCE
      ) {
        errors.push({
          code: 'PATCH_LIMIT_EXCEEDED',
          message: `ChairGroup ${group.id} total displacement from baseline (${groupDisp.toFixed(4)}m) exceeds ${PATCH_CONSTRAINTS.maxTotalDisplacementFromBaselineM}m.`,
          targetId: group.id,
        });
      }
    } else {
      errors.push({
        code: 'MISSING_REFERENCE',
        message: `Unsupported patch targetType ${String(op.targetType)} for target ${op.targetId}.`,
        targetId: op.targetId,
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const updatedSnapshot = withUpdatedSceneHash(nextSnapshot);
  const structuralErrors = validateSceneStructure(updatedSnapshot);
  if (structuralErrors.length > 0) {
    return {
      valid: false,
      errors: structuralErrors,
    };
  }

  return {
    valid: true,
    errors: [],
    snapshot: updatedSnapshot,
  };
}

/**
 * Compares `baselineEval` and `candidateEval` using PRD §6 non-regression gates
 * and lexicographic comparison priorities (Workstream B §3E).
 */
export function compareEvaluations(
  baselineEval: Evaluation,
  candidateEval: Evaluation,
): EvaluationComparisonResult {
  // 1. Structural Gate
  if (
    !candidateEval.isValidStructure ||
    candidateEval.structuralErrors.length > 0
  ) {
    return {
      accepted: false,
      outcome: 'rejected_structural',
      reasons:
        candidateEval.structuralErrors.length > 0
          ? candidateEval.structuralErrors.map((e) => e.message)
          : ['Candidate scene failed structural validation.'],
    };
  }

  const regressionReasons: string[] = [];

  // 2. Per-Attendee Non-Regression Gate
  for (const [attendeeId, baseAtt] of Object.entries(baselineEval.attendees)) {
    const candAtt = candidateEval.attendees[attendeeId];
    if (!candAtt) {
      regressionReasons.push(
        `Attendee ${attendeeId} is missing in candidate evaluation.`,
      );
      continue;
    }

    if (baseAtt.routeStatus === 'clear' && candAtt.routeStatus === 'blocked') {
      regressionReasons.push(
        `Attendee ${attendeeId} modeled route regressed from clear to blocked.`,
      );
    }
    if (baseAtt.footprintFitPass && !candAtt.footprintFitPass) {
      regressionReasons.push(
        `Attendee ${attendeeId} footprintFitPass regressed from true to false.`,
      );
    }
    if (baseAtt.legroomPass && !candAtt.legroomPass) {
      regressionReasons.push(
        `Attendee ${attendeeId} legroomPass regressed from true to false.`,
      );
    }
    if (baseAtt.turningSpacePass && !candAtt.turningSpacePass) {
      regressionReasons.push(
        `Attendee ${attendeeId} turningSpacePass regressed from true to false.`,
      );
    }
  }

  // 3. Per-Profile Non-Regression Gate
  const profileIds: ProfileId[] = [
    'reference_adult',
    'shorter_seated',
    'wheelchair_user',
    'extra_legroom',
  ];

  for (const pid of profileIds) {
    const baseProf = baselineEval.perProfile[pid];
    const candProf = candidateEval.perProfile[pid];
    if (!baseProf || baseProf.attendeeCount <= 0) continue;

    if (!candProf || candProf.attendeeCount < baseProf.attendeeCount) {
      regressionReasons.push(
        `Profile ${pid} attendeeCount decreased from ${baseProf.attendeeCount} to ${candProf?.attendeeCount ?? 0}.`,
      );
      continue;
    }

    if (candProf.clearAndUsableCount < baseProf.clearAndUsableCount) {
      regressionReasons.push(
        `Profile ${pid} clearAndUsableCount regressed from ${baseProf.clearAndUsableCount} to ${candProf.clearAndUsableCount}.`,
      );
    }

    if (candProf.meanVisibility + NUMERIC_EPSILON < baseProf.meanVisibility) {
      regressionReasons.push(
        `Profile ${pid} meanVisibility regressed from ${baseProf.meanVisibility.toFixed(4)} to ${candProf.meanVisibility.toFixed(4)}.`,
      );
    }
  }

  if (regressionReasons.length > 0) {
    return {
      accepted: false,
      outcome: 'rejected_regression',
      reasons: regressionReasons,
    };
  }

  // 4. Lexicographic Improvement Order (PRD §6)
  const baseComp = baselineEval.comparison;
  const candComp = candidateEval.comparison;

  // Priority 1: Lower attendeesWithUnmetRequirements wins
  if (
    candComp.attendeesWithUnmetRequirements <
    baseComp.attendeesWithUnmetRequirements
  ) {
    return {
      accepted: true,
      outcome: 'accepted',
      reasons: [
        `Reduced attendeesWithUnmetRequirements from ${baseComp.attendeesWithUnmetRequirements} to ${candComp.attendeesWithUnmetRequirements}.`,
      ],
    };
  }
  if (
    candComp.attendeesWithUnmetRequirements >
    baseComp.attendeesWithUnmetRequirements
  ) {
    return {
      accepted: false,
      outcome: 'rejected_no_improvement',
      reasons: [
        `Candidate increased attendeesWithUnmetRequirements from ${baseComp.attendeesWithUnmetRequirements} to ${candComp.attendeesWithUnmetRequirements}.`,
      ],
    };
  }

  // Priority 2: Lower totalFailedRequirementChecks wins
  if (
    candComp.totalFailedRequirementChecks <
    baseComp.totalFailedRequirementChecks
  ) {
    return {
      accepted: true,
      outcome: 'accepted',
      reasons: [
        `Reduced totalFailedRequirementChecks from ${baseComp.totalFailedRequirementChecks} to ${candComp.totalFailedRequirementChecks}.`,
      ],
    };
  }
  if (
    candComp.totalFailedRequirementChecks >
    baseComp.totalFailedRequirementChecks
  ) {
    return {
      accepted: false,
      outcome: 'rejected_no_improvement',
      reasons: [
        `Candidate increased totalFailedRequirementChecks from ${baseComp.totalFailedRequirementChecks} to ${candComp.totalFailedRequirementChecks}.`,
      ],
    };
  }

  // Priority 3: Higher worstProfileMeanVisibility (by > NUMERIC_EPSILON) wins
  if (
    candComp.worstProfileMeanVisibility >
    baseComp.worstProfileMeanVisibility + NUMERIC_EPSILON
  ) {
    return {
      accepted: true,
      outcome: 'accepted',
      reasons: [
        `Improved worstProfileMeanVisibility from ${baseComp.worstProfileMeanVisibility.toFixed(4)} to ${candComp.worstProfileMeanVisibility.toFixed(4)}.`,
      ],
    };
  }
  if (
    candComp.worstProfileMeanVisibility + NUMERIC_EPSILON <
    baseComp.worstProfileMeanVisibility
  ) {
    return {
      accepted: false,
      outcome: 'rejected_no_improvement',
      reasons: [
        `Candidate reduced worstProfileMeanVisibility from ${baseComp.worstProfileMeanVisibility.toFixed(4)} to ${candComp.worstProfileMeanVisibility.toFixed(4)}.`,
      ],
    };
  }

  // Priority 4: Higher totalVisibleSamples wins
  if (candComp.totalVisibleSamples > baseComp.totalVisibleSamples) {
    return {
      accepted: true,
      outcome: 'accepted',
      reasons: [
        `Increased totalVisibleSamples from ${baseComp.totalVisibleSamples} to ${candComp.totalVisibleSamples}.`,
      ],
    };
  }
  if (candComp.totalVisibleSamples < baseComp.totalVisibleSamples) {
    return {
      accepted: false,
      outcome: 'rejected_no_improvement',
      reasons: [
        `Candidate reduced totalVisibleSamples from ${baseComp.totalVisibleSamples} to ${candComp.totalVisibleSamples}.`,
      ],
    };
  }

  // Tied on all four priorities: preserve current best
  return {
    accepted: false,
    outcome: 'rejected_no_improvement',
    reasons: [
      'Candidate evaluation tied baseline on all four lexicographic comparison priorities.',
    ],
  };
}
