/**
 * Stream B — Deterministic Geometry, Scoring & Patch Validation (`src/evaluation/index.ts`)
 * Exclusive ownership: Workstream B (`src/evaluation/`, `tests/evaluation/`).
 *
 * Required pure exports per PRD §10 Step 2 & ARGON_MVP_PROMPT.md §2:
 * - `evaluateScene(snapshot)`
 * - `applyAndValidatePatch(baselineSnapshot, currentSnapshot, patch)`
 * - `compareEvaluations(baselineEval, candidateEval)`
 */
import {
  CONTRACT_VERSION,
  VISIBILITY_CLEAR_MIN_SAMPLES,
  VISIBILITY_TOTAL_SAMPLES,
  getAttendeeCameraPose,
  type AttendeeEvaluation,
  type Evaluation,
  type EvaluationComparisonResult,
  type LayoutPatch,
  type PatchValidationResult,
  type ProfileId,
  type ProfileSummaryMetrics,
  type SceneSnapshot,
} from '../shared/index.js';

/**
 * Evaluates a `SceneSnapshot` deterministically.
 * Stream B replaces the placeholder geometric checks with full 15x9 raycasting,
 * corridor/final-approach clearance, footprint/legroom, and structural checks.
 */
export function evaluateScene(snapshot: SceneSnapshot): Evaluation {
  const attendees: Record<string, AttendeeEvaluation> = {};

  for (const member of snapshot.roster) {
    const pose = getAttendeeCameraPose(snapshot, member.attendeeId);
    const visibleSamples = VISIBILITY_TOTAL_SAMPLES;
    const isViewClear = visibleSamples >= VISIBILITY_CLEAR_MIN_SAMPLES;

    attendees[member.attendeeId] = {
      attendeeId: member.attendeeId,
      profileId: member.profileId,
      placeId: member.assignedPlaceId,
      eyePositionWorld: pose.eyePositionWorld,
      lookDirectionWorld: pose.lookDirectionWorld,
      visibleSamples,
      totalSamples: VISIBILITY_TOTAL_SAMPLES,
      sampledVisibility: visibleSamples / VISIBILITY_TOTAL_SAMPLES,
      isViewClear,
      routeStatus: 'clear',
      footprintFitPass: true,
      legroomPass: true,
      turningSpacePass: true,
      usable: true,
      clearAndUsable: isViewClear,
      failedRequirements: [],
      optionalPreferenceNotes: [],
      primaryBlockerIds: [],
    };
  }

  const profileIds: ProfileId[] = [
    'reference_adult',
    'shorter_seated',
    'wheelchair_user',
    'extra_legroom',
  ];

  const perProfile = {} as Record<ProfileId, ProfileSummaryMetrics>;
  let worstProfileMeanVisibility = 1.0;
  let totalVisibleSamples = 0;
  let attendeesWithUnmetRequirements = 0;
  let totalFailedRequirementChecks = 0;

  for (const pid of profileIds) {
    const list = Object.values(attendees).filter((a) => a.profileId === pid);
    const count = list.length;
    const usableCount = list.filter((a) => a.usable).length;
    const clearViewCount = list.filter((a) => a.isViewClear).length;
    const clearAndUsableCount = list.filter((a) => a.clearAndUsable).length;
    const meanVisibility =
      count > 0
        ? list.reduce((sum, a) => sum + a.sampledVisibility, 0) / count
        : 1.0;
    const unmetRequirementCount = list.filter(
      (a) => !a.clearAndUsable || a.failedRequirements.length > 0,
    ).length;
    const failedCheckCount = list.reduce(
      (sum, a) => sum + a.failedRequirements.length + (a.isViewClear ? 0 : 1),
      0,
    );

    if (count > 0 && meanVisibility < worstProfileMeanVisibility) {
      worstProfileMeanVisibility = meanVisibility;
    }
    totalVisibleSamples += list.reduce((sum, a) => sum + a.visibleSamples, 0);
    attendeesWithUnmetRequirements += unmetRequirementCount;
    totalFailedRequirementChecks += failedCheckCount;

    perProfile[pid] = {
      profileId: pid,
      attendeeCount: count,
      usableCount,
      clearViewCount,
      clearAndUsableCount,
      meanVisibility,
      unmetRequirementCount,
      failedCheckCount,
    };
  }

  return {
    contractVersion: CONTRACT_VERSION,
    sceneHash: snapshot.sceneHash,
    isValidStructure: true,
    structuralErrors: [],
    capacityCount: snapshot.places.length,
    occupiedCount: snapshot.roster.length,
    allModeledRequirementsMet:
      attendeesWithUnmetRequirements === 0 && totalFailedRequirementChecks === 0,
    attendees,
    perProfile,
    comparison: {
      attendeesWithUnmetRequirements,
      totalFailedRequirementChecks,
      worstProfileMeanVisibility,
      totalVisibleSamples,
    },
  };
}

/**
 * Validates and applies a `LayoutPatch` to `currentSnapshot` while enforcing
 * baseline displacement limits against `baselineSnapshot`.
 * Owned by Stream B.
 */
export function applyAndValidatePatch(
  _baselineSnapshot: SceneSnapshot,
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
  return {
    valid: true,
    errors: [],
    snapshot: structuredClone(currentSnapshot),
  };
}

/**
 * Compares `baselineEval` and `candidateEval` using PRD §6 non-regression gates
 * and lexicographic comparison priorities.
 * Owned by Stream B.
 */
export function compareEvaluations(
  baselineEval: Evaluation,
  candidateEval: Evaluation,
): EvaluationComparisonResult {
  if (!candidateEval.isValidStructure) {
    return {
      accepted: false,
      outcome: 'rejected_structural',
      reasons: candidateEval.structuralErrors.map((e) => e.message),
    };
  }
  if (candidateEval.sceneHash === baselineEval.sceneHash) {
    return {
      accepted: false,
      outcome: 'rejected_no_improvement',
      reasons: ['Candidate scene hash is identical to baseline.'],
    };
  }
  return {
    accepted: false,
    outcome: 'rejected_no_improvement',
    reasons: ['Stream B comparison logic pending full implementation.'],
  };
}
