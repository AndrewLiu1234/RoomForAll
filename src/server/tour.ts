/**
 * Stream C — Tour Spec Builder (`src/server/tour.ts`)
 * Exclusive ownership: Workstream C (`src/server/`, `tests/server/`).
 *
 * Generates deterministic `CaptureTourSpec` schedules (`keyframes: CaptureKeyframe[]`)
 * for both `phase: 'baseline'` and `phase: 'revision'`.
 * - Includes a short room overview keyframe followed by representative attendee POV
 *   keyframes (`getAttendeeCameraPose(snapshot, attendeeId)` with `fovDeg: 90`, `aspect: 1.0`).
 * - Prioritizes attendees with low visibility or route/clearance concerns plus reference
 *   comparison views.
 * - Ensures revision tours use the exact same attendee/view sequence computed at the
 *   revised snapshot's camera poses so before/after clips are directly comparable.
 */
import {
  INSPECTION_CAMERA,
  RUN_TIMING,
  getAttendeeCameraPose,
  type AttendeeAssignment,
  type CaptureKeyframe,
  type CaptureTourSpec,
  type Evaluation,
  type ProfileId,
  type SceneSnapshot,
  type Vec3,
} from '../shared/index.js';

export interface BuildCaptureTourOptions {
  runId: string;
  phase: 'baseline' | 'revision';
  snapshot: SceneSnapshot;
  evaluation?: Evaluation;
  /**
   * When building a revision tour, pass the ordered attendeeIds from the baseline tour
   * so the revision tour uses the exact same attendee/view sequence.
   */
  orderedAttendeeIds?: string[];
  deadlineIso: string;
  captureId?: string;
  totalDurationSec?: number;
}

const PROFILE_PRIORITY_ORDER: ProfileId[] = [
  'shorter_seated',
  'wheelchair_user',
  'extra_legroom',
  'reference_adult',
];

/**
 * Selects a deterministic, representative ordered list of attendee IDs for the inspection tour.
 * Prioritizes:
 * 1. Attendees with route/clearance/fit/legroom concerns (`!usable` or `failedRequirements.length > 0`)
 * 2. Attendees with low visibility (`!isViewClear` or lowest `sampledVisibility`)
 * 3. Representative attendees from each profile (including `reference_adult` comparison view)
 */
export function selectTourAttendeeOrder(
  snapshot: SceneSnapshot,
  evaluation?: Evaluation,
  maxAttendees = 4,
): string[] {
  const roster = [...snapshot.roster];
  if (roster.length === 0) return [];

  const limit = Math.max(1, Math.min(maxAttendees, roster.length));

  // Score each attendee for priority sorting (higher score = earlier in tour after overview)
  const scored = roster.map((member, rosterIndex) => {
    const attEval = evaluation?.attendees[member.attendeeId];
    let priorityScore = 0;

    if (attEval) {
      if (!attEval.isViewClear) {
        priorityScore += 1000 + Math.round((1 - attEval.sampledVisibility) * 500);
      }
      if (attEval.routeStatus === 'blocked' || !attEval.usable) {
        priorityScore += 900;
      }
      if (attEval.evacuationDelayed) {
        priorityScore += 650;
      }
      if (attEval.failedRequirements.length > 0) {
        priorityScore += 200 * attEval.failedRequirements.length;
      }
      // Tie-break by lower visibility
      priorityScore += Math.round((1 - attEval.sampledVisibility) * 100);
    }

    const profileRank = PROFILE_PRIORITY_ORDER.indexOf(member.profileId);
    const profileBonus =
      profileRank >= 0 ? (PROFILE_PRIORITY_ORDER.length - profileRank) * 10 : 0;

    return {
      member,
      rosterIndex,
      priorityScore: priorityScore + profileBonus,
    };
  });

  scored.sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) {
      return b.priorityScore - a.priorityScore;
    }
    return a.rosterIndex - b.rosterIndex;
  });

  const selected: AttendeeAssignment[] = [];
  const selectedIds = new Set<string>();

  // 1. Ensure any attendee with an active failure/concern is prioritized first
  for (const item of scored) {
    if (selected.length >= limit) break;
    const attEval = evaluation?.attendees[item.member.attendeeId];
    const hasConcern =
      attEval &&
      (!attEval.isViewClear ||
        !attEval.usable ||
        attEval.failedRequirements.length > 0);
    if (hasConcern) {
      selected.push(item.member);
      selectedIds.add(item.member.attendeeId);
    }
  }

  // 2. Ensure each represented profile (including reference_adult comparison) gets representation
  for (const profileId of PROFILE_PRIORITY_ORDER) {
    if (selected.length >= limit) break;
    const alreadyHasProfile = selected.some((m) => m.profileId === profileId);
    if (!alreadyHasProfile) {
      const candidate = scored.find(
        (s) =>
          s.member.profileId === profileId &&
          !selectedIds.has(s.member.attendeeId),
      );
      if (candidate) {
        selected.push(candidate.member);
        selectedIds.add(candidate.member.attendeeId);
      }
    }
  }

  // 3. Fill any remaining slots up to limit in priority order
  for (const item of scored) {
    if (selected.length >= limit) break;
    if (!selectedIds.has(item.member.attendeeId)) {
      selected.push(item.member);
      selectedIds.add(item.member.attendeeId);
    }
  }

  return selected.map((m) => m.attendeeId);
}

/**
 * Computes a deterministic elevated room overview camera pose that frames
 * both the audience seating area and the presentation target.
 */
export function getRoomOverviewCameraPose(snapshot: SceneSnapshot): {
  cameraPosition: Vec3;
  cameraLookAt: Vec3;
} {
  const { min, max } = snapshot.roomBounds;
  const centerX = Number(((min[0] + max[0]) / 2).toFixed(4));
  const eyeY = Number(Math.min(max[1] - 0.4, Math.max(2.6, max[1] * 0.72)).toFixed(4));
  const rearZ = Number(Math.max(min[2] + 1.0, max[2] - 0.8).toFixed(4));

  const targetCenter = snapshot.target.center;
  const lookAtZ = Number((targetCenter[2] * 0.65).toFixed(4));

  return {
    cameraPosition: [centerX, eyeY, rearZ],
    cameraLookAt: [targetCenter[0], Math.max(0.9, targetCenter[1] * 0.65), lookAtZ],
  };
}

/**
 * Builds a deterministic `CaptureTourSpec` for either `'baseline'` or `'revision'`.
 * When `orderedAttendeeIds` is provided (or extracted from baseline keyframes),
 * the revision tour preserves the exact same `viewId` and attendee sequence
 * while recomputing camera poses from the revised `snapshot`.
 */
export function buildCaptureTourSpec(
  options: BuildCaptureTourOptions,
): CaptureTourSpec {
  const {
    runId,
    phase,
    snapshot,
    evaluation,
    orderedAttendeeIds,
    deadlineIso,
  } = options;

  const captureId =
    options.captureId ?? `cap_${runId}_${phase}`;

  const attendeeIds =
    orderedAttendeeIds && orderedAttendeeIds.length > 0
      ? orderedAttendeeIds.filter((id) =>
          snapshot.roster.some((r) => r.attendeeId === id),
        )
      : selectTourAttendeeOrder(snapshot, evaluation);

  const totalViews = 1 + attendeeIds.length;
  const defaultTotalDuration = Math.min(
    RUN_TIMING.recommendedClipDurationMaxSec,
    Math.max(RUN_TIMING.recommendedClipDurationMinSec, totalViews * 2.4),
  );
  const totalDurationSec = Number(
    (options.totalDurationSec ?? defaultTotalDuration).toFixed(2),
  );

  const segmentDurationSec = totalDurationSec / totalViews;
  const keyframes: CaptureKeyframe[] = [];

  // Keyframe 0: Short room overview
  const overviewPose = getRoomOverviewCameraPose(snapshot);
  keyframes.push({
    viewId: 'view_overview_room',
    label: 'Venue Room & Seating Overview',
    kind: 'overview',
    cameraPosition: overviewPose.cameraPosition,
    cameraLookAt: overviewPose.cameraLookAt,
    fovDeg: INSPECTION_CAMERA.fovDeg,
    aspect: INSPECTION_CAMERA.aspect,
    startSec: 0,
    endSec: Number(segmentDurationSec.toFixed(2)),
  });

  // Subsequent Keyframes: Representative attendee POVs
  attendeeIds.forEach((attendeeId, idx) => {
    const member = snapshot.roster.find((r) => r.attendeeId === attendeeId);
    const pose = getAttendeeCameraPose(snapshot, attendeeId);
    const startSec = Number(((idx + 1) * segmentDurationSec).toFixed(2));
    const endSec =
      idx === attendeeIds.length - 1
        ? totalDurationSec
        : Number(((idx + 2) * segmentDurationSec).toFixed(2));

    keyframes.push({
      viewId: `view_pov_${attendeeId}`,
      label: member
        ? `${member.label} (${member.assignedPlaceId})`
        : `Attendee POV ${attendeeId}`,
      kind: 'attendee_pov',
      attendeeId: pose.attendeeId,
      placeId: pose.placeId,
      cameraPosition: pose.eyePositionWorld,
      cameraLookAt: pose.lookAtWorld,
      fovDeg: INSPECTION_CAMERA.fovDeg,
      aspect: INSPECTION_CAMERA.aspect,
      startSec,
      endSec,
    });
  });

  return {
    captureId,
    runId,
    phase,
    sceneHash: snapshot.sceneHash,
    snapshot: structuredClone(snapshot),
    keyframes,
    totalDurationSec,
    deadlineIso,
  };
}

/**
 * Extracts the ordered attendee IDs from an existing `CaptureTourSpec` or `CaptureKeyframe[]`
 * so a revision tour can replay the exact same sequence of attendee POVs.
 */
export function extractTourAttendeeOrder(
  keyframes: CaptureKeyframe[],
): string[] {
  return keyframes
    .filter(
      (kf): kf is CaptureKeyframe & { attendeeId: string } =>
        kf.kind === 'attendee_pov' && typeof kf.attendeeId === 'string',
    )
    .map((kf) => kf.attendeeId);
}
