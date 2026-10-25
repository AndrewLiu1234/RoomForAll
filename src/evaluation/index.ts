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
  VISIBILITY_TOTAL_SAMPLES,
  getTargetSamplePointsWorld,
  type AttendeeEvaluation,
  type Evaluation,
  type ProfileId,
  type ProfileSummaryMetrics,
  type SceneSnapshot,
} from '../shared/index.js';
import { buildSceneAccessContext, evaluateAttendeeAccess } from './access.js';
import { simulateEvacuation } from './evacuation.js';
import { applyAndValidatePatch, compareEvaluations } from './patch.js';
import { validateSceneStructure } from './structural.js';
import { evaluateAttendeeVisibility } from './visibility.js';

export * from './geometry.js';
export * from './structural.js';
export * from './visibility.js';
export * from './access.js';
export * from './evacuation.js';
export { applyAndValidatePatch, compareEvaluations };

/**
 * Evaluates a `SceneSnapshot` deterministically:
 * - Structural validation (`isValidStructure`, `structuralErrors`)
 * - 15x9 sampled sightline raycasting against finite-height 3D box/cylinder occluders and attendee torso proxies
 * - Footprint fit, front legroom, turning space, fixed route corridor, and dynamic final-approach checks
 * - Per-profile and comparison aggregations
 */
export function evaluateScene(snapshot: SceneSnapshot): Evaluation {
  const structuralErrors = validateSceneStructure(snapshot);
  const isValidStructure = structuralErrors.length === 0;
  const hasMalformedGeometry = structuralErrors.some(
    (e) => e.code === 'MALFORMED_GEOMETRY',
  );

  const attendees: Record<string, AttendeeEvaluation> = {};
  const placeMap = new Map(snapshot.places.map((p) => [p.id, p]));
  const objectMap = new Map(snapshot.objects.map((o) => [o.id, o]));

  const samplePoints = !hasMalformedGeometry
    ? getTargetSamplePointsWorld(snapshot.target)
    : [];
  const accessContext = !hasMalformedGeometry
    ? buildSceneAccessContext(snapshot)
    : undefined;
  const evacResult = !hasMalformedGeometry
    ? simulateEvacuation(snapshot, 'emergency_evacuation')
    : undefined;
  const jammedSet = new Set(evacResult?.jammedAttendeeIds ?? []);

  for (const member of snapshot.roster) {
    const profile = snapshot.profiles[member.profileId];
    const place = placeMap.get(member.assignedPlaceId);
    const obj = place ? objectMap.get(place.objectId) : undefined;

    if (hasMalformedGeometry || !profile || !place || !obj) {
      attendees[member.attendeeId] = {
        attendeeId: member.attendeeId,
        profileId: member.profileId,
        placeId: member.assignedPlaceId,
        eyePositionWorld: [0, 0, 0],
        lookDirectionWorld: [0, 0, -1],
        visibleSamples: 0,
        totalSamples: VISIBILITY_TOTAL_SAMPLES,
        sampledVisibility: 0,
        isViewClear: false,
        routeStatus: 'blocked',
        footprintFitPass: false,
        legroomPass: false,
        turningSpacePass: false,
        usable: false,
        clearAndUsable: false,
        failedRequirements: [
          'accessible_route',
          'footprint_fit',
          'front_legroom',
          'turning_space',
          'clear_view',
        ],
        optionalPreferenceNotes: [],
        primaryBlockerIds: [],
      };
      continue;
    }

    const vis = evaluateAttendeeVisibility(
      snapshot,
      member.attendeeId,
      obj.id,
      obj.transform.yawDeg,
      samplePoints,
    );

    const acc = evaluateAttendeeAccess(
      snapshot,
      place,
      obj,
      profile,
      accessContext,
    );

    const evacTimeSec = evacResult?.attendeeTimesSec[member.attendeeId];
    const isEvacDelayed = jammedSet.has(member.attendeeId);

    const failedRequirements = [...acc.failedAccessRequirements];
    if (!vis.isViewClear) {
      failedRequirements.push('clear_view');
    }
    if (isEvacDelayed) {
      failedRequirements.push('emergency_egress_congestion');
    }

    const usable = acc.usable && !isEvacDelayed;
    const clearAndUsable = usable && vis.isViewClear;

    attendees[member.attendeeId] = {
      attendeeId: member.attendeeId,
      profileId: member.profileId,
      placeId: place.id,
      eyePositionWorld: vis.eyePositionWorld,
      lookDirectionWorld: vis.lookDirectionWorld,
      visibleSamples: vis.visibleSamples,
      totalSamples: vis.totalSamples,
      sampledVisibility: vis.sampledVisibility,
      isViewClear: vis.isViewClear,
      routeStatus: acc.routeStatus,
      footprintFitPass: acc.footprintFitPass,
      legroomPass: acc.legroomPass,
      turningSpacePass: acc.turningSpacePass,
      usable,
      clearAndUsable,
      failedRequirements,
      optionalPreferenceNotes: acc.optionalPreferenceNotes,
      primaryBlockerIds: vis.primaryBlockerIds,
      ...(evacTimeSec !== undefined ? { evacuationTimeSec: evacTimeSec } : {}),
      ...(evacTimeSec !== undefined ? { evacuationDelayed: isEvacDelayed } : {}),
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
  let hasRepresentedProfile = false;
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
      (sum, a) => sum + a.failedRequirements.length,
      0,
    );

    if (count > 0) {
      if (!hasRepresentedProfile || meanVisibility < worstProfileMeanVisibility) {
        worstProfileMeanVisibility = meanVisibility;
        hasRepresentedProfile = true;
      }
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

  const evacuationSummary = evacResult
    ? {
        mode: evacResult.mode,
        durationSec: evacResult.durationSec,
        totalEvacuationTimeSec: evacResult.totalEvacuationTimeSec,
        targetThresholdSec: evacResult.targetThresholdSec,
        evacuationPass: evacResult.evacuationPass,
        activeExitCount: evacResult.activeExitCount,
        totalExitCount: evacResult.totalExitCount,
        peakCongestionDensity: evacResult.peakCongestionDensity,
        jammedAttendeeIds: evacResult.jammedAttendeeIds,
        trappedCount: evacResult.trappedCount,
        trappedAttendeeIds: evacResult.trappedAttendeeIds,
        evacuationImpossibleReason: evacResult.evacuationImpossibleReason,
        bottleneckZones: evacResult.bottleneckZones,
        attendeeTimesSec: evacResult.attendeeTimesSec,
      }
    : undefined;

  return {
    contractVersion: CONTRACT_VERSION,
    sceneHash: snapshot.sceneHash,
    isValidStructure,
    structuralErrors,
    capacityCount: snapshot.places.length,
    occupiedCount: snapshot.roster.length,
    allModeledRequirementsMet:
      isValidStructure &&
      attendeesWithUnmetRequirements === 0 &&
      totalFailedRequirementChecks === 0,
    attendees,
    perProfile,
    comparison: {
      attendeesWithUnmetRequirements,
      totalFailedRequirementChecks,
      worstProfileMeanVisibility,
      totalVisibleSamples,
    },
    ...(evacuationSummary ? { evacuation: evacuationSummary } : {}),
  };
}
