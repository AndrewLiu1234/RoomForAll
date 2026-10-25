import {
  NUMERIC_EPSILON,
  yawDegToForwardVector,
  yawDegToRightVector,
  type AABB2D,
  type AABB3D,
  type AudiencePlace,
  type ProxyPrimitive,
  type SceneObject,
  type Vec2,
  type Vec3,
  type WorldBoxProxy,
} from '../shared/index.js';

export interface OBB2D {
  center: Vec2;
  /** Full width along right axis (+X at yaw=0) */
  widthM: number;
  /** Full depth along forward/back axis (Z at yaw=0) */
  depthM: number;
  yawDeg: number;
}

export interface Circle2D {
  center: Vec2;
  radiusM: number;
}

export type Shape2D =
  | { kind: 'obb'; obb: OBB2D }
  | { kind: 'circle'; circle: Circle2D };

export interface WorldCollider {
  id: string;
  ownerObjectId: string;
  ownerCategory: SceneObject['category'];
  ownerPlaceId?: string;
  shape2D: Shape2D;
  minY: number;
  maxY: number;
}

export interface WorldOccluder {
  id: string;
  blockerId: string;
  ownerObjectId: string;
  ownerAttendeeId?: string;
  kind: 'box' | 'cylinder';
  centerWorld: Vec3;
  yawDeg: number;
  /** For box: [widthX, heightY, depthZ] */
  size?: Vec3;
  /** For cylinder */
  radiusM?: number;
  heightM?: number;
}

/**
 * Computes the 2D right and backward (+Z at yaw=0) unit basis vectors for a yaw angle.
 * At yaw = 0°:
 * - right2D = [1, 0]
 * - back2D = [0, 1] (since forward = [0, 0, -1], local +Z is -forward)
 */
export function getBasis2D(yawDeg: number): { right: Vec2; back: Vec2 } {
  const r3 = yawDegToRightVector(yawDeg);
  const f3 = yawDegToForwardVector(yawDeg);
  return {
    right: [r3[0], r3[2]],
    back: [-f3[0], -f3[2]],
  };
}

/**
 * Transforms a local 3D offset [lx, ly, lz] relative to a parent Transform3D into world space.
 */
export function localToWorldPoint(
  parentPos: Vec3,
  parentYawDeg: number,
  localPos: Vec3,
): Vec3 {
  const right = yawDegToRightVector(parentYawDeg);
  const forward = yawDegToForwardVector(parentYawDeg);
  return [
    parentPos[0] + localPos[0] * right[0] - localPos[2] * forward[0],
    parentPos[1] + localPos[1],
    parentPos[2] + localPos[0] * right[2] - localPos[2] * forward[2],
  ];
}

/**
 * Returns the 4 world-space [x, z] corners of an OBB2D.
 */
export function getOBB2DCorners(obb: OBB2D): [Vec2, Vec2, Vec2, Vec2] {
  const { right, back } = getBasis2D(obb.yawDeg);
  const hx = obb.widthM * 0.5;
  const hz = obb.depthM * 0.5;
  const [cx, cz] = obb.center;

  const rx = right[0] * hx;
  const rz = right[1] * hx;
  const bx = back[0] * hz;
  const bz = back[1] * hz;

  return [
    [cx - rx - bx, cz - rz - bz],
    [cx + rx - bx, cz + rz - bz],
    [cx + rx + bx, cz + rz + bz],
    [cx - rx + bx, cz - rz + bz],
  ];
}

/**
 * Computes the axis-aligned bounding box of a Shape2D.
 */
export function getShape2DAABB(shape: Shape2D): AABB2D {
  if (shape.kind === 'circle') {
    const { center, radiusM } = shape.circle;
    return {
      minX: center[0] - radiusM,
      maxX: center[0] + radiusM,
      minZ: center[1] - radiusM,
      maxZ: center[1] + radiusM,
    };
  }
  const corners = getOBB2DCorners(shape.obb);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of corners) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

/**
 * Checks if a 2D point [x, z] lies inside an AABB2D (with epsilon tolerance).
 */
export function isPointInAABB2D(
  pt: Vec2,
  aabb: AABB2D,
  eps: number = NUMERIC_EPSILON,
): boolean {
  return (
    pt[0] >= aabb.minX - eps &&
    pt[0] <= aabb.maxX + eps &&
    pt[1] >= aabb.minZ - eps &&
    pt[1] <= aabb.maxZ + eps
  );
}

/**
 * Checks if a Shape2D is completely contained within a single AABB2D.
 */
export function isShape2DInsideAABB2D(
  shape: Shape2D,
  bounds: AABB2D,
  eps: number = NUMERIC_EPSILON,
): boolean {
  const aabb = getShape2DAABB(shape);
  return (
    aabb.minX >= bounds.minX - eps &&
    aabb.maxX <= bounds.maxX + eps &&
    aabb.minZ >= bounds.minZ - eps &&
    aabb.maxZ <= bounds.maxZ + eps
  );
}

/**
 * Checks if a Shape2D is completely contained within the union of `regions`.
 * Samples the boundary corners/extremes and a 3x3 interior grid so shapes spanning
 * adjacent allowed floor regions are also supported.
 */
export function isShape2DInsideRegionUnion(
  shape: Shape2D,
  regions: AABB2D[],
  eps: number = NUMERIC_EPSILON,
): boolean {
  if (regions.length === 0) return false;
  if (regions.some((r) => isShape2DInsideAABB2D(shape, r, eps))) {
    return true;
  }

  const testPoints: Vec2[] = [];
  if (shape.kind === 'circle') {
    const [cx, cz] = shape.circle.center;
    const r = shape.circle.radiusM;
    for (const frac of [0.25, 0.5, 0.75, 1.0]) {
      const rf = r * frac;
      const df = rf * Math.SQRT1_2;
      testPoints.push(
        [cx + rf, cz],
        [cx - rf, cz],
        [cx, cz + rf],
        [cx, cz - rf],
        [cx + df, cz + df],
        [cx + df, cz - df],
        [cx - df, cz + df],
        [cx - df, cz - df],
      );
    }
    testPoints.push([cx, cz]);
  } else {
    const { right, back } = getBasis2D(shape.obb.yawDeg);
    const hx = shape.obb.widthM * 0.5;
    const hz = shape.obb.depthM * 0.5;
    const [cx, cz] = shape.obb.center;
    const steps = [-1, -0.5, 0, 0.5, 1];
    for (const u of steps) {
      for (const v of steps) {
        testPoints.push([
          cx + right[0] * (u * hx) + back[0] * (v * hz),
          cz + right[1] * (u * hx) + back[1] * (v * hz),
        ]);
      }
    }
  }

  return testPoints.every((pt) =>
    regions.some((reg) => isPointInAABB2D(pt, reg, eps)),
  );
}

/**
 * Checks if a Shape2D and vertical span [minY, maxY] stay within 3D roomBounds.
 */
export function isShapeInsideRoomBounds(
  shape: Shape2D,
  minY: number,
  maxY: number,
  roomBounds: AABB3D,
  eps: number = NUMERIC_EPSILON,
): boolean {
  if (minY < roomBounds.min[1] - eps || maxY > roomBounds.max[1] + eps) {
    return false;
  }
  const aabb2D: AABB2D = {
    minX: roomBounds.min[0],
    maxX: roomBounds.max[0],
    minZ: roomBounds.min[2],
    maxZ: roomBounds.max[2],
  };
  return isShape2DInsideAABB2D(shape, aabb2D, eps);
}

/**
 * Separating Axis Theorem (SAT) intersection test for two 2D oriented bounding boxes.
 * Returns true only when strict interior overlap exceeds `eps` (touching boundaries do not collide).
 */
export function obb2DOverlapsOBB2D(
  a: OBB2D,
  b: OBB2D,
  eps: number = NUMERIC_EPSILON,
): boolean {
  const cornersA = getOBB2DCorners(a);
  const cornersB = getOBB2DCorners(b);
  const basisA = getBasis2D(a.yawDeg);
  const basisB = getBasis2D(b.yawDeg);

  const axes: Vec2[] = [
    basisA.right,
    basisA.back,
    basisB.right,
    basisB.back,
  ];

  for (const axis of axes) {
    let minA = Infinity;
    let maxA = -Infinity;
    for (const c of cornersA) {
      const proj = c[0] * axis[0] + c[1] * axis[1];
      if (proj < minA) minA = proj;
      if (proj > maxA) maxA = proj;
    }

    let minB = Infinity;
    let maxB = -Infinity;
    for (const c of cornersB) {
      const proj = c[0] * axis[0] + c[1] * axis[1];
      if (proj < minB) minB = proj;
      if (proj > maxB) maxB = proj;
    }

    if (maxA <= minB + eps || maxB <= minA + eps) {
      return false;
    }
  }

  return true;
}

/**
 * Exact 2D intersection test between an OBB2D and a Circle2D.
 * Returns true only when strict interior overlap exceeds `eps`.
 */
export function obb2DOverlapsCircle2D(
  obb: OBB2D,
  circle: Circle2D,
  eps: number = NUMERIC_EPSILON,
): boolean {
  const { right, back } = getBasis2D(obb.yawDeg);
  const dx = circle.center[0] - obb.center[0];
  const dz = circle.center[1] - obb.center[1];

  const localX = dx * right[0] + dz * right[1];
  const localZ = dx * back[0] + dz * back[1];

  const hx = obb.widthM * 0.5;
  const hz = obb.depthM * 0.5;

  const clampedX = Math.max(-hx, Math.min(hx, localX));
  const clampedZ = Math.max(-hz, Math.min(hz, localZ));

  const distX = localX - clampedX;
  const distZ = localZ - clampedZ;
  const distSq = distX * distX + distZ * distZ;
  const effectiveRadius = Math.max(0, circle.radiusM - eps);

  return distSq < effectiveRadius * effectiveRadius;
}

/**
 * Exact 2D intersection test between two Circle2Ds.
 */
export function circle2DOverlapsCircle2D(
  a: Circle2D,
  b: Circle2D,
  eps: number = NUMERIC_EPSILON,
): boolean {
  const dx = a.center[0] - b.center[0];
  const dz = a.center[1] - b.center[1];
  const sumR = Math.max(0, a.radiusM + b.radiusM - eps);
  return dx * dx + dz * dz < sumR * sumR;
}

/**
 * Exact 2D intersection test between any two Shape2D primitives.
 */
export function shapes2DOverlap(
  a: Shape2D,
  b: Shape2D,
  eps: number = NUMERIC_EPSILON,
): boolean {
  if (a.kind === 'obb' && b.kind === 'obb') {
    return obb2DOverlapsOBB2D(a.obb, b.obb, eps);
  }
  if (a.kind === 'obb' && b.kind === 'circle') {
    return obb2DOverlapsCircle2D(a.obb, b.circle, eps);
  }
  if (a.kind === 'circle' && b.kind === 'obb') {
    return obb2DOverlapsCircle2D(b.obb, a.circle, eps);
  }
  if (a.kind === 'circle' && b.kind === 'circle') {
    return circle2DOverlapsCircle2D(a.circle, b.circle, eps);
  }
  return false;
}

/**
 * Converts an AABB2D into an OBB2D with yawDeg = 0.
 */
export function aabb2DToOBB2D(aabb: AABB2D): OBB2D {
  return {
    center: [(aabb.minX + aabb.maxX) * 0.5, (aabb.minZ + aabb.maxZ) * 0.5],
    widthM: aabb.maxX - aabb.minX,
    depthM: aabb.maxZ - aabb.minZ,
    yawDeg: 0,
  };
}

/**
 * Constructs an OBB2D for a place footprint at its parent SceneObject's current transform.
 */
export function getPlaceFootprintOBB2D(
  place: AudiencePlace,
  obj: SceneObject,
  overrideWidthM?: number,
  overrideDepthM?: number,
): OBB2D {
  return {
    center: [obj.transform.position[0], obj.transform.position[2]],
    widthM: overrideWidthM ?? place.widthM,
    depthM: overrideDepthM ?? place.depthM,
    yawDeg: obj.transform.yawDeg,
  };
}

/**
 * Constructs the 2D oriented front legroom rectangle immediately in front of a place footprint
 * along `yawDegToForwardVector(obj.transform.yawDeg)` with width `requiredFootprintWidthM`
 * and depth `requiredFrontLegroomM` (PRD §6).
 */
export function getPlaceFrontLegroomOBB2D(
  place: AudiencePlace,
  obj: SceneObject,
  requiredFootprintWidthM: number,
  requiredFrontLegroomM: number,
): OBB2D {
  const forward = yawDegToForwardVector(obj.transform.yawDeg);
  const offsetForwardM = place.depthM * 0.5 + requiredFrontLegroomM * 0.5;
  return {
    center: [
      obj.transform.position[0] + forward[0] * offsetForwardM,
      obj.transform.position[2] + forward[2] * offsetForwardM,
    ],
    widthM: requiredFootprintWidthM,
    depthM: requiredFrontLegroomM,
    yawDeg: obj.transform.yawDeg,
  };
}

/**
 * Converts a ProxyPrimitive on a SceneObject into a WorldCollider (2D footprint + vertical Y span).
 */
export function proxyToWorldCollider(
  obj: SceneObject,
  proxy: ProxyPrimitive,
  ownerPlaceId?: string,
): WorldCollider | null {
  const worldCenter = localToWorldPoint(
    obj.transform.position,
    obj.transform.yawDeg,
    proxy.localPosition,
  );
  const totalYaw = obj.transform.yawDeg + proxy.localYawDeg;

  if (proxy.kind === 'box') {
    if (!proxy.size) return null;
    const [wx, hy, dz] = proxy.size;
    return {
      id: proxy.id,
      ownerObjectId: obj.id,
      ownerCategory: obj.category,
      ownerPlaceId,
      shape2D: {
        kind: 'obb',
        obb: {
          center: [worldCenter[0], worldCenter[2]],
          widthM: wx,
          depthM: dz,
          yawDeg: totalYaw,
        },
      },
      minY: worldCenter[1] - hy * 0.5,
      maxY: worldCenter[1] + hy * 0.5,
    };
  }

  if (proxy.kind === 'cylinder') {
    if (proxy.radiusM === undefined || proxy.heightM === undefined) return null;
    return {
      id: proxy.id,
      ownerObjectId: obj.id,
      ownerCategory: obj.category,
      ownerPlaceId,
      shape2D: {
        kind: 'circle',
        circle: {
          center: [worldCenter[0], worldCenter[2]],
          radiusM: proxy.radiusM,
        },
      },
      minY: worldCenter[1] - proxy.heightM * 0.5,
      maxY: worldCenter[1] + proxy.heightM * 0.5,
    };
  }

  return null;
}

/**
 * Constructs an OBB2D representing a corridor sweep of `widthM` between 2D points `p0` and `p1`.
 */
export function createSegmentCorridorOBB2D(
  p0: Vec2,
  p1: Vec2,
  widthM: number,
): OBB2D {
  const dx = p1[0] - p0[0];
  const dz = p1[1] - p0[1];
  const len = Math.hypot(dx, dz);
  if (len <= NUMERIC_EPSILON) {
    return {
      center: [p0[0], p0[1]],
      widthM,
      depthM: widthM,
      yawDeg: 0,
    };
  }
  // Forward vector [fx, 0, fz] = [dx / len, 0, dz / len] = [-sin(yaw), 0, -cos(yaw)]
  // => sin(yaw) = -fx, cos(yaw) = -fz => yaw = atan2(-fx, -fz)
  const fx = dx / len;
  const fz = dz / len;
  const yawDeg = (Math.atan2(-fx, -fz) * 180) / Math.PI;
  return {
    center: [(p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5],
    widthM,
    depthM: len,
    yawDeg,
  };
}

/**
 * Computes the closest point on a 2D line segment [a, b] to a query point `p`.
 */
export function closestPointOnSegment2D(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const abX = b[0] - a[0];
  const abZ = b[1] - a[1];
  const lenSq = abX * abX + abZ * abZ;
  if (lenSq <= NUMERIC_EPSILON * NUMERIC_EPSILON) {
    return [a[0], a[1]];
  }
  const apX = p[0] - a[0];
  const apZ = p[1] - a[1];
  const t = Math.max(0, Math.min(1, (apX * abX + apZ * abZ) / lenSq));
  return [a[0] + t * abX, a[1] + t * abZ];
}

/**
 * Computes the approach point just outside the destination place's OBB2D footprint
 * along the segment from `anchorPoint` to `obb.center` (PRD §6).
 */
export function computeApproachEndpointOutsideFootprint(
  anchorPoint: Vec2,
  footprint: OBB2D,
): Vec2 {
  const { right, back } = getBasis2D(footprint.yawDeg);
  const relX = anchorPoint[0] - footprint.center[0];
  const relZ = anchorPoint[1] - footprint.center[1];

  // Ray in footprint local space from localAnchor -> [0, 0] as t goes 0 -> 1:
  // pos(t) = (1 - t) * localAnchor
  const lax = relX * right[0] + relZ * right[1];
  const laz = relX * back[0] + relZ * back[1];
  const hx = footprint.widthM * 0.5;
  const hz = footprint.depthM * 0.5;

  // If anchor is already inside or on boundary of footprint, return footprint center
  if (Math.abs(lax) <= hx + NUMERIC_EPSILON && Math.abs(laz) <= hz + NUMERIC_EPSILON) {
    return [footprint.center[0], footprint.center[1]];
  }

  // Find smallest t in [0, 1] where |(1 - t) * lax| <= hx and |(1 - t) * laz| <= hz
  // i.e. 1 - t <= hx / |lax| and 1 - t <= hz / |laz|
  // => 1 - tEntry = min(1, hx / |lax|, hz / |laz|)
  const ratioX = Math.abs(lax) > NUMERIC_EPSILON ? hx / Math.abs(lax) : Infinity;
  const ratioZ = Math.abs(laz) > NUMERIC_EPSILON ? hz / Math.abs(laz) : Infinity;
  const oneMinusT = Math.min(1, ratioX, ratioZ);
  const tEntry = Math.max(0, Math.min(1, 1 - oneMinusT));

  return [
    anchorPoint[0] + (footprint.center[0] - anchorPoint[0]) * tEntry,
    anchorPoint[1] + (footprint.center[1] - anchorPoint[1]) * tEntry,
  ];
}

/**
 * 3D Ray vs Oriented Bounding Box (OBB) intersection test for segment P(t) = rayOrigin + t * (rayTarget - rayOrigin),
 * t in (0, 1).
 *
 * Uses exact 3D local-space slab intersection and verifies that the ray remains within the finite
 * vertical bounds [-hy, +hy] across its horizontal traversal of the box (preventing false-positive
 * millimeter top-cap grazes when a viewer's eye looks over a low sign/chair back).
 * For seated attendee torso boxes (`isTorsoProxy === true`), also requires traversal across the
 * front/back depth faces so outer bounding-box shoulder corners do not falsely occlude adjacent aisles.
 */
export function rayIntersectsOBB3D(
  rayOrigin: Vec3,
  rayTarget: Vec3,
  centerWorld: Vec3,
  size: Vec3,
  yawDeg: number,
  isTorsoProxy = false,
): boolean {
  const right = yawDegToRightVector(yawDeg);
  const forward = yawDegToForwardVector(yawDeg);
  // Local axes: X = right, Y = [0, 1, 0], Z = -forward = back
  const bx = -forward[0];
  const bz = -forward[2];

  const relOriginX = rayOrigin[0] - centerWorld[0];
  const relOriginY = rayOrigin[1] - centerWorld[1];
  const relOriginZ = rayOrigin[2] - centerWorld[2];

  const dirWorldX = rayTarget[0] - rayOrigin[0];
  const dirWorldY = rayTarget[1] - rayOrigin[1];
  const dirWorldZ = rayTarget[2] - rayOrigin[2];

  // Origin in OBB local space
  const ox = relOriginX * right[0] + relOriginZ * right[2];
  const oy = relOriginY;
  const oz = relOriginX * bx + relOriginZ * bz;

  // Direction in OBB local space
  const dx = dirWorldX * right[0] + dirWorldZ * right[2];
  const dy = dirWorldY;
  const dz = dirWorldX * bx + dirWorldZ * bz;

  const hx = size[0] * 0.5;
  const hy = size[1] * 0.5;
  const hz = size[2] * 0.5;

  // X slab
  let tx0 = -Infinity;
  let tx1 = Infinity;
  if (Math.abs(dx) <= NUMERIC_EPSILON) {
    if (Math.abs(ox) > hx) return false;
  } else {
    const invDx = 1 / dx;
    const t1 = (-hx - ox) * invDx;
    const t2 = (hx - ox) * invDx;
    tx0 = Math.min(t1, t2);
    tx1 = Math.max(t1, t2);
  }

  // Y slab
  let ty0 = -Infinity;
  let ty1 = Infinity;
  if (Math.abs(dy) <= NUMERIC_EPSILON) {
    if (Math.abs(oy) > hy) return false;
  } else {
    const invDy = 1 / dy;
    const t1 = (-hy - oy) * invDy;
    const t2 = (hy - oy) * invDy;
    ty0 = Math.min(t1, t2);
    ty1 = Math.max(t1, t2);
  }

  // Z slab
  let tz0 = -Infinity;
  let tz1 = Infinity;
  if (Math.abs(dz) <= NUMERIC_EPSILON) {
    if (Math.abs(oz) > hz) return false;
  } else {
    const invDz = 1 / dz;
    const t1 = (-hz - oz) * invDz;
    const t2 = (hz - oz) * invDz;
    tz0 = Math.min(t1, t2);
    tz1 = Math.max(t1, t2);
  }

  const tEnter = Math.max(tx0, ty0, tz0, NUMERIC_EPSILON);
  const tExit = Math.min(tx1, ty1, tz1, 1 - NUMERIC_EPSILON);
  if (tExit <= tEnter + NUMERIC_EPSILON) {
    return false;
  }

  // Evaluate at the midpoint of the narrower horizontal slab (or clamped [tEnterXZ, tExitXZ])
  const dtX = tx1 - tx0;
  const dtZ = tz1 - tz0;
  const tMidXZ =
    dtZ <= dtX
      ? 0.5 * (Math.max(tz0, NUMERIC_EPSILON) + Math.min(tz1, 1 - NUMERIC_EPSILON))
      : 0.5 * (Math.max(tx0, NUMERIC_EPSILON) + Math.min(tx1, 1 - NUMERIC_EPSILON));

  const xMid = ox + tMidXZ * dx;
  const yMid = oy + tMidXZ * dy;
  const zMid = oz + tMidXZ * dz;
  const TOP_BEVEL_TOLERANCE_M = 1e-3;
  if (
    Math.abs(xMid) > hx + NUMERIC_EPSILON ||
    Math.abs(zMid) > hz + NUMERIC_EPSILON ||
    yMid > hy - TOP_BEVEL_TOLERANCE_M ||
    yMid < -hy - NUMERIC_EPSILON
  ) {
    return false;
  }

  if (isTorsoProxy) {
    // Seated head/torso proxy: the lower 70% is full shoulder width [-hx, +hx], while the upper
    // 30% (localY > 0.20 * hy, above shoulder level) is the narrower head (~45% of shoulder width).
    if (yMid > 0.2 * hy) {
      const headHx = hx * 0.45;
      const headHz = hz * 0.8;
      if (
        Math.abs(xMid) > headHx + NUMERIC_EPSILON ||
        Math.abs(zMid) > headHz + NUMERIC_EPSILON
      ) {
        return false;
      }
    }
  }

  return true;
}

/**
 * 3D Ray vs finite vertical Cylinder intersection test for segment P(t) = rayOrigin + t * (rayTarget - rayOrigin),
 * t in (0, 1).
 */
export function rayIntersectsCylinder3D(
  rayOrigin: Vec3,
  rayTarget: Vec3,
  centerWorld: Vec3,
  radiusM: number,
  heightM: number,
): boolean {
  const ox = rayOrigin[0] - centerWorld[0];
  const oy = rayOrigin[1] - centerWorld[1];
  const oz = rayOrigin[2] - centerWorld[2];

  const dx = rayTarget[0] - rayOrigin[0];
  const dy = rayTarget[1] - rayOrigin[1];
  const dz = rayTarget[2] - rayOrigin[2];

  const hy = heightM * 0.5;

  // Y slab
  let ty0 = -Infinity;
  let ty1 = Infinity;
  if (Math.abs(dy) <= NUMERIC_EPSILON) {
    if (Math.abs(oy) > hy) return false;
  } else {
    const invDy = 1 / dy;
    const t1 = (-hy - oy) * invDy;
    const t2 = (hy - oy) * invDy;
    ty0 = Math.min(t1, t2);
    ty1 = Math.max(t1, t2);
  }

  const a = dx * dx + dz * dz;
  let tEnterXZ = NUMERIC_EPSILON;
  let tExitXZ = 1 - NUMERIC_EPSILON;

  if (a <= NUMERIC_EPSILON * NUMERIC_EPSILON) {
    if (ox * ox + oz * oz > radiusM * radiusM) {
      return false;
    }
  } else {
    const b = 2 * (ox * dx + oz * dz);
    const c = ox * ox + oz * oz - radiusM * radiusM;
    const disc = b * b - 4 * a * c;
    if (disc <= 0) {
      return false;
    }
    const sqrtDisc = Math.sqrt(disc);
    const inv2A = 0.5 / a;
    const t0 = (-b - sqrtDisc) * inv2A;
    const t1 = (-b + sqrtDisc) * inv2A;
    tEnterXZ = Math.max(t0, NUMERIC_EPSILON);
    tExitXZ = Math.min(t1, 1 - NUMERIC_EPSILON);
    if (tExitXZ <= tEnterXZ + NUMERIC_EPSILON) {
      return false;
    }
  }

  const tEnter = Math.max(tEnterXZ, ty0, NUMERIC_EPSILON);
  const tExit = Math.min(tExitXZ, ty1, 1 - NUMERIC_EPSILON);
  if (tExit <= tEnter + NUMERIC_EPSILON) {
    return false;
  }

  const tMidXZ = 0.5 * (tEnterXZ + tExitXZ);
  const yMid = oy + tMidXZ * dy;
  if (yMid > hy - 1e-3 || yMid < -hy - NUMERIC_EPSILON) {
    return false;
  }

  return true;
}

/**
 * Converts a WorldBoxProxy (from `getAttendeeTorsoProxyWorldBox`) into a WorldOccluder.
 */
export function worldBoxProxyToOccluder(box: WorldBoxProxy): WorldOccluder {
  return {
    id: box.id,
    blockerId: box.ownerObjectId ?? box.ownerAttendeeId ?? box.id,
    ownerObjectId: box.ownerObjectId ?? box.id,
    ownerAttendeeId: box.ownerAttendeeId,
    kind: 'box',
    centerWorld: box.centerWorld,
    yawDeg: box.yawDeg,
    size: box.size,
  };
}
