import {
  DEG_TO_RAD,
  NUMERIC_EPSILON,
  getAttendeeCameraPose,
  getTargetSamplePointsWorld,
  yawDegToForwardVector,
  yawDegToRightVector,
  type Evaluation,
  type SceneSnapshot,
  type Vec3,
  type WorldBoxProxy,
} from '../shared/index.js';
import {
  collectOccludersForAttendee,
  evaluateScene,
  isRayBlockedByOccluder,
} from '../evaluation/index.js';

export function collectWorldVisibilityBlockers(
  snapshot: SceneSnapshot,
): WorldBoxProxy[] {
  const occluders = collectOccludersForAttendee(snapshot, '__none__', '__none__');
  return occluders.map((occ) => ({
    id: occ.id,
    ownerObjectId: occ.ownerObjectId,
    ownerAttendeeId: occ.ownerAttendeeId,
    centerWorld: occ.centerWorld,
    size:
      occ.kind === 'cylinder'
        ? [
            (occ.radiusM ?? 0.25) * 2,
            occ.heightM ?? 1.0,
            (occ.radiusM ?? 0.25) * 2,
          ]
        : (occ.size ?? [0.5, 0.5, 0.5]),
    yawDeg: occ.yawDeg,
  }));
}

/**
 * Computes the exact per-sample visibility mask (`15x9 = 135` booleans) for `attendeeId`
 * by delegating directly to Stream B's `collectOccludersForAttendee` and `isRayBlockedByOccluder`.
 */
export function computeAttendeeSampleVisibilityMask(
  snapshot: SceneSnapshot,
  attendeeId: string,
): {
  samplePoints: Vec3[];
  visibleMask: boolean[];
  blockerIds: string[];
} {
  const samplePoints = getTargetSamplePointsWorld(snapshot.target);
  const member = snapshot.roster.find((a) => a.attendeeId === attendeeId);
  if (!member) {
    return {
      samplePoints,
      visibleMask: samplePoints.map(() => false),
      blockerIds: [],
    };
  }

  const place = snapshot.places.find((p) => p.id === member.assignedPlaceId);
  const ownObjectId = place?.objectId ?? '';
  const obj = snapshot.objects.find((o) => o.id === ownObjectId);
  const seatYawDeg = obj?.transform.yawDeg ?? 0;

  const pose = getAttendeeCameraPose(snapshot, attendeeId);
  const eye = pose.eyePositionWorld;
  const forward = yawDegToForwardVector(seatYawDeg);
  const right = yawDegToRightVector(seatYawDeg);
  const targetNormal = yawDegToForwardVector(snapshot.target.yawDeg);
  const halfFovTan = Math.tan(pose.fovDeg * 0.5 * DEG_TO_RAD);
  const maxTanX = halfFovTan * pose.aspect;
  const maxTanY = halfFovTan;

  const occluders = collectOccludersForAttendee(
    snapshot,
    attendeeId,
    ownObjectId,
  );

  const blockerHitCounts = new Map<string, number>();
  const visibleMask: boolean[] = [];

  for (const sample of samplePoints) {
    const vx = sample[0] - eye[0];
    const vy = sample[1] - eye[1];
    const vz = sample[2] - eye[2];

    const dotTargetNormal =
      vx * targetNormal[0] + vy * targetNormal[1] + vz * targetNormal[2];
    if (dotTargetNormal >= -NUMERIC_EPSILON) {
      visibleMask.push(false);
      continue;
    }

    const localZ = vx * forward[0] + vy * forward[1] + vz * forward[2];
    if (
      localZ < pose.nearM - NUMERIC_EPSILON ||
      localZ > pose.farM + NUMERIC_EPSILON ||
      localZ <= NUMERIC_EPSILON
    ) {
      visibleMask.push(false);
      continue;
    }

    const localX = vx * right[0] + vy * right[1] + vz * right[2];
    const localY = vy;
    if (
      Math.abs(localX) > localZ * maxTanX + NUMERIC_EPSILON ||
      Math.abs(localY) > localZ * maxTanY + NUMERIC_EPSILON
    ) {
      visibleMask.push(false);
      continue;
    }

    let blocked = false;
    for (const occ of occluders) {
      if (isRayBlockedByOccluder(eye, sample, occ)) {
        blocked = true;
        blockerHitCounts.set(
          occ.blockerId,
          (blockerHitCounts.get(occ.blockerId) ?? 0) + 1,
        );
      }
    }
    visibleMask.push(!blocked);
  }

  const blockerIds = [...blockerHitCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  return { samplePoints, visibleMask, blockerIds };
}

/**
 * Evaluates a `SceneSnapshot` deterministically via Stream B's authoritative `evaluateScene(snapshot)`.
 */
export function evaluateSceneWithFallback(snapshot: SceneSnapshot): Evaluation {
  return evaluateScene(snapshot);
}
