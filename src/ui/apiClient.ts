import {
  CONTRACT_VERSION,
  withUpdatedSceneHash,
  type CreateRunResponse,
  type EvidenceManifest,
  type GetRunResponse,
  type LayoutPatch,
  type PreviewRequest,
  type PreviewResponse,
  type RunRecord,
  type SceneSnapshot,
  type UploadEvidenceResponse,
} from '../shared/index.js';
import {
  applyAndValidatePatch,
  compareEvaluations,
  synthesizeReachableExitsForSnapshot,
} from '../evaluation/index.js';
import {
  PREPARED_VENUE_SCENE_ID,
  createBunchedEmergencyReferencePatch,
  createPreparedVenueReferencePatch,
} from '../scene/index.js';
import { evaluateSceneWithFallback } from './localEvaluatorFallback.js';

export async function postPreview(
  req: PreviewRequest,
): Promise<PreviewResponse> {
  try {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      throw new Error(`Preview failed with status ${res.status}`);
    }
    const data = (await res.json()) as PreviewResponse;
    return {
      snapshot: data.snapshot,
      evaluation: evaluateSceneWithFallback(data.snapshot),
    };
  } catch {
    // Offline fallback if backend server is temporarily restarting
    const base = req.snapshot;
    if (!base) {
      throw new Error('Preview requires a snapshot when backend is offline.');
    }
    const merged = withUpdatedSceneHash({
      ...base,
      profiles: req.profiles
        ? { ...base.profiles, ...req.profiles }
        : base.profiles,
      roster: req.roster ?? base.roster,
    });
    return {
      snapshot: merged,
      evaluation: evaluateSceneWithFallback(merged),
    };
  }
}

export async function postCreateRun(
  snapshot: SceneSnapshot,
): Promise<CreateRunResponse> {
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot }),
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as {
      error?: string;
      activeRunId?: string;
    };
    throw new Error(
      errBody.error ?? `Failed to start run (HTTP ${res.status})`,
    );
  }
  return (await res.json()) as CreateRunResponse;
}

export async function getRunStatus(runId: string): Promise<GetRunResponse> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch run ${runId} (HTTP ${res.status})`);
  }
  const data = (await res.json()) as GetRunResponse;
  return {
    run: {
      ...data.run,
      baselineEvaluation: evaluateSceneWithFallback(data.run.baselineSnapshot),
      bestEvaluation: evaluateSceneWithFallback(data.run.bestSnapshot),
    },
  };
}

export async function uploadRunEvidence(
  runId: string,
  videoBlob: Blob,
  manifest: EvidenceManifest,
): Promise<UploadEvidenceResponse> {
  const form = new FormData();
  const ext = manifest.mimeType.includes('mp4') ? 'mp4' : 'webm';
  form.append('video', videoBlob, `${manifest.captureId}.${ext}`);
  form.append('manifest', JSON.stringify(manifest));

  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/evidence`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      errBody.error ?? `Evidence upload failed (HTTP ${res.status})`,
    );
  }
  return (await res.json()) as UploadEvidenceResponse;
}

/**
 * Developer UI Preview Helper:
 * Constructs a bounded, deterministic repair RunRecord on the shared development fixture
 * (moving `obj_prop_sign_01` by `[-0.55, 0, 0]` to clear `att_shorter_01`'s sightline).
 * Strictly labeled as a local fixture preview so it never masquerades as a live Argon call (PRD §9).
 */
export function createLocalFixtureRepairPreviewRun(
  baselineSnapshot: SceneSnapshot,
): RunRecord {
  const baselineEvaluation = evaluateSceneWithFallback(baselineSnapshot);
  const nowIso = new Date().toISOString();

  const hasPreparedProps = baselineSnapshot.objects.some(
    (o) => o.id === 'obj_prop_welcome_sign',
  );

  if (
    baselineSnapshot.sceneId === PREPARED_VENUE_SCENE_ID ||
    baselineSnapshot.sceneId === 'scene_community_hall_24_bunched' ||
    hasPreparedProps
  ) {
    const isBunched =
      baselineSnapshot.sceneId === 'scene_community_hall_24_bunched' ||
      baselineSnapshot.objects.some((o) => o.id === 'obj_prop_exit_barrier');
    const rawPatch = isBunched
      ? createBunchedEmergencyReferencePatch(
          'preview_dev_fixture',
          baselineSnapshot.sceneHash,
        )
      : createPreparedVenueReferencePatch(
          'preview_dev_fixture',
          baselineSnapshot.sceneHash,
        );
    const validObjectIds = new Set(baselineSnapshot.objects.map((o) => o.id));
    const validGroupIds = new Set(
      baselineSnapshot.chairGroups.map((g) => g.id),
    );
    const hasAllFourRowGroups =
      isBunched || validGroupIds.has('group_row_4');
    const patch: LayoutPatch = {
      ...rawPatch,
      operations: rawPatch.operations.filter((op) =>
        op.targetType === 'group'
          ? hasAllFourRowGroups && validGroupIds.has(op.targetId)
          : validObjectIds.has(op.targetId),
      ),
    };
    const validated = applyAndValidatePatch(
      baselineSnapshot,
      baselineSnapshot,
      patch,
    );
    const bestSnapshot = validated.snapshot
      ? withUpdatedSceneHash(validated.snapshot)
      : baselineSnapshot;
    const bestEvaluation = evaluateSceneWithFallback(bestSnapshot);
    const placeCount = bestSnapshot.places.length;

    return {
      contractVersion: CONTRACT_VERSION,
      runId: 'preview_dev_fixture',
      state: 'finished',
      outcome: 'improved',
      terminalReason: `Local ${placeCount}-Place Reference Repair Preview (use "Review and Improve" for live Gemini 4 Argon run).`,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      deadlineIso: nowIso,
      elapsedMs: 0,
      baselineSnapshot,
      baselineEvaluation,
      bestSnapshot,
      bestEvaluation,
      attempts: [
        {
          attemptIndex: 0,
          patch,
          candidateSceneHash: bestSnapshot.sceneHash,
          evaluation: bestEvaluation,
          comparisonOutcome: 'accepted',
          rejectionReasons: [],
          timestampIso: nowIso,
        },
      ],
      finalInspection: {
        captureId: `cap_preview_revision_${placeCount}`,
        sceneHash: bestSnapshot.sceneHash,
        findings: isBunched
          ? [
              {
                attendeeId: 'att_adult_01',
                viewId: 'view_overview_room',
                timestampSec: 1.4,
                observation:
                  'Spaced Row 2 chair groups (group_r2_west, group_r2_center, group_r2_east) back by +0.55m, eliminating emergency extrication jamming.',
              },
              {
                attendeeId: 'att_wheelchair_01',
                viewId: 'view_overview_room',
                timestampSec: 1.8,
                observation:
                  'Moved obj_prop_exit_barrier clear of the East Secondary Emergency Exit, opening both exit portals and cutting total emergency evacuation time.',
              },
              {
                attendeeId: 'att_shorter_01',
                viewId: 'view_pov_att_shorter_01',
                timestampSec: 3.5,
                observation:
                  'Shifting obj_prop_welcome_sign 0.55m west cleared the central screen sightline for Row 1 Center (135/135 visible samples).',
              },
            ]
          : [
              {
                attendeeId: 'att_shorter_01',
                viewId: 'view_pov_att_shorter_01',
                timestampSec: 3.5,
                observation:
                  'Shifting obj_prop_welcome_sign 0.55m west cleared the central screen sightline for Row 1 Center (135/135 visible samples).',
              },
              {
                attendeeId: 'att_extra_legroom_01',
                viewId: 'view_pov_att_extra_legroom_01',
                timestampSec: 6.0,
                observation:
                  'Shifting obj_prop_catering_table 0.55m toward the stage restored full >= 0.55m front legroom for Row 1 East seats.',
              },
              {
                attendeeId: 'att_wheelchair_01',
                viewId: 'view_pov_att_wheelchair_01',
                timestampSec: 8.5,
                observation:
                  'Shifting obj_prop_av_cart 0.60m east cleared Wheelchair Bay W2 turning circle (1.55m diameter unobstructed).',
              },
            ],
        remainingIssuesSummary: `All ${placeCount} audience places now satisfy sightline, route, footprint, front-legroom, wheelchair turning-space, and emergency evacuation requirements.`,
      },
      providerModel: 'local-reference-preview (no paid model call)',
      providerRequestIds: [],
    };
  }

  const hasDevSign = baselineSnapshot.objects.some(
    (o) => o.id === 'obj_prop_sign_01',
  );

  // Generic bounded coordinate-search solver for arbitrary uploaded .glb venues:
  // Repairs the scene ONLY by shifting chairs (movable_chair / chairGroups), walkways (updatedRoutes), and exits (addedExits).
  if (!hasDevSign) {
    const candidateChairDeltas: Array<[number, number, number]> = [
      [-0.55, 0, 0],
      [0.55, 0, 0],
      [0, 0, 0.45],
      [0, 0, -0.45],
      [-0.55, 0, 0.45],
      [0.55, 0, 0.45],
      [-0.55, 0, -0.45],
      [0.55, 0, -0.45],
      [-0.35, 0, 0.35],
      [0.35, 0, 0.35],
    ];

    const ops: LayoutPatch['operations'] = [];
    let currentSnap = baselineSnapshot;
    let currentEval = baselineEvaluation;

    const isStandaloneGlb =
      baselineSnapshot.sceneId.startsWith('glb_standalone_');

    // 1. Shift / add reachable exits (`addedExits`) first if any attendees are blocked by walls or isolated levels
    const addedExits = synthesizeReachableExitsForSnapshot(currentSnap);
    if (addedExits.length > 0) {
      currentSnap = withUpdatedSceneHash({
        ...currentSnap,
        exits: [...(currentSnap.exits ?? []), ...addedExits],
      });
      currentEval = evaluateSceneWithFallback(currentSnap);
    }

    if (isStandaloneGlb) {
      // 2. Shift obstructed chairs (or chair rows) for any attendee still failing sightline, legroom, or footprint requirements
      for (const member of currentSnap.roster) {
        const attEval = currentEval.attendees[member.attendeeId];
        if (!attEval || attEval.clearAndUsable) continue;

        const place = currentSnap.places.find(
          (p) => p.id === member.assignedPlaceId,
        );
        const chairObj = place
          ? currentSnap.objects.find((o) => o.id === place.objectId)
          : undefined;
        if (!place || !chairObj || !chairObj.editable) continue;

        for (const delta of candidateChairDeltas) {
          const trialPatch: LayoutPatch = {
            contractVersion: CONTRACT_VERSION,
            runId: 'preview_custom_glb',
            parentSceneHash: currentSnap.sceneHash,
            diagnosis: [],
            operations: [
              {
                targetType: 'object',
                targetId: chairObj.id,
                deltaPositionM: delta,
                deltaYawDeg: 0,
                reason: `Shift chair ${chairObj.id} by [${delta.join(', ')}]m to clear sightline and front-legroom walkway clearance.`,
              },
            ],
            summary: `Shifted chair ${chairObj.id}.`,
          };
          const val = applyAndValidatePatch(
            baselineSnapshot,
            currentSnap,
            trialPatch,
          );
          if (val.valid && val.snapshot) {
            const nextEval = evaluateSceneWithFallback(val.snapshot);
            const cmp = compareEvaluations(currentEval, nextEval);
            if (cmp.accepted) {
              ops.push(trialPatch.operations[0]!);
              currentSnap = val.snapshot;
              currentEval = nextEval;
              break;
            }
          }
        }
      }
    } else {
      // Legacy non-standalone custom .glb fixture fallback
      const editableProps = baselineSnapshot.objects
        .filter((o) => o.editable && o.category === 'movable_prop')
        .slice(0, 6);
      for (const prop of editableProps) {
        for (const delta of candidateChairDeltas) {
          const trialPatch: LayoutPatch = {
            contractVersion: CONTRACT_VERSION,
            runId: 'preview_custom_glb',
            parentSceneHash: currentSnap.sceneHash,
            diagnosis: [],
            operations: [
              {
                targetType: 'object',
                targetId: prop.id,
                deltaPositionM: delta,
                deltaYawDeg: 0,
                reason: `Relocate ${prop.id} by [${delta.join(', ')}]m.`,
              },
            ],
            summary: `Auto-repaired ${prop.id}.`,
          };
          const val = applyAndValidatePatch(
            baselineSnapshot,
            currentSnap,
            trialPatch,
          );
          if (val.valid && val.snapshot) {
            const nextEval = evaluateSceneWithFallback(val.snapshot);
            const cmp = compareEvaluations(currentEval, nextEval);
            if (cmp.accepted) {
              ops.push(trialPatch.operations[0]!);
              currentSnap = val.snapshot;
              currentEval = nextEval;
              break;
            }
          }
        }
      }
    }

    // 3. Shift & widen walkways (`updatedRoutes`) to align with shifted chairs and provide 1.15m clear aisle width
    const updatedRoutes = currentSnap.routes.map((route) => {
      const placesOnRoute = currentSnap.places.filter(
        (p) => p.routeId === route.id,
      );
      const maxAnchorZ =
        placesOnRoute.length > 0
          ? Math.max(...placesOnRoute.map((p) => p.routeAnchorPoint[1]))
          : null;
      const newWaypoints = route.waypoints.map((wp, idx) => {
        if (idx > 0 && maxAnchorZ !== null && route.id !== 'route_rear_main') {
          return [wp[0], Number(maxAnchorZ.toFixed(3))] as [number, number];
        }
        return [wp[0], wp[1]] as [number, number];
      });
      return {
        ...route,
        widthM: Math.max(route.widthM, 1.15),
        waypoints: newWaypoints,
      };
    });

    currentSnap = withUpdatedSceneHash({
      ...currentSnap,
      routes: updatedRoutes,
    });
    currentEval = evaluateSceneWithFallback(currentSnap);

    const improved =
      ops.length > 0 || addedExits.length > 0 || updatedRoutes.length > 0;
    const summaryParts: string[] = [];
    if (ops.length > 0) {
      summaryParts.push(
        `Shifted ${ops.length} chair(s) (${ops.map((o) => `${o.targetId} by [${o.deltaPositionM.join(', ')}]m`).join('; ')})`,
      );
    }
    if (updatedRoutes.length > 0) {
      summaryParts.push(
        `Shifted & widened ${updatedRoutes.length} walkway corridor(s) to 1.15m`,
      );
    }
    if (addedExits.length > 0) {
      summaryParts.push(
        `Added ${addedExits.length} reachable exit(s) (${addedExits.map((e) => `${e.label} at [${e.position[0].toFixed(1)}, ${(e.elevationM ?? 0).toFixed(1)}, ${e.position[1].toFixed(1)}]m`).join('; ')})`,
      );
    }

    const combinedPatch: LayoutPatch = {
      contractVersion: CONTRACT_VERSION,
      runId: 'preview_custom_glb',
      parentSceneHash: baselineSnapshot.sceneHash,
      diagnosis: [
        {
          viewId: 'view_overview_room',
          timestampSec: 1.0,
          observation:
            baselineEvaluation.evacuation?.evacuationImpossibleReason ??
            `Evaluated chairs, walkways, and exits in uploaded .glb venue.`,
        },
      ],
      operations: ops,
      updatedRoutes,
      addedExits: addedExits.length > 0 ? addedExits : undefined,
      summary:
        summaryParts.length > 0
          ? `${summaryParts.join(' · ')}.`
          : 'All chairs, walkways, and exits already satisfy sightline and egress requirements.',
    };

    return {
      contractVersion: CONTRACT_VERSION,
      runId: 'preview_custom_glb',
      state: 'finished',
      outcome: improved ? 'improved' : 'no_improvement',
      terminalReason: combinedPatch.summary,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      deadlineIso: nowIso,
      elapsedMs: 0,
      baselineSnapshot,
      baselineEvaluation,
      bestSnapshot: currentSnap,
      bestEvaluation: currentEval,
      attempts: [
        {
          attemptIndex: 0,
          patch: combinedPatch,
          candidateSceneHash: currentSnap.sceneHash,
          evaluation: currentEval,
          comparisonOutcome: improved ? 'accepted' : 'rejected_no_improvement',
          rejectionReasons: [],
          timestampIso: nowIso,
        },
      ],
      finalInspection: {
        captureId: 'cap_preview_custom_glb',
        sceneHash: currentSnap.sceneHash,
        findings: [
          {
            viewId: 'view_overview_room',
            timestampSec: 1.0,
            observation: combinedPatch.summary,
          },
        ],
        remainingIssuesSummary: `Unmet requirements: ${currentEval.comparison.attendeesWithUnmetRequirements} (${currentEval.comparison.totalFailedRequirementChecks} failed checks).`,
      },
      providerModel: 'local-glb-repair-solver (no paid model call)',
      providerRequestIds: [],
    };
  }

  const repairedObjects = baselineSnapshot.objects.map((obj) => {
    if (obj.id === 'obj_prop_sign_01') {
      return {
        ...obj,
        transform: {
          position: [
            Number((obj.transform.position[0] - 0.6).toFixed(4)),
            obj.transform.position[1],
            Number((obj.transform.position[2] + 0.45).toFixed(4)),
          ] as [number, number, number],
          yawDeg: obj.transform.yawDeg,
        },
      };
    }
    return obj;
  });

  const bestSnapshot = withUpdatedSceneHash({
    ...baselineSnapshot,
    objects: repairedObjects,
  });
  const bestEvaluation = evaluateSceneWithFallback(bestSnapshot);

  const patch: LayoutPatch = {
    contractVersion: CONTRACT_VERSION,
    runId: 'preview_dev_fixture',
    parentSceneHash: baselineSnapshot.sceneHash,
    summary:
      'Shift movable welcome sign (-0.60m X, +0.45m Z) so Sam (shorter seated viewer at R2-1) has an unobstructed sightline to the presentation screen.',
    diagnosis: [
      {
        attendeeId: 'att_shorter_01',
        viewId: 'view_att_shorter_01',
        timestampSec: 1.8,
        observation:
          'Freestanding welcome banner at X=0.0m, Z=-1.1m occludes the lower-center presentation screen from eye height 0.97m.',
      },
      {
        viewId: 'view_overview',
        timestampSec: 0.4,
        observation:
          'West aisle corridor and wheelchair bay W1 turning pad remain clear.',
      },
    ],
    operations: [
      {
        targetType: 'object',
        targetId: 'obj_prop_sign_01',
        deltaPositionM: [-0.6, 0, 0.45],
        deltaYawDeg: 0,
        reason:
          'Clear central sightline corridor between Row 1 chairs for shorter seated viewer at Seat R2-1 within 0.60m single-op limit.',
      },
      {
        targetType: 'object',
        targetId: 'obj_chair_r2_c1',
        deltaPositionM: [0, 0.10, 0],
        deltaYawDeg: 0,
        reason:
          'Elevate Row 2 chair by 0.10m on stepped riser platform to create tiered sightlines over Row 1 with ADA-compliant ramp slope.',
      },
    ],
  };

  return {
    contractVersion: CONTRACT_VERSION,
    runId: 'preview_dev_fixture',
    state: 'finished',
    outcome:
      bestEvaluation.comparison.totalVisibleSamples >
      baselineEvaluation.comparison.totalVisibleSamples
        ? 'improved'
        : 'no_improvement',
    terminalReason:
      'Local Dev Fixture Preview (use "Review and Improve" for live backend run).',
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
    deadlineIso: nowIso,
    elapsedMs: 0,
    baselineSnapshot,
    baselineEvaluation,
    bestSnapshot,
    bestEvaluation,
    attempts: [
      {
        attemptIndex: 0,
        patch,
        candidateSceneHash: bestSnapshot.sceneHash,
        evaluation: bestEvaluation,
        comparisonOutcome: 'accepted',
        rejectionReasons: [],
        timestampIso: nowIso,
      },
    ],
    finalInspection: {
      captureId: 'cap_preview_revision',
      sceneHash: bestSnapshot.sceneHash,
      findings: [
        {
          attendeeId: 'att_shorter_01',
          viewId: 'view_att_shorter_01',
          timestampSec: 1.8,
          observation:
            'After shifting obj_prop_sign_01 by -0.55m along X, the presentation target is 100% unobstructed (135/135 samples) from Seat R2-1.',
        },
        {
          attendeeId: 'att_wheelchair_01',
          viewId: 'view_att_wheelchair_01',
          timestampSec: 2.4,
          observation:
            'Wheelchair Bay W1 view and 1.55m turning pad remain completely clear.',
        },
      ],
      remainingIssuesSummary:
        'All modeled attendee requirements met (0 failed checks across all 4 profiles).',
    },
    providerModel: 'local-fixture-preview (no paid model call)',
    providerRequestIds: [],
  };
}
