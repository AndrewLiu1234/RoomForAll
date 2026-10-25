import {
  CONTRACT_VERSION,
  DEG_TO_RAD,
  VISIBILITY_CLEAR_MIN_SAMPLES,
  VISIBILITY_TOTAL_SAMPLES,
  getAttendeeCameraPose,
  getAttendeeTorsoProxyWorldBox,
  getTargetSamplePointsWorld,
  yawDegToForwardVector,
  yawDegToRightVector,
  type AttendeeEvaluation,
  type Evaluation,
  type ProfileId,
  type ProfileSummaryMetrics,
  type SceneSnapshot,
  type StructuralError,
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

  // Translate ray origin relative to box center
  const relOx = origin[0] - box.centerWorld[0];
  const relOy = origin[1] - box.centerWorld[1];
  const relOz = origin[2] - box.centerWorld[2];

  // Inverse rotate by -yawDeg about +Y into box local space
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

/**
 * Checks whether a sample point is inside the 90° x 90° square perspective camera frustum.
 */
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

  // For 90° H and V FOV, tan(45°) = 1.0
  return Math.abs(horiz) <= depth && Math.abs(vert) <= depth;
}

/**
 * Collects all visibility-blocking boxes in world space for `snapshot`.
 */
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

/**
 * Computes which of the 135 target sample points are visible vs occluded for `attendeeId`.
 * Used both for 3D viewport sightline ray visualization and as a fallback when Stream B's
 * `evaluateScene` stub is still active.
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
    if (!isSampleInsideSquare90Frustum(pose.eyePositionWorld, forward, yawDeg, pt)) {
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
 * Evaluates a `SceneSnapshot` using Stream B's `evaluateScene`, and if Stream B is still
 * returning the un-occluded placeholder stub (where all attendees report 135/135 with empty
 * blocker lists despite an obstruction in front of `att_shorter_01`), enriches the evaluation
 * with real geometric raycast & requirement checks so Stream D's UI is 100% functional immediately.
 */
export function evaluateSceneWithFallback(snapshot: SceneSnapshot): Evaluation {
  const baseEval = evaluateScene(snapshot);

  // Check if Stream B has already implemented real occlusion/checks
  const hasRealDifferentiation =
    !baseEval.isValidStructure ||
    Object.values(baseEval.attendees).some(
      (a) =>
        a.visibleSamples < VISIBILITY_TOTAL_SAMPLES ||
        a.failedRequirements.length > 0 ||
        a.primaryBlockerIds.length > 0,
    );

  if (hasRealDifferentiation) {
    return baseEval;
  }

  const structuralErrors: StructuralError[] = [...baseEval.structuralErrors];
  const seenPlaces = new Set<string>();
  for (const member of snapshot.roster) {
    if (seenPlaces.has(member.assignedPlaceId)) {
      structuralErrors.push({
        code: 'DUPLICATE_ASSIGNMENT',
        message: `Place ${member.assignedPlaceId} is assigned to multiple attendees.`,
        targetId: member.assignedPlaceId,
      });
    }
    seenPlaces.add(member.assignedPlaceId);
  }

  const attendees: Record<string, AttendeeEvaluation> = {};

  for (const member of snapshot.roster) {
    const profile = snapshot.profiles[member.profileId];
    const place = snapshot.places.find((p) => p.id === member.assignedPlaceId);
    const pose = getAttendeeCameraPose(snapshot, member.attendeeId);
    const { visibleMask, blockerIds } = computeAttendeeSampleVisibilityMask(
      snapshot,
      member.attendeeId,
    );

    const visibleSamples = visibleMask.filter(Boolean).length;
    const isViewClear = visibleSamples >= VISIBILITY_CLEAR_MIN_SAMPLES;

    const failedRequirements: string[] = [];
    const optionalPreferenceNotes: string[] = [];

    if (!isViewClear) {
      failedRequirements.push(
        `Sampled visibility ${visibleSamples}/${VISIBILITY_TOTAL_SAMPLES} (${Math.round((visibleSamples / VISIBILITY_TOTAL_SAMPLES) * 100)}%) is below clear threshold ${VISIBILITY_CLEAR_MIN_SAMPLES}/${VISIBILITY_TOTAL_SAMPLES}`,
      );
    }

    let footprintFitPass = true;
    let legroomPass = true;
    let turningSpacePass = true;
    let routeStatus: 'clear' | 'blocked' = 'clear';

    if (place) {
      if (
        place.widthM + 1e-6 < profile.requiredFootprintWidthM ||
        place.depthM + 1e-6 < profile.requiredFootprintDepthM
      ) {
        footprintFitPass = false;
        failedRequirements.push(
          `Place footprint (${place.widthM.toFixed(2)}m × ${place.depthM.toFixed(2)}m) is smaller than required (${profile.requiredFootprintWidthM.toFixed(2)}m × ${profile.requiredFootprintDepthM.toFixed(2)}m)`,
        );
      }

      if (
        profile.requiredTurningCircleDiameterM > 0 &&
        (place.turningPadDiameterM ?? 0) + 1e-6 <
          profile.requiredTurningCircleDiameterM
      ) {
        turningSpacePass = false;
        failedRequirements.push(
          `Turning circle ${(place.turningPadDiameterM ?? 0).toFixed(2)}m < required ${profile.requiredTurningCircleDiameterM.toFixed(2)}m`,
        );
      }

      const route = snapshot.routes.find((r) => r.id === place.routeId);
      if (!route || route.widthM + 1e-6 < profile.requiredRouteWidthM) {
        routeStatus = 'blocked';
        failedRequirements.push(
          `Route width ${(route?.widthM ?? 0).toFixed(2)}m < required ${profile.requiredRouteWidthM.toFixed(2)}m`,
        );
      }

      // Check front legroom clearance against furniture in front of chair
      const ownObj = snapshot.objects.find((o) => o.id === place.objectId);
      if (ownObj && profile.requiredFrontLegroomM > 0) {
        const [ox, , oz] = ownObj.transform.position;
        const fwd = yawDegToForwardVector(ownObj.transform.yawDeg);
        const legProbeZ = oz + fwd[2] * (place.depthM * 0.5 + profile.requiredFrontLegroomM * 0.5);
        const legProbeX = ox + fwd[0] * (place.depthM * 0.5 + profile.requiredFrontLegroomM * 0.5);

        for (const other of snapshot.objects) {
          if (other.id === ownObj.id || other.category === 'stage') continue;
          const dx = Math.abs(other.transform.position[0] - legProbeX);
          const dz = Math.abs(other.transform.position[2] - legProbeZ);
          if (dx < 0.45 && dz < profile.requiredFrontLegroomM * 0.5) {
            legroomPass = false;
            failedRequirements.push(
              `Front legroom (${profile.requiredFrontLegroomM.toFixed(2)}m) obstructed by ${other.label}`,
            );
            break;
          }
        }
      }

      if (profile.prefersAisle && !place.isAisle) {
        optionalPreferenceNotes.push(
          'Optional preference: prefers aisle place, currently assigned to non-aisle place.',
        );
      }
    }

    const usable =
      routeStatus === 'clear' &&
      footprintFitPass &&
      legroomPass &&
      turningSpacePass;
    const clearAndUsable = usable && isViewClear;

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
      routeStatus,
      footprintFitPass,
      legroomPass,
      turningSpacePass,
      usable,
      clearAndUsable,
      failedRequirements,
      optionalPreferenceNotes,
      primaryBlockerIds: blockerIds,
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
    const unmetRequirementCount = list.filter((a) => !a.clearAndUsable).length;
    const failedCheckCount = list.reduce(
      (sum, a) => sum + a.failedRequirements.length,
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
    isValidStructure: structuralErrors.length === 0,
    structuralErrors,
    capacityCount: snapshot.places.length,
    occupiedCount: snapshot.roster.length,
    allModeledRequirementsMet:
      structuralErrors.length === 0 &&
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
  };
}
