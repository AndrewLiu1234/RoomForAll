import {
  DEG_TO_RAD,
  getAttendeeCameraPose,
  getAttendeeTorsoProxyWorldBox,
  getTargetSamplePointsWorld,
  yawDegToForwardVector,
  yawDegToRightVector,
  type Evaluation,
  type SceneSnapshot,
  type Vec3,
  type WorldBoxProxy,
} from '../shared/index.js';
import { evaluateScene } from '../evaluation/index.js';

/**
 * Checks whether a 3D ray from `origin` to `targetPoint` (segment `t in (0.001, 0.999)`)
 * intersects an oriented 3D box centered at `box.centerWorld` with dimensions `box.size`
 * and right-handed yaw `box.yawDeg` about +Y.
 */
function raySegmentIntersectsOrientedBox(
  origin: Vec3,
  targetPoint: Vec3,
  box: WorldBoxProxy,
): boolean {
  const dx = targetPoint[0] - origin[0];
  const dy = targetPoint[1] - origin[1];
  const dz = targetPoint[2] - origin[2];

  const relOx = origin[0] - box.centerWorld[0];
  const relOy = origin[1] - box.centerWorld[1];
  const relOz = origin[2] - box.centerWorld[2];

  const rad = -box.yawDeg * DEG_TO_RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const localOx = relOx * cos - relOz * sin;
  const localOy = relOy;
  const localOz = relOx * sin + relOz * cos;

  const localDx = dx * cos - dz * sin;
  const localDy = dy;
  const localDz = dx * sin + dz * cos;

  const halfX = box.size[0] * 0.5;
  const halfY = box.size[1] * 0.5;
  const halfZ = box.size[2] * 0.5;

  let tMin = 0.001;
  let tMax = 0.999;

  const axes: Array<[number, number, number]> = [
    [localOx, localDx, halfX],
    [localOy, localDy, halfY],
    [localOz, localDz, halfZ],
  ];

  for (const [o, d, half] of axes) {
    if (Math.abs(d) < 1e-8) {
      if (o < -half || o > half) return false;
    } else {
      const invD = 1 / d;
      let t1 = (-half - o) * invD;
      let t2 = (half - o) * invD;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) return false;
    }
  }

  return tMax >= tMin;
}

function isSampleInsideSquare90Frustum(
  eye: Vec3,
  forward: Vec3,
  yawDeg: number,
  sample: Vec3,
): boolean {
  const vx = sample[0] - eye[0];
  const vy = sample[1] - eye[1];
  const vz = sample[2] - eye[2];

  const right = yawDegToRightVector(yawDeg);
  const depth = vx * forward[0] + vy * forward[1] + vz * forward[2];
  if (depth <= 0.05 || depth > 50.0) return false;

  const horiz = vx * right[0] + vz * right[2];
  const vert = vy;

  return Math.abs(horiz) <= depth && Math.abs(vert) <= depth;
}

export function collectWorldVisibilityBlockers(
  snapshot: SceneSnapshot,
): WorldBoxProxy[] {
  const blockers: WorldBoxProxy[] = [];

  for (const obj of snapshot.objects) {
    const [ox, oy, oz] = obj.transform.position;
    const objYaw = obj.transform.yawDeg;
    const rad = objYaw * DEG_TO_RAD;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    for (const proxy of obj.proxies) {
      if (!proxy.blocksVisibility) continue;
      const [lx, ly, lz] = proxy.localPosition;
      const wx = ox + (lx * cos - lz * sin);
      const wy = oy + ly;
      const wz = oz + (lx * sin + lz * cos);

      const size: Vec3 =
        proxy.kind === 'cylinder'
          ? [
              (proxy.radiusM ?? 0.25) * 2,
              proxy.heightM ?? 1.0,
              (proxy.radiusM ?? 0.25) * 2,
            ]
          : (proxy.size ?? [0.5, 0.5, 0.5]);

      blockers.push({
        id: proxy.id,
        ownerObjectId: obj.id,
        centerWorld: [wx, wy, wz],
        size,
        yawDeg: objYaw + proxy.localYawDeg,
      });
    }
  }

  for (const member of snapshot.roster) {
    try {
      blockers.push(getAttendeeTorsoProxyWorldBox(snapshot, member.attendeeId));
    } catch {
      // Ignore invalid assignment during structural error handling
    }
  }

  return blockers;
}

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
  const ownObjectId = place?.objectId;
  const obj = snapshot.objects.find((o) => o.id === ownObjectId);
  const yawDeg = obj?.transform.yawDeg ?? 0;

  const pose = getAttendeeCameraPose(snapshot, attendeeId);
  const forward = yawDegToForwardVector(yawDeg);
  const allBlockers = collectWorldVisibilityBlockers(snapshot).filter(
    (b) =>
      b.ownerAttendeeId !== attendeeId &&
      (ownObjectId === undefined || b.ownerObjectId !== ownObjectId),
  );

  const blockerHitCounts = new Map<string, number>();
  const visibleMask: boolean[] = [];

  for (const pt of samplePoints) {
    if (
      !isSampleInsideSquare90Frustum(pose.eyePositionWorld, forward, yawDeg, pt)
    ) {
      visibleMask.push(false);
      continue;
    }

    let blocked = false;
    for (const blocker of allBlockers) {
      if (raySegmentIntersectsOrientedBox(pose.eyePositionWorld, pt, blocker)) {
        blocked = true;
        const key = blocker.ownerObjectId ?? blocker.id;
        blockerHitCounts.set(key, (blockerHitCounts.get(key) ?? 0) + 1);
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
