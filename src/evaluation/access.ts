import {
  NUMERIC_EPSILON,
  type AudiencePlace,
  type ProfileRequirements,
  type SceneObject,
  type SceneSnapshot,
  type Vec2,
} from '../shared/index.js';
import {
  closestPointOnSegment2D,
  computeApproachEndpointOutsideFootprint,
  createSegmentCorridorOBB2D,
  getPlaceFootprintOBB2D,
  getPlaceFrontLegroomOBB2D,
  isShapeInsideRoomBounds,
  proxyToWorldCollider,
  shapes2DOverlap,
  type Shape2D,
  type WorldCollider,
} from './geometry.js';

export interface AccessCheckResult {
  routeStatus: 'clear' | 'blocked';
  footprintFitPass: boolean;
  legroomPass: boolean;
  turningSpacePass: boolean;
  usable: boolean;
  failedAccessRequirements: string[];
  optionalPreferenceNotes: string[];
}

export interface PlaceFootprintEntry {
  place: AudiencePlace;
  obj: SceneObject;
  shape2D: Shape2D;
  isOccupied: boolean;
}

/**
 * Precomputes movement blockers (`blocksMovement: true` proxies) and place footprints
 * across the snapshot for fast deterministic access/route/clearance checks.
 */
export function buildSceneAccessContext(snapshot: SceneSnapshot): {
  movementBlockers: WorldCollider[];
  placeFootprints: PlaceFootprintEntry[];
  occupiedPlaceIds: Set<string>;
} {
  const occupiedPlaceIds = new Set(
    snapshot.roster.map((r) => r.assignedPlaceId),
  );
  const placeByObjectId = new Map(snapshot.places.map((p) => [p.objectId, p]));
  const objectMap = new Map(snapshot.objects.map((o) => [o.id, o]));

  const movementBlockers: WorldCollider[] = [];
  for (const obj of snapshot.objects) {
    const ownerPlace = placeByObjectId.get(obj.id);
    for (const proxy of obj.proxies) {
      if (!proxy.blocksMovement) continue;
      const wc = proxyToWorldCollider(obj, proxy, ownerPlace?.id);
      if (wc) {
        movementBlockers.push(wc);
      }
    }
  }

  const placeFootprints: PlaceFootprintEntry[] = [];
  for (const place of snapshot.places) {
    const obj = objectMap.get(place.objectId);
    if (!obj) continue;
    placeFootprints.push({
      place,
      obj,
      shape2D: {
        kind: 'obb',
        obb: getPlaceFootprintOBB2D(place, obj),
      },
      isOccupied: occupiedPlaceIds.has(place.id),
    });
  }

  return {
    movementBlockers,
    placeFootprints,
    occupiedPlaceIds,
  };
}

/**
 * Evaluates footprint fit, front legroom, turning space, and modeled route (corridor + dynamic
 * final approach with destination-only exemption) for an attendee (PRD §6 & Workstream B §3C).
 */
export function evaluateAttendeeAccess(
  snapshot: SceneSnapshot,
  place: AudiencePlace,
  obj: SceneObject,
  profile: ProfileRequirements,
  context: ReturnType<typeof buildSceneAccessContext> = buildSceneAccessContext(
    snapshot,
  ),
): AccessCheckResult {
  const { movementBlockers, placeFootprints } = context;

  // 1. Footprint Fit Check
  let footprintFitPass =
    place.widthM + NUMERIC_EPSILON >= profile.requiredFootprintWidthM &&
    place.depthM + NUMERIC_EPSILON >= profile.requiredFootprintDepthM;

  const requiredFootprintShape: Shape2D = {
    kind: 'obb',
    obb: getPlaceFootprintOBB2D(
      place,
      obj,
      Math.max(place.widthM, profile.requiredFootprintWidthM),
      Math.max(place.depthM, profile.requiredFootprintDepthM),
    ),
  };

  if (footprintFitPass) {
    const minY = obj.transform.position[1];
    const maxY = obj.transform.position[1] + Math.max(place.seatHeightM, 0.9);
    if (
      !isShapeInsideRoomBounds(
        requiredFootprintShape,
        minY,
        maxY,
        snapshot.roomBounds,
        NUMERIC_EPSILON,
      )
    ) {
      footprintFitPass = false;
    }

    if (footprintFitPass) {
      for (const blocker of movementBlockers) {
        if (blocker.ownerObjectId === obj.id) continue;
        if (
          blocker.maxY <= minY + NUMERIC_EPSILON ||
          maxY <= blocker.minY + NUMERIC_EPSILON
        ) {
          continue;
        }
        if (
          shapes2DOverlap(
            requiredFootprintShape,
            blocker.shape2D,
            NUMERIC_EPSILON,
          )
        ) {
          footprintFitPass = false;
          break;
        }
      }
    }

    if (footprintFitPass) {
      const isStandaloneGlb = snapshot.sceneId.startsWith('glb_standalone_');
      for (const other of placeFootprints) {
        if (other.place.id === place.id) continue;
        if (
          !other.isOccupied &&
          (other.place.kind === 'wheelchair_bay' || isStandaloneGlb)
        ) {
          continue;
        }
        if (
          shapes2DOverlap(
            requiredFootprintShape,
            other.shape2D,
            NUMERIC_EPSILON,
          )
        ) {
          footprintFitPass = false;
          break;
        }
      }
    }
  }

  // 2. Front Legroom Check
  let legroomPass = true;
  if (profile.requiredFrontLegroomM > NUMERIC_EPSILON) {
    const legroomOBB = getPlaceFrontLegroomOBB2D(
      place,
      obj,
      profile.requiredFootprintWidthM,
      profile.requiredFrontLegroomM,
    );
    const legroomShape: Shape2D = { kind: 'obb', obb: legroomOBB };
    const minY = obj.transform.position[1];
    const maxY = obj.transform.position[1] + 0.8;

    if (
      !isShapeInsideRoomBounds(
        legroomShape,
        minY,
        maxY,
        snapshot.roomBounds,
        NUMERIC_EPSILON,
      )
    ) {
      legroomPass = false;
    }

    if (legroomPass) {
      for (const blocker of movementBlockers) {
        if (blocker.ownerObjectId === obj.id) continue;
        if (
          blocker.maxY <= minY + NUMERIC_EPSILON ||
          maxY <= blocker.minY + NUMERIC_EPSILON
        ) {
          continue;
        }
        if (shapes2DOverlap(legroomShape, blocker.shape2D, NUMERIC_EPSILON)) {
          legroomPass = false;
          break;
        }
      }
    }

    if (legroomPass) {
      const isStandaloneGlb = snapshot.sceneId.startsWith('glb_standalone_');
      for (const other of placeFootprints) {
        if (other.place.id === place.id) continue;
        if (
          !other.isOccupied &&
          (other.place.kind === 'wheelchair_bay' || isStandaloneGlb)
        ) {
          continue;
        }
        if (shapes2DOverlap(legroomShape, other.shape2D, NUMERIC_EPSILON)) {
          legroomPass = false;
          break;
        }
      }
    }
  }

  // 3. Turning Space Check
  let turningSpacePass = true;
  if (profile.requiredTurningCircleDiameterM > NUMERIC_EPSILON) {
    if (
      !place.turningPadCenter ||
      place.turningPadDiameterM === undefined ||
      place.turningPadDiameterM + NUMERIC_EPSILON <
        profile.requiredTurningCircleDiameterM
    ) {
      turningSpacePass = false;
    } else {
      const turningShape: Shape2D = {
        kind: 'circle',
        circle: {
          center: place.turningPadCenter,
          radiusM: profile.requiredTurningCircleDiameterM * 0.5,
        },
      };
      const minY = obj.transform.position[1];
      const maxY = obj.transform.position[1] + 1.2;

      if (
        !isShapeInsideRoomBounds(
          turningShape,
          minY,
          maxY,
          snapshot.roomBounds,
          NUMERIC_EPSILON,
        )
      ) {
        turningSpacePass = false;
      }

      if (turningSpacePass) {
        for (const blocker of movementBlockers) {
          if (blocker.ownerObjectId === obj.id) continue;
          if (
            blocker.maxY <= minY + NUMERIC_EPSILON ||
            maxY <= blocker.minY + NUMERIC_EPSILON
          ) {
            continue;
          }
          if (shapes2DOverlap(turningShape, blocker.shape2D, NUMERIC_EPSILON)) {
            turningSpacePass = false;
            break;
          }
        }
      }

      if (turningSpacePass) {
        for (const other of placeFootprints) {
          if (other.place.id === place.id) continue;
          if (!other.isOccupied && other.place.kind === 'wheelchair_bay') {
            continue;
          }
          if (shapes2DOverlap(turningShape, other.shape2D, NUMERIC_EPSILON)) {
            turningSpacePass = false;
            break;
          }
        }
      }
    }
  }

  // 4. Modeled Route (Fixed Corridor + Dynamic Final-Approach Segment)
  let routePass = true;
  const corridor = snapshot.routes.find((r) => r.id === place.routeId);
  if (
    !corridor ||
    corridor.waypoints.length < 2 ||
    corridor.widthM + NUMERIC_EPSILON < profile.requiredRouteWidthM
  ) {
    routePass = false;
  } else {
    const reqWidth = profile.requiredRouteWidthM;
    const corridorSegments: Array<[Vec2, Vec2]> = [];

    const isStandaloneGlb = snapshot.sceneId.startsWith('glb_standalone_');
    let minAnchorDistSq = Infinity;
    let closestCorridorPoint: Vec2 = corridor.waypoints[0]!;

    if (!isStandaloneGlb) {
      for (let i = 0; i < corridor.waypoints.length - 1; i++) {
        const p0 = corridor.waypoints[i]!;
        const p1 = corridor.waypoints[i + 1]!;
        corridorSegments.push([p0, p1]);

        const cp = closestPointOnSegment2D(place.routeAnchorPoint, p0, p1);
        const dSq =
          (cp[0] - place.routeAnchorPoint[0]) ** 2 +
          (cp[1] - place.routeAnchorPoint[1]) ** 2;
        if (dSq < minAnchorDistSq) {
          minAnchorDistSq = dSq;
          closestCorridorPoint = cp;
        }
      }

      // If routeAnchorPoint is offset from the main corridor waypoints, include the connector segment
      if (minAnchorDistSq > NUMERIC_EPSILON * NUMERIC_EPSILON) {
        corridorSegments.push([closestCorridorPoint, place.routeAnchorPoint]);
      }
    }

    // Compute dynamic final-approach segment from routeAnchorPoint to the approach point
    // just outside the destination place's footprint at its current transform (PRD §6).
    const destFootprintOBB = getPlaceFootprintOBB2D(place, obj);
    const approachEndpoint = computeApproachEndpointOutsideFootprint(
      place.routeAnchorPoint,
      destFootprintOBB,
    );
    corridorSegments.push([place.routeAnchorPoint, approachEndpoint]);

    const minY = obj.transform.position[1];
    const maxY = obj.transform.position[1] + 1.5;

    for (const [segStart, segEnd] of corridorSegments) {
      if (!routePass) break;
      const segLen = Math.hypot(
        segEnd[0] - segStart[0],
        segEnd[1] - segStart[1],
      );
      if (segLen <= NUMERIC_EPSILON) continue;

      const sweepOBB = createSegmentCorridorOBB2D(segStart, segEnd, reqWidth);
      const sweepShape: Shape2D = { kind: 'obb', obb: sweepOBB };

      if (
        !isShapeInsideRoomBounds(
          sweepShape,
          minY,
          maxY,
          snapshot.roomBounds,
          NUMERIC_EPSILON,
        )
      ) {
        routePass = false;
        break;
      }

      // Check against all movement-blocking proxies except destination place's own objectId
      for (const blocker of movementBlockers) {
        if (blocker.ownerObjectId === obj.id) continue;
        if (
          blocker.maxY <= minY + NUMERIC_EPSILON ||
          maxY <= blocker.minY + NUMERIC_EPSILON
        ) {
          continue;
        }
        if (shapes2DOverlap(sweepShape, blocker.shape2D, NUMERIC_EPSILON)) {
          routePass = false;
          break;
        }
      }
      if (!routePass) break;

      // Check against other chairs and occupied wheelchair bays, exempting ONLY destination place.id
      const isStandaloneGlb = snapshot.sceneId.startsWith('glb_standalone_');
      for (const other of placeFootprints) {
        if (other.place.id === place.id) continue;
        if (
          !other.isOccupied &&
          (other.place.kind === 'wheelchair_bay' || isStandaloneGlb)
        ) {
          continue;
        }
        if (shapes2DOverlap(sweepShape, other.shape2D, NUMERIC_EPSILON)) {
          routePass = false;
          break;
        }
      }
    }
  }

  const routeStatus: 'clear' | 'blocked' = routePass ? 'clear' : 'blocked';
  const failedAccessRequirements: string[] = [];
  if (routeStatus === 'blocked') {
    failedAccessRequirements.push('accessible_route');
  }
  if (!footprintFitPass) {
    failedAccessRequirements.push('footprint_fit');
  }
  if (!legroomPass) {
    failedAccessRequirements.push('front_legroom');
  }
  if (!turningSpacePass) {
    failedAccessRequirements.push('turning_space');
  }

  const optionalPreferenceNotes: string[] = [];
  if (profile.prefersAisle && !place.isAisle) {
    optionalPreferenceNotes.push('prefers_aisle_unmet');
  }

  const usable =
    routeStatus === 'clear' &&
    footprintFitPass &&
    legroomPass &&
    turningSpacePass;

  return {
    routeStatus,
    footprintFitPass,
    legroomPass,
    turningSpacePass,
    usable,
    failedAccessRequirements,
    optionalPreferenceNotes,
  };
}
