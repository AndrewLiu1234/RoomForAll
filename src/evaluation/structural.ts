import {
  NUMERIC_EPSILON,
  type AABB2D,
  type SceneObject,
  type SceneSnapshot,
  type StructuralError,
  type Transform3D,
} from '../shared/index.js';
import {
  aabb2DToOBB2D,
  getPlaceFootprintOBB2D,
  isPointInAABB2D,
  isShape2DInsideAABB2D,
  isShape2DInsideRegionUnion,
  isShapeInsideRoomBounds,
  proxyToWorldCollider,
  shapes2DOverlap,
  type Shape2D,
  type WorldCollider,
} from './geometry.js';

function isFiniteVec2(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1])
  );
}

function isFiniteVec3(v: unknown): v is [number, number, number] {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    typeof v[2] === 'number' &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1]) &&
    Number.isFinite(v[2])
  );
}

function isValidTransform3D(t: Transform3D | undefined): boolean {
  if (!t) return false;
  return isFiniteVec3(t.position) && typeof t.yawDeg === 'number' && Number.isFinite(t.yawDeg);
}

function isValidAABB2D(b: AABB2D | undefined): boolean {
  if (!b) return false;
  return (
    Number.isFinite(b.minX) &&
    Number.isFinite(b.maxX) &&
    Number.isFinite(b.minZ) &&
    Number.isFinite(b.maxZ) &&
    b.maxX > b.minX &&
    b.maxZ > b.minZ
  );
}

/**
 * Validates the structural integrity of a `SceneSnapshot` per PRD §6 and Workstream B §3A.
 * Strictly separates structural invalidity (`isValidStructure = false`) from auditable
 * accessibility/comfort/sightline problems.
 */
export function validateSceneStructure(
  snapshot: SceneSnapshot,
): StructuralError[] {
  const errors: StructuralError[] = [];

  if (
    !snapshot ||
    !Array.isArray(snapshot.allowedFloorRegions) ||
    !Array.isArray(snapshot.reservedCirculationRegions) ||
    !Array.isArray(snapshot.objects) ||
    !Array.isArray(snapshot.chairGroups) ||
    !Array.isArray(snapshot.places) ||
    !Array.isArray(snapshot.routes) ||
    !Array.isArray(snapshot.roster) ||
    !snapshot.profiles ||
    typeof snapshot.profiles !== 'object'
  ) {
    errors.push({
      code: 'MALFORMED_GEOMETRY',
      message: 'SceneSnapshot is missing required top-level collections.',
    });
    return errors;
  }

  // 1. Validate roomBounds, allowedFloorRegions, reservedCirculationRegions, target
  const rb = snapshot.roomBounds;
  if (
    !rb ||
    !isFiniteVec3(rb.min) ||
    !isFiniteVec3(rb.max) ||
    rb.max[0] <= rb.min[0] ||
    rb.max[1] <= rb.min[1] ||
    rb.max[2] <= rb.min[2]
  ) {
    errors.push({
      code: 'MALFORMED_GEOMETRY',
      message: 'roomBounds contains non-finite numbers or non-positive dimensions.',
    });
  }

  for (const [idx, region] of snapshot.allowedFloorRegions.entries()) {
    if (!isValidAABB2D(region)) {
      errors.push({
        code: 'MALFORMED_GEOMETRY',
        message: `allowedFloorRegions[${idx}] has invalid or non-positive bounds.`,
      });
    }
  }

  for (const [idx, region] of snapshot.reservedCirculationRegions.entries()) {
    if (!isValidAABB2D(region)) {
      errors.push({
        code: 'MALFORMED_GEOMETRY',
        message: `reservedCirculationRegions[${idx}] has invalid or non-positive bounds.`,
      });
    }
  }

  const target = snapshot.target;
  if (
    !target ||
    !isFiniteVec3(target.center) ||
    !Number.isFinite(target.yawDeg) ||
    !Number.isFinite(target.widthM) ||
    !Number.isFinite(target.heightM) ||
    target.widthM <= 0 ||
    target.heightM <= 0
  ) {
    errors.push({
      code: 'MALFORMED_GEOMETRY',
      message: `Presentation target ${target?.id ?? 'unknown'} has invalid or zero/negative dimensions.`,
      targetId: target?.id,
    });
  }

  // 2. Build lookup maps and validate objects, groups, places, routes, profiles, roster
  const objectMap = new Map<string, SceneObject>();
  for (const obj of snapshot.objects) {
    objectMap.set(obj.id, obj);
    if (!isValidTransform3D(obj.transform) || !isValidTransform3D(obj.baselineTransform)) {
      errors.push({
        code: 'MALFORMED_GEOMETRY',
        message: `SceneObject ${obj.id} has non-finite transform or baselineTransform.`,
        targetId: obj.id,
      });
    }
    if (obj.allowedBounds && !isValidAABB2D(obj.allowedBounds)) {
      errors.push({
        code: 'MALFORMED_GEOMETRY',
        message: `SceneObject ${obj.id} has malformed allowedBounds.`,
        targetId: obj.id,
      });
    }
    for (const proxy of obj.proxies) {
      if (
        !isFiniteVec3(proxy.localPosition) ||
        !Number.isFinite(proxy.localYawDeg)
      ) {
        errors.push({
          code: 'MALFORMED_GEOMETRY',
          message: `Proxy ${proxy.id} on ${obj.id} has non-finite local transform.`,
          targetId: obj.id,
        });
      }
      if (proxy.kind === 'box') {
        if (
          !isFiniteVec3(proxy.size) ||
          proxy.size[0] <= 0 ||
          proxy.size[1] <= 0 ||
          proxy.size[2] <= 0
        ) {
          errors.push({
            code: 'MALFORMED_GEOMETRY',
            message: `Box proxy ${proxy.id} on ${obj.id} has missing or non-positive size.`,
            targetId: obj.id,
          });
        }
      } else if (proxy.kind === 'cylinder') {
        if (
          proxy.radiusM === undefined ||
          proxy.heightM === undefined ||
          !Number.isFinite(proxy.radiusM) ||
          !Number.isFinite(proxy.heightM) ||
          proxy.radiusM <= 0 ||
          proxy.heightM <= 0
        ) {
          errors.push({
            code: 'MALFORMED_GEOMETRY',
            message: `Cylinder proxy ${proxy.id} on ${obj.id} has missing or non-positive radiusM/heightM.`,
            targetId: obj.id,
          });
        }
      } else {
        errors.push({
          code: 'MALFORMED_GEOMETRY',
          message: `Proxy ${proxy.id} on ${obj.id} has unknown kind.`,
          targetId: obj.id,
        });
      }
    }
  }

  const groupMap = new Map(snapshot.chairGroups.map((g) => [g.id, g]));
  for (const group of snapshot.chairGroups) {
    if (
      !isValidTransform3D(group.transform) ||
      !isValidTransform3D(group.baselineTransform)
    ) {
      errors.push({
        code: 'MALFORMED_GEOMETRY',
        message: `ChairGroup ${group.id} has non-finite transform or baselineTransform.`,
        targetId: group.id,
      });
    }
    if (group.allowedBounds && !isValidAABB2D(group.allowedBounds)) {
      errors.push({
        code: 'MALFORMED_GEOMETRY',
        message: `ChairGroup ${group.id} has malformed allowedBounds.`,
        targetId: group.id,
      });
    }
    for (const memberId of group.memberObjectIds) {
      if (!objectMap.has(memberId)) {
        errors.push({
          code: 'MISSING_REFERENCE',
          message: `ChairGroup ${group.id} references missing memberObjectId ${memberId}.`,
          targetId: group.id,
        });
      }
    }
  }

  for (const obj of snapshot.objects) {
    if (obj.groupId && !groupMap.has(obj.groupId)) {
      errors.push({
        code: 'MISSING_REFERENCE',
        message: `SceneObject ${obj.id} references missing ChairGroup ${obj.groupId}.`,
        targetId: obj.id,
      });
    }
  }

  const routeMap = new Map(snapshot.routes.map((r) => [r.id, r]));
  for (const route of snapshot.routes) {
    if (
      !Number.isFinite(route.widthM) ||
      route.widthM <= 0 ||
      !Array.isArray(route.waypoints) ||
      route.waypoints.length < 2 ||
      !route.waypoints.every((wp) => isFiniteVec2(wp))
    ) {
      errors.push({
        code: 'MALFORMED_GEOMETRY',
        message: `RouteCorridor ${route.id} has invalid widthM or waypoints.`,
        targetId: route.id,
      });
    }
  }

  const placeMap = new Map(snapshot.places.map((p) => [p.id, p]));
  const placeByObjectId = new Map(snapshot.places.map((p) => [p.objectId, p]));

  for (const place of snapshot.places) {
    if (
      !Number.isFinite(place.seatHeightM) ||
      place.seatHeightM < 0 ||
      !Number.isFinite(place.widthM) ||
      place.widthM <= 0 ||
      !Number.isFinite(place.depthM) ||
      place.depthM <= 0 ||
      !isFiniteVec2(place.routeAnchorPoint) ||
      (place.turningPadCenter !== undefined &&
        !isFiniteVec2(place.turningPadCenter)) ||
      (place.turningPadDiameterM !== undefined &&
        (!Number.isFinite(place.turningPadDiameterM) ||
          place.turningPadDiameterM < 0))
    ) {
      errors.push({
        code: 'MALFORMED_GEOMETRY',
        message: `AudiencePlace ${place.id} has invalid dimensions or anchor coordinates.`,
        targetId: place.id,
      });
    }
    if (!objectMap.has(place.objectId)) {
      errors.push({
        code: 'MISSING_REFERENCE',
        message: `AudiencePlace ${place.id} references missing SceneObject ${place.objectId}.`,
        targetId: place.id,
      });
    }
    if (!routeMap.has(place.routeId)) {
      errors.push({
        code: 'MISSING_REFERENCE',
        message: `AudiencePlace ${place.id} references missing RouteCorridor ${place.routeId}.`,
        targetId: place.id,
      });
    }
  }

  // Validate profile numbers
  for (const [pid, prof] of Object.entries(snapshot.profiles)) {
    const validEyeHeight =
      prof?.eyeHeightMode === 'independent'
        ? typeof prof.independentEyeHeightM === 'number' &&
          Number.isFinite(prof.independentEyeHeightM) &&
          prof.independentEyeHeightM > 0
        : prof?.eyeHeightMode === 'seat_offset'
          ? typeof prof.eyeOffsetAboveSeatM === 'number' &&
            Number.isFinite(prof.eyeOffsetAboveSeatM) &&
            prof.eyeOffsetAboveSeatM > 0
          : false;

    if (
      !prof ||
      !validEyeHeight ||
      !Number.isFinite(prof.requiredFootprintWidthM) ||
      prof.requiredFootprintWidthM <= 0 ||
      !Number.isFinite(prof.requiredFootprintDepthM) ||
      prof.requiredFootprintDepthM <= 0 ||
      !Number.isFinite(prof.requiredFrontLegroomM) ||
      prof.requiredFrontLegroomM < 0 ||
      !Number.isFinite(prof.requiredRouteWidthM) ||
      prof.requiredRouteWidthM <= 0 ||
      !Number.isFinite(prof.requiredTurningCircleDiameterM) ||
      prof.requiredTurningCircleDiameterM < 0 ||
      !Number.isFinite(prof.torsoProxyHeightM) ||
      prof.torsoProxyHeightM <= 0 ||
      !Number.isFinite(prof.torsoProxyWidthM) ||
      prof.torsoProxyWidthM <= 0 ||
      !Number.isFinite(prof.torsoProxyDepthM) ||
      prof.torsoProxyDepthM <= 0
    ) {
      errors.push({
        code: 'MALFORMED_GEOMETRY',
        message: `ProfileRequirements ${pid} contains invalid or non-positive dimensions.`,
        targetId: pid,
      });
    }
  }

  // 3. Roster references, duplicate assignments, and place compatibility
  const assignedPlaces = new Set<string>();
  const seenAttendeeIds = new Set<string>();
  for (const member of snapshot.roster) {
    if (seenAttendeeIds.has(member.attendeeId)) {
      errors.push({
        code: 'DUPLICATE_ASSIGNMENT',
        message: `Duplicate attendeeId ${member.attendeeId} in roster.`,
        targetId: member.attendeeId,
      });
    }
    seenAttendeeIds.add(member.attendeeId);

    const profile = snapshot.profiles[member.profileId];
    if (!profile) {
      errors.push({
        code: 'MISSING_REFERENCE',
        message: `Attendee ${member.attendeeId} references missing profileId ${String(member.profileId)}.`,
        targetId: member.attendeeId,
      });
    }

    const place = placeMap.get(member.assignedPlaceId);
    if (!place) {
      errors.push({
        code: 'MISSING_REFERENCE',
        message: `Attendee ${member.attendeeId} references missing assignedPlaceId ${member.assignedPlaceId}.`,
        targetId: member.attendeeId,
      });
    }

    if (assignedPlaces.has(member.assignedPlaceId)) {
      errors.push({
        code: 'DUPLICATE_ASSIGNMENT',
        message: `Multiple attendees are assigned to place ${member.assignedPlaceId}.`,
        targetId: member.assignedPlaceId,
      });
    }
    assignedPlaces.add(member.assignedPlaceId);

    if (
      profile &&
      place &&
      !profile.compatiblePlaceKinds.includes(place.kind)
    ) {
      errors.push({
        code: 'INCOMPATIBLE_PLACE',
        message: `Attendee ${member.attendeeId} (profile ${profile.id}) is incompatible with place ${place.id} of kind ${place.kind}.`,
        targetId: member.attendeeId,
      });
    }
  }

  // If geometry is fundamentally malformed, skip spatial collision/bounds checks to avoid NaN propagation
  if (errors.some((e) => e.code === 'MALFORMED_GEOMETRY')) {
    return errors;
  }

  // 4. Bounds checks (OUT_OF_BOUNDS) & Reserved Circulation Intrusion (RESERVED_CIRCULATION_INTRUSION)
  // Collect all colliders per object for subsequent OBJECT_COLLISION check as well.
  const objectColliders = new Map<string, WorldCollider[]>();

  for (const obj of snapshot.objects) {
    const place = placeByObjectId.get(obj.id);
    const shapesToCheck: Array<{ shape2D: Shape2D; minY: number; maxY: number }> = [];
    const collidersForObj: WorldCollider[] = [];

    if (place) {
      const footprintOBB = getPlaceFootprintOBB2D(place, obj);
      const placeMinY = obj.transform.position[1];
      const placeMaxY = obj.transform.position[1] + Math.max(place.seatHeightM, 0.9);
      const shape2D: Shape2D = { kind: 'obb', obb: footprintOBB };
      shapesToCheck.push({ shape2D, minY: placeMinY, maxY: placeMaxY });
      collidersForObj.push({
        id: `place_footprint_${place.id}`,
        ownerObjectId: obj.id,
        ownerCategory: obj.category,
        ownerPlaceId: place.id,
        shape2D,
        minY: placeMinY,
        maxY: placeMaxY,
      });
    }

    for (const proxy of obj.proxies) {
      const wc = proxyToWorldCollider(obj, proxy, place?.id);
      if (!wc) continue;
      shapesToCheck.push({ shape2D: wc.shape2D, minY: wc.minY, maxY: wc.maxY });
      if (proxy.blocksMovement) {
        collidersForObj.push(wc);
      }
    }

    if (shapesToCheck.length === 0) {
      const pt = obj.transform.position;
      const pointShape: Shape2D = {
        kind: 'obb',
        obb: {
          center: [pt[0], pt[2]],
          widthM: 0.02,
          depthM: 0.02,
          yawDeg: obj.transform.yawDeg,
        },
      };
      shapesToCheck.push({ shape2D: pointShape, minY: pt[1], maxY: pt[1] + 0.1 });
    }

    objectColliders.set(obj.id, collidersForObj);

    const isAudienceOrMovable =
      obj.editable ||
      obj.category === 'movable_chair' ||
      obj.category === 'movable_prop' ||
      obj.category === 'wheelchair_bay_frame' ||
      place !== undefined;

    // Collect group allowedBounds if object belongs to a ChairGroup
    const parentGroups = snapshot.chairGroups.filter(
      (g) => g.id === obj.groupId || g.memberObjectIds.includes(obj.id),
    );

    let outOfBoundsReported = false;
    for (const item of shapesToCheck) {
      if (outOfBoundsReported) break;

      // 4a. Check roomBounds for all objects
      if (
        !isShapeInsideRoomBounds(
          item.shape2D,
          item.minY,
          item.maxY,
          snapshot.roomBounds,
          NUMERIC_EPSILON,
        )
      ) {
        errors.push({
          code: 'OUT_OF_BOUNDS',
          message: `Object ${obj.id} lies outside roomBounds.`,
          targetId: obj.id,
        });
        outOfBoundsReported = true;
        break;
      }

      // 4b. Check allowedFloorRegions for audience places and movable objects
      if (
        isAudienceOrMovable &&
        snapshot.allowedFloorRegions.length > 0 &&
        !isShape2DInsideRegionUnion(
          item.shape2D,
          snapshot.allowedFloorRegions,
          NUMERIC_EPSILON,
        )
      ) {
        errors.push({
          code: 'OUT_OF_BOUNDS',
          message: `Object ${obj.id} footprint lies outside allowedFloorRegions.`,
          targetId: obj.id,
        });
        outOfBoundsReported = true;
        break;
      }

      // 4c. Check per-object allowedBounds
      if (
        obj.allowedBounds &&
        !isShape2DInsideAABB2D(item.shape2D, obj.allowedBounds, NUMERIC_EPSILON)
      ) {
        errors.push({
          code: 'OUT_OF_BOUNDS',
          message: `Object ${obj.id} lies outside its allowedBounds.`,
          targetId: obj.id,
        });
        outOfBoundsReported = true;
        break;
      }

      // 4d. Check ChairGroup allowedBounds
      for (const grp of parentGroups) {
        if (
          grp.allowedBounds &&
          !isShape2DInsideAABB2D(item.shape2D, grp.allowedBounds, NUMERIC_EPSILON)
        ) {
          errors.push({
            code: 'OUT_OF_BOUNDS',
            message: `Object ${obj.id} lies outside ChairGroup ${grp.id} allowedBounds.`,
            targetId: obj.id,
          });
          outOfBoundsReported = true;
          break;
        }
      }
    }

    // 4e. Reserved circulation intrusion check for chairs and movable props
    const checksCirculation =
      obj.editable ||
      obj.category === 'movable_chair' ||
      obj.category === 'movable_prop';
    if (checksCirculation && snapshot.reservedCirculationRegions.length > 0) {
      let intruded = false;
      for (const item of shapesToCheck) {
        if (intruded) break;
        for (const region of snapshot.reservedCirculationRegions) {
          const regionShape: Shape2D = {
            kind: 'obb',
            obb: aabb2DToOBB2D(region),
          };
          if (shapes2DOverlap(item.shape2D, regionShape, NUMERIC_EPSILON)) {
            errors.push({
              code: 'RESERVED_CIRCULATION_INTRUSION',
              message: `Object ${obj.id} intrudes into a reserved circulation region.`,
              targetId: obj.id,
            });
            intruded = true;
            break;
          }
        }
      }
    }
  }

  // Also check ChairGroup transform position against group.allowedBounds if set
  for (const grp of snapshot.chairGroups) {
    if (grp.allowedBounds) {
      const pt: [number, number] = [
        grp.transform.position[0],
        grp.transform.position[2],
      ];
      if (!isPointInAABB2D(pt, grp.allowedBounds, NUMERIC_EPSILON)) {
        errors.push({
          code: 'OUT_OF_BOUNDS',
          message: `ChairGroup ${grp.id} transform position lies outside its allowedBounds.`,
          targetId: grp.id,
        });
      }
    }
  }

  // 5. Object Collision Check (OBJECT_COLLISION)
  // Check pairwise collisions between distinct objects (excluding fixed_structure/stage pairs).
  const objects = snapshot.objects;
  for (let i = 0; i < objects.length; i++) {
    const objA = objects[i]!;
    const collidersA = objectColliders.get(objA.id) ?? [];
    if (collidersA.length === 0) continue;

    for (let j = i + 1; j < objects.length; j++) {
      const objB = objects[j]!;
      const collidersB = objectColliders.get(objB.id) ?? [];
      if (collidersB.length === 0) continue;

      const bothFixedNonPlace =
        (objA.category === 'fixed_structure' || objA.category === 'stage') &&
        (objB.category === 'fixed_structure' || objB.category === 'stage') &&
        !placeByObjectId.has(objA.id) &&
        !placeByObjectId.has(objB.id);
      if (bothFixedNonPlace) continue;

      let pairCollided = false;
      for (const colA of collidersA) {
        if (pairCollided) break;
        for (const colB of collidersB) {
          // Check vertical 3D overlap
          const yOverlaps =
            colA.maxY > colB.minY + NUMERIC_EPSILON &&
            colB.maxY > colA.minY + NUMERIC_EPSILON;
          if (!yOverlaps) continue;

          if (shapes2DOverlap(colA.shape2D, colB.shape2D, NUMERIC_EPSILON)) {
            const targetId = objA.editable ? objA.id : objB.id;
            errors.push({
              code: 'OBJECT_COLLISION',
              message: `Collision detected between ${objA.id} and ${objB.id}.`,
              targetId,
            });
            pairCollided = true;
            break;
          }
        }
      }
    }
  }

  return errors;
}
