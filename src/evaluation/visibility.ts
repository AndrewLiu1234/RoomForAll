import {
  DEG_TO_RAD,
  NUMERIC_EPSILON,
  VISIBILITY_CLEAR_MIN_SAMPLES,
  VISIBILITY_TOTAL_SAMPLES,
  getAttendeeCameraPose,
  getAttendeeTorsoProxyWorldBox,
  getTargetSamplePointsWorld,
  yawDegToForwardVector,
  yawDegToRightVector,
  type SceneSnapshot,
  type Vec3,
} from '../shared/index.js';
import {
  localToWorldPoint,
  rayIntersectsCylinder3D,
  rayIntersectsOBB3D,
  worldBoxProxyToOccluder,
  type WorldOccluder,
} from './geometry.js';

export interface VisibilityCheckResult {
  eyePositionWorld: Vec3;
  lookDirectionWorld: Vec3;
  visibleSamples: number;
  totalSamples: number;
  sampledVisibility: number;
  isViewClear: boolean;
  primaryBlockerIds: string[];
}

/**
 * Collects all finite-height world occluders for a specific attendee in `snapshot`:
 * - Every `ProxyPrimitive` with `blocksVisibility: true` on all `snapshot.objects`
 *   except the object corresponding to the viewer's own assigned `place.objectId`.
 * - Every other occupied attendee's seated body proxy via `getAttendeeTorsoProxyWorldBox`.
 */
export function collectOccludersForAttendee(
  snapshot: SceneSnapshot,
  attendeeId: string,
  ownObjectId: string,
): WorldOccluder[] {
  const occluders: WorldOccluder[] = [];

  const isStandaloneGlb = snapshot.sceneId.startsWith('glb_standalone_');
  for (const obj of snapshot.objects) {
    if (obj.id === ownObjectId) continue;
    // In standalone .glb buildings, movable_prop obstructions lowered below floor level (dy <= -0.15) have been cleared/removed
    if (
      isStandaloneGlb &&
      obj.category === 'movable_prop' &&
      obj.transform.position[1] < obj.baselineTransform.position[1] - 0.15
    ) {
      continue;
    }
    for (const proxy of obj.proxies) {
      if (!proxy.blocksVisibility) continue;
      const worldCenter = localToWorldPoint(
        obj.transform.position,
        obj.transform.yawDeg,
        proxy.localPosition,
      );
      const totalYaw = obj.transform.yawDeg + proxy.localYawDeg;
      if (proxy.kind === 'box' && proxy.size) {
        occluders.push({
          id: proxy.id,
          blockerId: obj.id,
          ownerObjectId: obj.id,
          kind: 'box',
          centerWorld: worldCenter,
          yawDeg: totalYaw,
          size: proxy.size,
        });
      } else if (
        proxy.kind === 'cylinder' &&
        proxy.radiusM !== undefined &&
        proxy.heightM !== undefined
      ) {
        occluders.push({
          id: proxy.id,
          blockerId: obj.id,
          ownerObjectId: obj.id,
          kind: 'cylinder',
          centerWorld: worldCenter,
          yawDeg: totalYaw,
          radiusM: proxy.radiusM,
          heightM: proxy.heightM,
        });
      }
    }
  }

  for (const other of snapshot.roster) {
    if (other.attendeeId === attendeeId) continue;
    const otherProfile = snapshot.profiles[other.profileId];
    const otherPlace = snapshot.places.find(
      (p) => p.id === other.assignedPlaceId,
    );
    if (!otherProfile || !otherPlace) continue;
    if (otherPlace.objectId === ownObjectId) continue;
    const otherObj = snapshot.objects.find((o) => o.id === otherPlace.objectId);
    if (!otherObj) continue;

    const torsoBox = getAttendeeTorsoProxyWorldBox(snapshot, other.attendeeId);
    occluders.push(worldBoxProxyToOccluder(torsoBox));
  }

  return occluders;
}

/**
 * Checks whether a single 3D ray from `rayOrigin` to `samplePoint` is occluded by `occluder`.
 */
export function isRayBlockedByOccluder(
  rayOrigin: Vec3,
  samplePoint: Vec3,
  occluder: WorldOccluder,
): boolean {
  if (occluder.kind === 'box' && occluder.size) {
    return rayIntersectsOBB3D(
      rayOrigin,
      samplePoint,
      occluder.centerWorld,
      occluder.size,
      occluder.yawDeg,
      occluder.ownerAttendeeId !== undefined,
    );
  }
  if (
    occluder.kind === 'cylinder' &&
    occluder.radiusM !== undefined &&
    occluder.heightM !== undefined
  ) {
    return rayIntersectsCylinder3D(
      rayOrigin,
      samplePoint,
      occluder.centerWorld,
      occluder.radiusM,
      occluder.heightM,
    );
  }
  return false;
}

/**
 * Evaluates sampled visibility (15x9 = 135 target sample points) for an attendee (PRD §6).
 */
export function evaluateAttendeeVisibility(
  snapshot: SceneSnapshot,
  attendeeId: string,
  ownObjectId: string,
  seatYawDeg: number,
  samplePoints: Vec3[] = getTargetSamplePointsWorld(snapshot.target),
): VisibilityCheckResult {
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

  const blockerRayCounts = new Map<string, number>();
  let visibleSamples = 0;

  for (const sample of samplePoints) {
    const vx = sample[0] - eye[0];
    const vy = sample[1] - eye[1];
    const vz = sample[2] - eye[2];

    // Presentation target must face the viewer (ray direction opposes target normal)
    const dotTargetNormal =
      vx * targetNormal[0] + vy * targetNormal[1] + vz * targetNormal[2];
    if (dotTargetNormal >= -NUMERIC_EPSILON) {
      continue;
    }

    // Camera local coordinates:
    // +Z_cam = forward, +X_cam = right, +Y_cam = [0, 1, 0]
    const localZ = vx * forward[0] + vy * forward[1] + vz * forward[2];
    if (
      localZ < pose.nearM - NUMERIC_EPSILON ||
      localZ > pose.farM + NUMERIC_EPSILON ||
      localZ <= NUMERIC_EPSILON
    ) {
      continue;
    }

    const localX = vx * right[0] + vy * right[1] + vz * right[2];
    const localY = vy;

    if (
      Math.abs(localX) > localZ * maxTanX + NUMERIC_EPSILON ||
      Math.abs(localY) > localZ * maxTanY + NUMERIC_EPSILON
    ) {
      continue;
    }

    // Ray is inside the 90° square frustum; check all finite-height occluders
    const hitBlockerIdsOnRay = new Set<string>();
    for (const occluder of occluders) {
      if (isRayBlockedByOccluder(eye, sample, occluder)) {
        hitBlockerIdsOnRay.add(occluder.blockerId);
      }
    }

    if (hitBlockerIdsOnRay.size === 0) {
      visibleSamples++;
    } else {
      for (const bid of hitBlockerIdsOnRay) {
        blockerRayCounts.set(bid, (blockerRayCounts.get(bid) ?? 0) + 1);
      }
    }
  }

  const primaryBlockerIds = Array.from(blockerRayCounts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .map(([id]) => id);

  const totalSamples = VISIBILITY_TOTAL_SAMPLES;
  const sampledVisibility = visibleSamples / totalSamples;
  const isViewClear = visibleSamples >= VISIBILITY_CLEAR_MIN_SAMPLES;

  return {
    eyePositionWorld: pose.eyePositionWorld,
    lookDirectionWorld: pose.lookDirectionWorld,
    visibleSamples,
    totalSamples,
    sampledVisibility,
    isViewClear,
    primaryBlockerIds,
  };
}
