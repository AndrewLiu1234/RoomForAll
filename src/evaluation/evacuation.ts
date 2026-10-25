/**
 * Stream B — Deterministic Crowd & Emergency Evacuation Simulation Engine (`src/evaluation/evacuation.ts`)
 *
 * Pure, deterministic 2D social-force and row-extrication crowd simulation shared across:
 * - Stream B (`evaluateScene`, `compareEvaluations`)
 * - Stream A (`captureEvidence` optical video evidence + `VenueViewport` live simulation)
 * - Stream C (`argonClient` evacuation bottleneck diagnosis & layout revision)
 *
 * Models:
 * 1. Seat-row extrication: squeezing laterally along a chair row to the aisle anchor (`routeAnchorPoint`).
 *    When rows are tightly bunched (`clearRowGapM < 0.48m`) or blocked by furniture/props, extrication speed
 *    drops sharply, creating realistic row jams that Argon 4 can resolve by spacing out `chairGroups` or chairs.
 * 2. Multi-portal exit routing: resolves primary and secondary emergency exit portals (`getVenueExitPortals(snapshot)`).
 *    If a secondary emergency exit is blocked by a movable barrier or cart (`gateObjectId` or overlapping `blocksMovement` proxy),
 *    all evacuees are forced through the remaining exit, causing aisle merge queuing. Moving the barrier/prop opens the
 *    secondary exit and balances crowd flow across both doors.
 * 3. Social force & personal radius collision avoidance: agents maintain `0.32m` (ambulatory) or `0.48m` (`wheelchair_user`)
 *    personal radii and experience queueing slowdown when crowd density spikes at aisle merges or narrow doors.
 */
import {
  NUMERIC_EPSILON,
  type AudiencePlace,
  type EvacuationAgentFrameState,
  type EvacuationBottleneckZone,
  type EvacuationSimResult,
  type ProfileId,
  type SceneObject,
  type SceneSnapshot,
  type Vec2,
  type VenueExitPortal,
} from '../shared/index.js';
import {
  getPlaceFootprintOBB2D,
  proxyToWorldCollider,
  shapes2DOverlap,
  type Shape2D,
  type WorldCollider,
} from './geometry.js';

export interface ResolvedExitPortal extends VenueExitPortal {
  isBlocked: boolean;
  blockingObjectIds: string[];
  effectiveWidthM: number;
}

/**
 * Deterministically resolves the venue's exit portals from `snapshot.exits` or derives
 * canonical primary + secondary emergency exits from `snapshot.routes` and `snapshot.roomBounds`.
 */
export function getVenueExitPortals(snapshot: SceneSnapshot): VenueExitPortal[] {
  if (
    snapshot.exits &&
    snapshot.exits.length > 0 &&
    (snapshot.sceneId.startsWith('glb_standalone_') ||
      snapshot.exits.some((e) => e.id !== 'exit_auto_west'))
  ) {
    return snapshot.exits;
  }

  const minX = snapshot.roomBounds.min[0];
  const maxX = snapshot.roomBounds.max[0];
  const maxZ = snapshot.roomBounds.max[2];

  // Primary entrance/exit at the start of the main route (West Rear Entrance)
  const primaryRoute = snapshot.routes[0];
  const primaryPos: Vec2 = primaryRoute?.waypoints[0]
    ? [primaryRoute.waypoints[0][0], primaryRoute.waypoints[0][1]]
    : [minX + 0.85, maxZ - 0.6];

  const portals: VenueExitPortal[] = [
    {
      id: 'exit_main_west',
      label: 'Main West Entrance / Exit',
      position: primaryPos,
      widthM: 1.4,
      yawDeg: 0,
      isEmergencyExit: false,
    },
  ];

  // For the 24-place community hall (or larger rooms width >= 9m), include secondary emergency exits
  if (maxX - minX >= 9.0) {
    portals.push({
      id: 'exit_emergency_east',
      label: 'East Secondary Emergency Exit (Low Level)',
      position: [maxX - 0.65, 3.85],
      elevationM: 0.0,
      widthM: 1.25,
      yawDeg: -90,
      isEmergencyExit: true,
    });

    portals.push({
      id: 'exit_wheelchair_terrace',
      label: 'Rear Wheelchair Terrace Emergency Exit (High Level)',
      position: [0.0, maxZ - 0.65],
      elevationM: 0.30,
      widthM: 1.6,
      yawDeg: 0,
      isEmergencyExit: true,
    });
  }

  return portals;
}

/**
 * Evaluates whether each exit portal is clear or obstructed by any movable prop, chair, or gate object.
 */
export function resolveActiveExitPortals(
  snapshot: SceneSnapshot,
  movementBlockers: WorldCollider[],
): ResolvedExitPortal[] {
  const rawPortals = getVenueExitPortals(snapshot);
  return rawPortals.map((portal) => {
    const checkCircle: Shape2D = {
      kind: 'circle',
      circle: {
        center: portal.position,
        radiusM: Math.max(0.55, portal.widthM * 0.55),
      },
    };

    const blockingIds = new Set<string>();
    for (const blocker of movementBlockers) {
      if (blocker.maxY <= 0.1) continue;
      if (shapes2DOverlap(checkCircle, blocker.shape2D, NUMERIC_EPSILON)) {
        blockingIds.add(blocker.ownerObjectId);
      }
    }

    // Also check if an explicit gateObjectId is still within 0.75m of the portal center
    if (portal.gateObjectId) {
      const gateObj = snapshot.objects.find((o) => o.id === portal.gateObjectId);
      if (gateObj) {
        const dist = Math.hypot(
          gateObj.transform.position[0] - portal.position[0],
          gateObj.transform.position[2] - portal.position[1],
        );
        if (dist < 0.78) {
          blockingIds.add(gateObj.id);
        }
      }
    }

    const blockingObjectIds = Array.from(blockingIds);
    // If a gate object or large prop blocks >60% of the portal, the exit is blocked or severely throttled
    const isHardBlocked =
      (portal.gateObjectId !== undefined &&
        blockingIds.has(portal.gateObjectId)) ||
      blockingObjectIds.length >= 2;
    const effectiveWidthM = isHardBlocked
      ? 0
      : blockingObjectIds.length === 1
        ? Math.max(0.45, portal.widthM * 0.45)
        : portal.widthM;

    return {
      ...portal,
      isBlocked: isHardBlocked,
      blockingObjectIds,
      effectiveWidthM,
    };
  });
}

/**
 * Computes the clear inter-row passage gap (`clearRowGapM`) in front of a given chair/place
 * and identifies any objects narrowing that row passage.
 */
export function computeSeatRowExtricationClearance(
  place: AudiencePlace,
  obj: SceneObject,
  snapshot: SceneSnapshot,
  movementBlockers: WorldCollider[],
): {
  clearRowGapM: number;
  constrainingObjectIds: string[];
} {
  if (place.kind === 'wheelchair_bay') {
    return { clearRowGapM: 1.2, constrainingObjectIds: [] };
  }

  const pos = obj.transform.position;
  const seatFrontZ = pos[2] - place.depthM * 0.5;
  let minClearGapM = 0.95;
  const constrainingIds = new Set<string>();

  // Check distance to any chair or object in front of this seat (within lateral X band +-0.62m)
  for (const otherObj of snapshot.objects) {
    if (otherObj.id === obj.id) continue;
    if (otherObj.category === 'stage' || otherObj.category === 'fixed_structure') {
      continue;
    }
    if (otherObj.groupId && obj.groupId && otherObj.groupId === obj.groupId) {
      continue;
    }
    if (Math.abs(otherObj.transform.position[1] - pos[1]) > 0.75) {
      continue;
    }

    const ox = otherObj.transform.position[0];
    const oz = otherObj.transform.position[2];
    if (Math.abs(ox - pos[0]) > 0.62) continue;

    // If the other object is in front of this chair (smaller Z, since stage is at -Z)
    if (oz < pos[2] - 0.15 && oz > pos[2] - 1.85) {
      const otherPlace = snapshot.places.find((p) => p.objectId === otherObj.id);
      if (!otherPlace && otherObj.category !== 'movable_chair') {
        continue;
      }
      const otherBackZ = otherPlace
        ? oz + otherPlace.depthM * 0.5
        : oz +
          Math.max(
            0.15,
            ...(otherObj.proxies.map((pr) => (pr.size ? pr.size[2] * 0.5 : 0.15))),
          );

      const gap = seatFrontZ - otherBackZ;
      if (gap < minClearGapM) {
        minClearGapM = Math.max(0.08, gap);
        if (gap < 0.38) {
          constrainingIds.add(otherObj.groupId ?? otherObj.id);
        }
      }
    }
  }

  // Also check if any movement blocker directly overlaps the seat footprint
  const extricationCheckBox: Shape2D = {
    kind: 'obb',
    obb: getPlaceFootprintOBB2D(place, obj, place.widthM + 0.08, place.depthM + 0.18),
  };
  for (const blocker of movementBlockers) {
    if (blocker.ownerObjectId === obj.id) continue;
    if (shapes2DOverlap(extricationCheckBox, blocker.shape2D, NUMERIC_EPSILON)) {
      minClearGapM = Math.min(minClearGapM, 0.22);
      constrainingIds.add(blocker.ownerObjectId);
    }
  }

  return {
    clearRowGapM: Number(minClearGapM.toFixed(4)),
    constrainingObjectIds: Array.from(constrainingIds),
  };
}

interface InternalSimAgent {
  attendeeId: string;
  profileId: ProfileId;
  placeId: string;
  objectId: string;
  seatPos: Vec2;
  seatY: number;
  position: Vec2;
  velocity: Vec2;
  yawDeg: number;
  personalRadiusM: number;
  baseSpeedMps: number;
  extricationSpeedMps: number;
  departureDelaySec: number;
  waypoints: Vec2[];
  currentWaypointIdx: number;
  targetExitId: string;
  trappedByWall: boolean;
  blockingWallId?: string;
  state: 'seated' | 'extricating' | 'walking' | 'queuing' | 'exited';
  exitTimeSec?: number;
  constrainingObjectIds: string[];
}

function getWallAndBarrierColliders(
  snapshot: SceneSnapshot,
  movementBlockers: WorldCollider[],
): WorldCollider[] {
  const objectById = new Map(snapshot.objects.map((o) => [o.id, o]));
  return movementBlockers.filter((b) => {
    const obj = objectById.get(b.ownerObjectId);
    return obj?.category === 'fixed_structure' && obj.id.startsWith('wall_');
  });
}

function findFirstWallHitOnSegment(
  p0: Vec2,
  p1: Vec2,
  seatY: number,
  wallBlockers: WorldCollider[],
  ignoreOwnerObjectId?: string,
): { blocked: boolean; stopPoint: Vec2; blockerId?: string } {
  const dx = p1[0] - p0[0];
  const dz = p1[1] - p0[1];
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-4) {
    return { blocked: false, stopPoint: p1 };
  }

  const steps = Math.max(2, Math.ceil(dist / 0.25));
  let lastClearPt: Vec2 = [p0[0], p0[1]];

  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const pt: Vec2 = [p0[0] + dx * t, p0[1] + dz * t];
    const probe: Shape2D = {
      kind: 'circle',
      circle: { center: pt, radiusM: 0.22 },
    };

    for (const blocker of wallBlockers) {
      if (blocker.ownerObjectId === ignoreOwnerObjectId) continue;
      // Check vertical overlap at torso/waist level [seatY + 0.85, seatY + 1.5] so low steps/platforms (<0.85m) are walkable
      if (blocker.maxY < seatY + 0.85 || blocker.minY > seatY + 1.5) {
        continue;
      }
      if (shapes2DOverlap(probe, blocker.shape2D, NUMERIC_EPSILON)) {
        return {
          blocked: true,
          stopPoint: [
            Number(lastClearPt[0].toFixed(3)),
            Number(lastClearPt[1].toFixed(3)),
          ],
          blockerId: blocker.ownerObjectId,
        };
      }
    }

    lastClearPt = pt;
  }

  return { blocked: false, stopPoint: p1 };
}

function checkWaypointChainWallFree(
  startPos: Vec2,
  chain: Vec2[],
  seatY: number,
  wallBlockers: WorldCollider[],
  ignoreOwnerObjectId?: string,
): {
  clear: boolean;
  truncatedWaypoints: Vec2[];
  blockerId?: string;
} {
  const truncated: Vec2[] = [];
  let cur: Vec2 = startPos;
  for (const wp of chain) {
    const hit = findFirstWallHitOnSegment(
      cur,
      wp,
      seatY,
      wallBlockers,
      ignoreOwnerObjectId,
    );
    if (hit.blocked) {
      if (Math.hypot(hit.stopPoint[0] - cur[0], hit.stopPoint[1] - cur[1]) > 0.12) {
        truncated.push(hit.stopPoint);
      } else if (truncated.length === 0) {
        truncated.push([cur[0], cur[1]]);
      }
      return {
        clear: false,
        truncatedWaypoints: truncated,
        blockerId: hit.blockerId,
      };
    }
    truncated.push(wp);
    cur = wp;
  }
  return { clear: true, truncatedWaypoints: truncated };
}

function getBaseWalkingSpeed(
  profileId: ProfileId,
  mode: 'normal_egress' | 'emergency_evacuation',
): number {
  if (mode === 'normal_egress') {
    switch (profileId) {
      case 'wheelchair_user':
        return 0.95;
      case 'extra_legroom':
        return 1.02;
      case 'shorter_seated':
        return 1.1;
      case 'reference_adult':
      default:
        return 1.18;
    }
  }
  // Emergency evacuation speeds
  switch (profileId) {
    case 'wheelchair_user':
      return 1.18;
    case 'extra_legroom':
      return 1.32;
    case 'shorter_seated':
      return 1.45;
    case 'reference_adult':
    default:
      return 1.58;
  }
}

function computeWaypointChainLength(startPos: Vec2, chain: Vec2[]): number {
  let total = 0;
  let cur = startPos;
  for (const wp of chain) {
    total += Math.hypot(wp[0] - cur[0], wp[1] - cur[1]);
    cur = wp;
  }
  return total;
}

/**
 * Builds the deterministic waypoint chain from an attendee's seat to the closest REACHABLE exit portal.
 * If no exit is reachable without phasing through walls/objects or jumping across disconnected levels,
 * returns `trappedByWall: true` so an error is reported to the user.
 */
function buildAgentEgressWaypoints(
  seatPos: Vec2,
  seatY: number,
  place: AudiencePlace,
  snapshot: SceneSnapshot,
  resolvedExits: ResolvedExitPortal[],
  wallBlockers: WorldCollider[],
): {
  waypoints: Vec2[];
  targetExitId: string;
  trappedByWall: boolean;
  blockingWallId?: string;
} {
  const usableExits = resolvedExits.filter((e) => !e.isBlocked);
  const candidateExits = usableExits.length > 0 ? usableExits : resolvedExits;

  // For uploaded .glb venues with explicit parsed exit points (`snapshot.exits`),
  // evaluate ALL exits to find the CLOSEST REACHABLE EXIT (shortest wall-free walkable path
  // on a connected vertical level `|seatY - exitY| <= 0.95m`), and otherwise report an error!
  if (
    snapshot.exits !== undefined &&
    snapshot.sceneId.startsWith('glb_standalone_')
  ) {
    if (candidateExits.length === 0) {
      return {
        waypoints: [[seatPos[0], seatPos[1]]],
        targetExitId: 'none',
        trappedByWall: true,
        blockingWallId: 'no_exits_in_scene',
      };
    }

    const sortedByDist = [...candidateExits].sort(
      (a, b) =>
        Math.hypot(a.position[0] - seatPos[0], a.position[1] - seatPos[1]) -
        Math.hypot(b.position[0] - seatPos[0], b.position[1] - seatPos[1]),
    );

    let bestReachable: {
      waypoints: Vec2[];
      targetExitId: string;
      pathLengthM: number;
    } | null = null;

    let bestBlockedAttempt: {
      waypoints: Vec2[];
      targetExitId: string;
      blockerId?: string;
      remainingDistToExit: number;
    } | null = null;

    // Step 0.32m out of the chair into the clear row cross-aisle so the person never walks through neighboring chairs
    const rowStepZ = Number((seatPos[1] - 0.32).toFixed(3));

    for (const exit of sortedByDist) {
      if (exit.isBlocked) continue;
      const exitY = exit.elevationM ?? 0;
      const levelDiff = Math.abs(seatY - exitY);

      const sideAisleX =
        exit.position[0] < 0
          ? Math.min(seatPos[0] - 0.35, exit.position[0] + 0.15)
          : Math.max(seatPos[0] + 0.35, exit.position[0] - 0.15);
      const inboardAisleX =
        exit.position[0] < 0
          ? exit.position[0] + 0.65
          : exit.position[0] - 0.65;

      const candidateChains: Vec2[][] = [
        ...(Math.abs(exit.position[1] - seatPos[1]) < 0.65
          ? [
              [
                [seatPos[0], exit.position[1]] as Vec2,
                [exit.position[0], exit.position[1]] as Vec2,
              ],
              [[exit.position[0], exit.position[1]] as Vec2],
            ]
          : []),
        [
          [seatPos[0], rowStepZ],
          [Number(sideAisleX.toFixed(3)), rowStepZ],
          [exit.position[0], exit.position[1]],
        ],
        [
          [Number(sideAisleX.toFixed(3)), seatPos[1]],
          [exit.position[0], exit.position[1]],
        ],
        [
          [Number(inboardAisleX.toFixed(3)), seatPos[1]],
          [Number(inboardAisleX.toFixed(3)), exit.position[1]],
          [exit.position[0], exit.position[1]],
        ],
        [
          [seatPos[0], exit.position[1]],
          [exit.position[0], exit.position[1]],
        ],
        [[exit.position[0], exit.position[1]]],
      ];

      for (const chain of candidateChains) {
        const check = checkWaypointChainWallFree(
          seatPos,
          chain,
          seatY,
          wallBlockers,
          place.objectId,
        );

        if (check.clear && levelDiff <= 0.95) {
          const pathLengthM = computeWaypointChainLength(
            seatPos,
            check.truncatedWaypoints,
          );
          if (!bestReachable || pathLengthM < bestReachable.pathLengthM) {
            bestReachable = {
              waypoints: check.truncatedWaypoints,
              targetExitId: exit.id,
              pathLengthM,
            };
          }
          continue;
        }

        // If blocked, record the reason so we can report an error if no reachable exit exists
        const stopWps =
          levelDiff > 0.95 && check.clear
            ? [
                [seatPos[0], rowStepZ] as Vec2,
                [Number(sideAisleX.toFixed(3)), rowStepZ] as Vec2,
              ]
            : check.truncatedWaypoints;
        const lastPt = stopWps[stopWps.length - 1] ?? seatPos;
        const remDist =
          Math.hypot(
            exit.position[0] - lastPt[0],
            exit.position[1] - lastPt[1],
          ) + (levelDiff > 0.95 ? levelDiff * 2.0 : 0);

        if (
          !bestBlockedAttempt ||
          remDist < bestBlockedAttempt.remainingDistToExit
        ) {
          bestBlockedAttempt = {
            waypoints: stopWps,
            targetExitId: exit.id,
            blockerId:
              levelDiff > 0.95
                ? `isolated_level_drop_${seatY.toFixed(1)}m_to_${exitY.toFixed(1)}m`
                : check.blockerId,
            remainingDistToExit: remDist,
          };
        }
      }
    }

    if (bestReachable) {
      return {
        waypoints: bestReachable.waypoints,
        targetExitId: bestReachable.targetExitId,
        trappedByWall: false,
      };
    }

    // No reachable exit exists for this person: report error!
    return {
      waypoints: bestBlockedAttempt?.waypoints ?? [[seatPos[0], seatPos[1]]],
      targetExitId: bestBlockedAttempt?.targetExitId ?? sortedByDist[0]!.id,
      trappedByWall: true,
      blockingWallId: bestBlockedAttempt?.blockerId ?? 'no_reachable_exit',
    };
  }

  const waypoints: Vec2[] = [];

  // 1. Exit Selection for Tiered Community Hall / Fallback Venues
  let bestExit = candidateExits[0]!;
  const isTerraceSeat = place.kind === 'wheelchair_bay' || seatPos[1] >= 2.25;

  if (isTerraceSeat) {
    // Wheelchair bays and top tier preferentially use the level wheelchair terrace exit if available
    const terraceExit = candidateExits.find(
      (e) => e.id === 'exit_wheelchair_terrace',
    );
    if (terraceExit) {
      bestExit = terraceExit;
    } else {
      let bestDist = Infinity;
      for (const exit of candidateExits) {
        const d = Math.hypot(
          exit.position[0] - seatPos[0],
          exit.position[1] - seatPos[1],
        );
        if (d < bestDist) {
          bestDist = d;
          bestExit = exit;
        }
      }
    }
  } else {
    // For tiered seats below terrace level, choose the most balanced low-level exit
    let bestScore = Infinity;
    for (const exit of candidateExits) {
      // Exclude high terrace exit for lower rows to prevent climbing backwards
      if (exit.id === 'exit_wheelchair_terrace') continue;
      const dist = Math.hypot(
        exit.position[0] - seatPos[0],
        exit.position[1] - seatPos[1],
      );
      const widthPenalty =
        exit.effectiveWidthM > 0 ? 1.2 / exit.effectiveWidthM : 10;
      const score = dist * widthPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestExit = exit;
      }
    }
  }

  // 2. Extrication: step forward into the foot-aisle on the SAME tier platform (never backward onto higher tier)
  const isRow1 = seatPos[1] <= -1.15;
  const isRow4Terrace = seatPos[1] >= 2.25;
  const sameTierAisleZ = isRow4Terrace ? seatPos[1] : seatPos[1] - 0.25;

  if (Math.abs(sameTierAisleZ - seatPos[1]) > 0.05) {
    waypoints.push([seatPos[0], sameTierAisleZ]);
  }

  // 3. Routing to High-Level Wheelchair Terrace Exit
  if (bestExit.id === 'exit_wheelchair_terrace') {
    // Already on the terrace level, route directly along the terrace to the door
    waypoints.push([seatPos[0], Math.max(seatPos[1], 4.2)]);
    waypoints.push([bestExit.position[0], bestExit.position[1]]);
    return { waypoints, targetExitId: bestExit.id, trappedByWall: false };
  }

  // 4. Routing via Outside Aisle Ramps (Down to Low-Level Exits)
  // Outside ramp corridors are at X = -3.65 (West) and X = +3.65 (East)
  const isWest = seatPos[0] < 0 || bestExit.position[0] < 0;
  const rampX = isWest ? -3.65 : 3.65;
  const rampFloorZ = -2.35; // Front floor landing of the ramp

  if (!isRow1) {
    // Elevated tiers (Row 2, 3, 4): Walk laterally on current platform to the ramp corridor
    waypoints.push([rampX, sameTierAisleZ]);
    // Walk down along and on top of the ramp to the front ground floor landing
    waypoints.push([rampX, rampFloorZ]);
  } else {
    // Row 1 is already at the base floor level: step out to the front corridor
    waypoints.push([rampX, rampFloorZ]);
  }

  // 5. From the front floor landing, walk directly to the chosen exit portal
  waypoints.push([bestExit.position[0], bestExit.position[1]]);
  return { waypoints, targetExitId: bestExit.id, trappedByWall: false };
}

/**
 * Optimizes exit portals for `snapshot` by:
 * 1. Clustering all occupied people (`snapshot.roster`) into the MINIMUM number of mutually-reachable
 *    walled/elevation zones, choosing for each zone the unobstructed aisle position that MINIMIZES escape time.
 * 2. Moving existing exits (`snapshot.exits`) FIRST to cover those zones and minimize escape time (preserving
 *    existing exit IDs so `totalExitCount` does not increase unless necessary).
 * 3. Adding new exits (`exit_repaired_*`) ONLY when strictly necessary (when there are more mutually
 *    disconnected walled/elevation zones of people than existing exits).
 */
export function synthesizeReachableExitsForSnapshot(
  snapshot: SceneSnapshot,
): VenueExitPortal[] {
  if (snapshot.roster.length === 0) {
    return [];
  }

  const placeByObjectId = new Map(snapshot.places.map((p) => [p.objectId, p]));
  const placeById = new Map(snapshot.places.map((p) => [p.id, p]));
  const objectById = new Map(snapshot.objects.map((o) => [o.id, o]));

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

  const wallBlockers = getWallAndBarrierColliders(snapshot, movementBlockers);
  const existingExits: VenueExitPortal[] = snapshot.exits
    ? structuredClone(snapshot.exits)
    : [];

  interface OccupiedSeatInfo {
    attendeeId: string;
    place: AudiencePlace;
    seatPos: Vec2;
    seatY: number;
    baselineTrapped: boolean;
    baselinePathLengthM: number;
  }

  const resolvedBaselineExits = resolveActiveExitPortals(
    snapshot,
    movementBlockers,
  );
  const occupiedSeats: OccupiedSeatInfo[] = [];

  for (const member of snapshot.roster) {
    const place = placeById.get(member.assignedPlaceId);
    const obj = place ? objectById.get(place.objectId) : undefined;
    if (!place || !obj) continue;
    const seatPos: Vec2 = [
      obj.transform.position[0],
      obj.transform.position[2],
    ];
    const seatY = obj.transform.position[1];
    const baseCheck = buildAgentEgressWaypoints(
      seatPos,
      seatY,
      place,
      snapshot,
      resolvedBaselineExits,
      wallBlockers,
    );
    const basePathLen = baseCheck.trappedByWall
      ? Infinity
      : computeWaypointChainLength(seatPos, baseCheck.waypoints);
    occupiedSeats.push({
      attendeeId: member.attendeeId,
      place,
      seatPos,
      seatY,
      baselineTrapped: baseCheck.trappedByWall,
      baselinePathLengthM: basePathLen,
    });
  }

  if (occupiedSeats.length === 0) {
    return [];
  }

  // Generate candidate unobstructed aisle exit portals across all occupied seats (plus midpoints on the same tier)
  interface CandidatePortal {
    position: Vec2;
    elevationM: number;
    yawDeg: number;
  }
  const candidates: CandidatePortal[] = [];

  // Include current existing exits as candidates too
  for (const ex of existingExits) {
    candidates.push({
      position: [ex.position[0], ex.position[1]],
      elevationM: ex.elevationM ?? 0,
      yawDeg: ex.yawDeg,
    });
  }

  const offsetsX = [-2.2, -1.5, -0.9, 0.9, 1.5, 2.2];
  for (const info of occupiedSeats) {
    const aisleZ = Number((info.seatPos[1] - 0.32).toFixed(2));
    for (const dx of offsetsX) {
      const dSign: -1 | 1 = dx < 0 ? -1 : 1;
      const targetX =
        dSign < 0
          ? Math.max(snapshot.roomBounds.min[0] + 1.0, info.seatPos[0] + dx)
          : Math.min(snapshot.roomBounds.max[0] - 1.0, info.seatPos[0] + dx);
      const hit = findFirstWallHitOnSegment(
        [info.seatPos[0], aisleZ],
        [targetX, aisleZ],
        info.seatY,
        wallBlockers,
        info.place.objectId,
      );
      const pt: Vec2 = hit.blocked
        ? [Number((hit.stopPoint[0] - dSign * 0.25).toFixed(2)), aisleZ]
        : [Number(targetX.toFixed(2)), aisleZ];
      candidates.push({
        position: pt,
        elevationM: Number(info.seatY.toFixed(2)),
        yawDeg: dSign < 0 ? 90 : -90,
      });
    }
  }

  // Also add midpoints between pairs of occupied seats on the same tier so a single moved exit can serve multiple people
  for (let i = 0; i < occupiedSeats.length; i++) {
    for (let j = i + 1; j < occupiedSeats.length; j++) {
      const a = occupiedSeats[i]!;
      const b = occupiedSeats[j]!;
      if (Math.abs(a.seatY - b.seatY) <= 0.9) {
        const midX = Number(((a.seatPos[0] + b.seatPos[0]) * 0.5).toFixed(2));
        const midZ = Number(
          ((a.seatPos[1] + b.seatPos[1]) * 0.5 - 0.32).toFixed(2),
        );
        const avgY = Number(((a.seatY + b.seatY) * 0.5).toFixed(2));
        candidates.push({
          position: [midX, midZ],
          elevationM: avgY,
          yawDeg: midX <= 0 ? 90 : -90,
        });
      }
    }
  }

  // Greedy minimum-cluster set cover with escape-time minimization:
  // Find the minimum number of exit positions needed so EVERY person can escape,
  // choosing positions that minimize walkable escape time.
  const uncoveredIndices = new Set<number>(occupiedSeats.map((_, idx) => idx));
  const requiredClusters: Array<{
    memberIndices: number[];
    portal: CandidatePortal;
    maxPathLengthM: number;
  }> = [];

  while (uncoveredIndices.size > 0) {
    let bestChoice: {
      memberIndices: number[];
      portal: CandidatePortal;
      maxPathLengthM: number;
      score: number;
    } | null = null;

    for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
      const cand = candidates[cIdx]!;
      const testPortal: ResolvedExitPortal = {
        id: `cand_${cIdx}`,
        label: `Candidate ${cIdx}`,
        position: cand.position,
        elevationM: cand.elevationM,
        widthM: 1.4,
        yawDeg: cand.yawDeg,
        isEmergencyExit: true,
        effectiveWidthM: 1.4,
        isBlocked: false,
        blockingObjectIds: [],
      };

      const covered: number[] = [];
      let maxPath = 0;
      let sumPath = 0;

      for (const sIdx of uncoveredIndices) {
        const seat = occupiedSeats[sIdx]!;
        const check = buildAgentEgressWaypoints(
          seat.seatPos,
          seat.seatY,
          seat.place,
          { ...snapshot, exits: [testPortal] },
          [testPortal],
          wallBlockers,
        );
        if (!check.trappedByWall) {
          const pLen = computeWaypointChainLength(
            seat.seatPos,
            check.waypoints,
          );
          if (pLen <= 9.5) {
            covered.push(sIdx);
            if (pLen > maxPath) maxPath = pLen;
            sumPath += pLen;
          }
        }
      }

      if (covered.length === 0) continue;
      const avgPath = sumPath / covered.length;
      // Primary: maximize number of uncovered people rescued by this single exit (minimizing total exits needed!)
      // Secondary: minimize maxPath + 0.25 * avgPath (minimizing escape time!)
      const score = covered.length * 1000 - (maxPath + 0.25 * avgPath);
      if (!bestChoice || score > bestChoice.score) {
        bestChoice = {
          memberIndices: covered,
          portal: cand,
          maxPathLengthM: maxPath,
          score,
        };
      }
    }

    if (!bestChoice) {
      // Fallback for any remaining seat: place directly at its row step
      const firstRemainingIdx = Array.from(uncoveredIndices)[0]!;
      const seat = occupiedSeats[firstRemainingIdx]!;
      bestChoice = {
        memberIndices: [firstRemainingIdx],
        portal: {
          position: [
            Number(seat.seatPos[0].toFixed(2)),
            Number((seat.seatPos[1] - 0.32).toFixed(2)),
          ],
          elevationM: Number(seat.seatY.toFixed(2)),
          yawDeg: seat.seatPos[0] <= 0 ? 90 : -90,
        },
        maxPathLengthM: 0.32,
        score: 0,
      };
    }

    requiredClusters.push({
      memberIndices: bestChoice.memberIndices,
      portal: bestChoice.portal,
      maxPathLengthM: bestChoice.maxPathLengthM,
    });
    for (const sIdx of bestChoice.memberIndices) {
      uncoveredIndices.delete(sIdx);
    }
  }

  // Assign clusters to EXISTING exits first (moving existing exits to minimize escape time!),
  // and ONLY add new exits if `requiredClusters.length > existingExits.length` (strictly when necessary!).
  const usedExistingIndices = new Set<number>();
  const modifiedOrAddedExits: VenueExitPortal[] = [];
  let addedNewCount = 0;

  for (const cluster of requiredClusters) {
    const clusterWasTrapped = cluster.memberIndices.some(
      (i) => occupiedSeats[i]!.baselineTrapped,
    );
    const baselineMaxPath = Math.max(
      ...cluster.memberIndices.map(
        (i) => occupiedSeats[i]!.baselinePathLengthM,
      ),
    );

    // Find closest unused existing exit
    let bestExistingIdx = -1;
    let bestExistingDist = Infinity;
    for (let eIdx = 0; eIdx < existingExits.length; eIdx++) {
      if (usedExistingIndices.has(eIdx)) continue;
      const ex = existingExits[eIdx]!;
      const d = Math.hypot(
        ex.position[0] - cluster.portal.position[0],
        ex.position[1] - cluster.portal.position[1],
      );
      if (d < bestExistingDist) {
        bestExistingDist = d;
        bestExistingIdx = eIdx;
      }
    }

    if (bestExistingIdx >= 0) {
      usedExistingIndices.add(bestExistingIdx);
      const ex = existingExits[bestExistingIdx]!;
      // Move this existing exit if it rescues trapped people OR shortens escape path by >= 0.35m
      if (
        clusterWasTrapped ||
        cluster.maxPathLengthM < baselineMaxPath - 0.35
      ) {
        modifiedOrAddedExits.push({
          ...ex,
          position: cluster.portal.position,
          elevationM: cluster.portal.elevationM,
          yawDeg: cluster.portal.yawDeg,
        });
      }
    } else {
      // All existing exits have already been assigned to other mutually disconnected zones:
      // Adding a new exit is ABSOLUTELY NECESSARY so this isolated cluster can escape!
      addedNewCount += 1;
      modifiedOrAddedExits.push({
        id: `exit_repaired_${addedNewCount}`,
        label: `Added Emergency Exit ${addedNewCount} (Tier Y=${cluster.portal.elevationM.toFixed(1)}m)`,
        position: cluster.portal.position,
        elevationM: cluster.portal.elevationM,
        widthM: 1.4,
        yawDeg: cluster.portal.yawDeg,
        isEmergencyExit: true,
      });
    }
  }

  return modifiedOrAddedExits;
}

/**
 * Runs the deterministic crowd egress / emergency evacuation simulation on `snapshot`.
 */
export function simulateEvacuation(
  snapshot: SceneSnapshot,
  mode: 'normal_egress' | 'emergency_evacuation' = 'emergency_evacuation',
): EvacuationSimResult {
  const placeByObjectId = new Map(snapshot.places.map((p) => [p.objectId, p]));
  const placeById = new Map(snapshot.places.map((p) => [p.id, p]));
  const objectById = new Map(snapshot.objects.map((o) => [o.id, o]));

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

  const wallBlockers = getWallAndBarrierColliders(snapshot, movementBlockers);
  const resolvedExits = resolveActiveExitPortals(snapshot, movementBlockers);
  const activeExitCount = resolvedExits.filter((e) => !e.isBlocked).length;
  const totalExitCount = resolvedExits.length;

  // Sort roster by Z descending (rear rows first in normal_egress) for deterministic ordering
  const agents: InternalSimAgent[] = [];
  for (let idx = 0; idx < snapshot.roster.length; idx++) {
    const member = snapshot.roster[idx]!;
    const place = placeById.get(member.assignedPlaceId);
    const obj = place ? objectById.get(place.objectId) : undefined;
    if (!place || !obj) continue;

    const seatPos: Vec2 = [
      obj.transform.position[0],
      obj.transform.position[2],
    ];
    const seatY = obj.transform.position[1];
    const { clearRowGapM, constrainingObjectIds } =
      computeSeatRowExtricationClearance(place, obj, snapshot, movementBlockers);

    const baseSpeedMps = getBaseWalkingSpeed(member.profileId, mode);
    // Extrication speed scales with clearRowGapM:
    // >= 0.65m gap -> 90% of base speed
    // 0.35m gap (bunched rows) -> 32% of base speed
    // < 0.22m gap (severely jammed) -> 18% of base speed
    const gapFactor = Math.max(
      0.18,
      Math.min(0.92, (clearRowGapM - 0.12) / 0.58),
    );
    // Interior (non-aisle) seats must squeeze past more chairs in the row
    const interiorPenalty = place.isAisle ? 1.0 : 0.78;
    const extricationSpeedMps = baseSpeedMps * gapFactor * interiorPenalty;

    const { waypoints, targetExitId, trappedByWall, blockingWallId } =
      buildAgentEgressWaypoints(
        seatPos,
        seatY,
        place,
        snapshot,
        resolvedExits,
        wallBlockers,
      );
    if (blockingWallId) {
      constrainingObjectIds.push(blockingWallId);
    }

    // In normal_egress, stagger departure row-by-row from rear to front;
    // in emergency_evacuation, all attendees react within 0.15s - 0.55s of alarm
    const rowRank = Math.max(0, 4.5 - seatPos[1]);
    const departureDelaySec =
      mode === 'normal_egress'
        ? Number((rowRank * 0.45 + (place.isAisle ? 0.1 : 0.35)).toFixed(2))
        : Number(((place.isAisle ? 0.15 : 0.3) + (idx % 3) * 0.08).toFixed(2));

    agents.push({
      attendeeId: member.attendeeId,
      profileId: member.profileId,
      placeId: place.id,
      objectId: obj.id,
      seatPos,
      seatY,
      position: [seatPos[0], seatPos[1]],
      velocity: [0, 0],
      yawDeg: obj.transform.yawDeg,
      personalRadiusM: member.profileId === 'wheelchair_user' ? 0.46 : 0.31,
      baseSpeedMps,
      extricationSpeedMps,
      departureDelaySec,
      waypoints,
      currentWaypointIdx: 0,
      targetExitId,
      trappedByWall,
      blockingWallId,
      state: 'seated',
      constrainingObjectIds,
    });
  }

  const dt = 0.1;
  const maxSimDurationSec = 28.0;
  const frames: EvacuationSimResult['frames'] = [];
  let peakCongestionDensity = 0;

  // Track bottleneck hotspots on a 1.0m grid
  const hotspotCounts = new Map<
    string,
    {
      center: Vec2;
      peakCount: number;
      causeIds: Set<string>;
    }
  >();

  // Record blocked secondary exits as explicit bottleneck zones so Argon knows why an exit is unusable
  for (const portal of resolvedExits) {
    if (portal.isBlocked || portal.blockingObjectIds.length > 0) {
      const key = `exit_${portal.id}`;
      hotspotCounts.set(key, {
        center: portal.position,
        peakCount: Math.max(3, Math.ceil(agents.length * 0.25)),
        causeIds: new Set(portal.blockingObjectIds),
      });
    }
  }

  let simTimeSec = 0;
  const totalSteps = Math.round(maxSimDurationSec / dt);

  for (let step = 0; step <= totalSteps; step++) {
    simTimeSec = Number((step * dt).toFixed(2));

    // Record frame snapshot every 0.2s (or step 0 / final step)
    const allSettled =
      agents.length > 0 &&
      agents.every(
        (a) =>
          a.state === 'exited' ||
          (a.trappedByWall &&
            a.currentWaypointIdx >= a.waypoints.length - 1 &&
            Math.hypot(
              a.waypoints[a.waypoints.length - 1]![0] - a.position[0],
              a.waypoints[a.waypoints.length - 1]![1] - a.position[1],
            ) < 0.45 &&
            simTimeSec >= 6.0),
      );

    if (step % 2 === 0 || step === totalSteps || allSettled) {
      const frameAgents: Record<string, EvacuationAgentFrameState> = {};
      for (const ag of agents) {
        frameAgents[ag.attendeeId] = {
          position: [
            Number(ag.position[0].toFixed(3)),
            Number(ag.position[1].toFixed(3)),
          ],
          yawDeg: Number(ag.yawDeg.toFixed(1)),
          speedMps: Number(
            Math.hypot(ag.velocity[0], ag.velocity[1]).toFixed(2),
          ),
          state: ag.state,
          targetExitId: ag.targetExitId,
          trappedByWall: ag.trappedByWall || undefined,
        };
      }
      frames.push({ timeSec: simTimeSec, agents: frameAgents });
    }

    if (allSettled) {
      break;
    }

    // Advance each active agent
    for (let i = 0; i < agents.length; i++) {
      const ag = agents[i]!;
      if (ag.state === 'exited') continue;

      if (simTimeSec < ag.departureDelaySec) {
        ag.state = 'seated';
        ag.velocity = [0, 0];
        continue;
      }

      const targetWp =
        ag.waypoints[ag.currentWaypointIdx] ??
        ag.waypoints[ag.waypoints.length - 1]!;
      const dx = targetWp[0] - ag.position[0];
      const dz = targetWp[1] - ag.position[1];
      const distToWp = Math.hypot(dx, dz);

      const isFinalExitWp = ag.currentWaypointIdx >= ag.waypoints.length - 1;
      if (distToWp < (isFinalExitWp ? 0.42 : 0.28)) {
        if (isFinalExitWp) {
          if (ag.trappedByWall) {
            // Stop at the wall/parapet/gallery barrier — NEVER phase through walls!
            ag.state = 'queuing';
            ag.velocity = [0, 0];
            continue;
          }
          ag.state = 'exited';
          ag.exitTimeSec = simTimeSec;
          ag.velocity = [0, 0];
          continue;
        } else {
          ag.currentWaypointIdx += 1;
        }
      }

      const nextWp =
        ag.waypoints[ag.currentWaypointIdx] ??
        ag.waypoints[ag.waypoints.length - 1]!;
      const dirX = nextWp[0] - ag.position[0];
      const dirZ = nextWp[1] - ag.position[1];
      const dirLen = Math.hypot(dirX, dirZ) || 1;
      const desiredDirX = dirX / dirLen;
      const desiredDirZ = dirZ / dirLen;

      // Determine whether agent is still extricating from their seat row (before reaching aisle anchor)
      const isExtricating = ag.currentWaypointIdx <= 1 && Math.abs(ag.position[0] - ag.seatPos[0]) < 1.8;
      let targetSpeed = isExtricating ? ag.extricationSpeedMps : ag.baseSpeedMps;

      // Compute social repulsion & queueing slowdown from nearby active agents
      let repulseX = 0;
      let repulseZ = 0;
      let nearbyCrowdCount = 0;

      for (let j = 0; j < agents.length; j++) {
        if (i === j) continue;
        const other = agents[j]!;
        if (other.state === 'exited' || other.state === 'seated') continue;

        const ox = ag.position[0] - other.position[0];
        const oz = ag.position[1] - other.position[1];
        const dist = Math.hypot(ox, oz);
        const minSep = ag.personalRadiusM + other.personalRadiusM + 0.12;

        if (dist < 1.35) {
          nearbyCrowdCount += 1;
        }

        if (dist > 1e-4 && dist < minSep) {
          const overlap = (minSep - dist) / minSep;
          repulseX += (ox / dist) * overlap * 0.85;
          repulseZ += (oz / dist) * overlap * 0.85;

          // If the other agent is ahead of us along our desired direction, slow down (polite/crowd queuing)
          const dotAhead =
            ((other.position[0] - ag.position[0]) * desiredDirX +
              (other.position[1] - ag.position[1]) * desiredDirZ) /
            dist;
          if (dotAhead > 0.35) {
            targetSpeed *= Math.max(0.22, 1.0 - overlap * 0.82);
          }
        }
      }

      // Repulsion from non-own movement-blocking props (e.g. catering table, AV cart, barriers)
      for (const blocker of movementBlockers) {
        if (blocker.ownerObjectId === ag.objectId) continue;
        if (blocker.shape2D.kind === 'obb') {
          const bCenter = blocker.shape2D.obb.center;
          const bRadius =
            Math.hypot(
              blocker.shape2D.obb.widthM,
              blocker.shape2D.obb.depthM,
            ) * 0.5;
          const bx = ag.position[0] - bCenter[0];
          const bz = ag.position[1] - bCenter[1];
          const bDist = Math.hypot(bx, bz);
          const safeDist = bRadius + ag.personalRadiusM;
          if (bDist > 1e-4 && bDist < safeDist) {
            // Only apply obstacle slowdown from movable props or when in aisle
            const obj = objectById.get(blocker.ownerObjectId);
            if (obj?.category === 'movable_prop') {
              const pen = (safeDist - bDist) / safeDist;
              repulseX += (bx / bDist) * pen * 0.9;
              repulseZ += (bz / bDist) * pen * 0.9;
              targetSpeed *= Math.max(0.28, 1.0 - pen * 0.7);
              ag.constrainingObjectIds.push(obj.id);
            }
          }
        }
      }

      // Doorway capacity throttling near the final exit portal
      if (ag.currentWaypointIdx === ag.waypoints.length - 1 && distToWp < 1.6) {
        const portal = resolvedExits.find((e) => e.id === ag.targetExitId);
        const effWidth = portal?.effectiveWidthM ?? 1.2;
        if (effWidth <= 0.1) {
          targetSpeed *= 0.15;
        } else if (nearbyCrowdCount >= 2) {
          const capacityFactor = Math.min(1.0, effWidth / (nearbyCrowdCount * 0.48));
          targetSpeed *= Math.max(0.25, capacityFactor);
        }
      }

      const steerX = desiredDirX + repulseX * 0.45;
      const steerZ = desiredDirZ + repulseZ * 0.45;
      const steerLen = Math.hypot(steerX, steerZ) || 1;

      const vx = (steerX / steerLen) * targetSpeed;
      const vz = (steerZ / steerLen) * targetSpeed;

      const candidatePos: Vec2 = [
        ag.position[0] + vx * dt,
        ag.position[1] + vz * dt,
      ];
      const stepHit = findFirstWallHitOnSegment(
        ag.position,
        candidatePos,
        ag.seatY,
        wallBlockers,
        ag.objectId,
      );
      if (stepHit.blocked) {
        // Hard collision clamp: stop right against the wall/barrier without ever phasing through!
        ag.position = stepHit.stopPoint;
        ag.velocity = [0, 0];
        ag.state = 'queuing';
        ag.trappedByWall = true;
        continue;
      }

      ag.velocity = [vx, vz];
      ag.position = candidatePos;

      // Update facing yaw in degrees (0° faces -Z: atan2(-vx, -vz))
      if (Math.hypot(vx, vz) > 0.05) {
        ag.yawDeg = (Math.atan2(-vx, -vz) * 180) / Math.PI;
      }

      const speedRatio = targetSpeed / Math.max(0.1, ag.baseSpeedMps);
      if (speedRatio < 0.48 || nearbyCrowdCount >= 3) {
        ag.state = 'queuing';
      } else if (isExtricating) {
        ag.state = 'extricating';
      } else {
        ag.state = 'walking';
      }

      const localDensity = Number((nearbyCrowdCount / (Math.PI * 1.35 * 1.35)).toFixed(2));
      if (localDensity > peakCongestionDensity) {
        peakCongestionDensity = localDensity;
      }

      if (ag.state === 'queuing' || (isExtricating && speedRatio < 0.55)) {
        const gx = Math.round(ag.position[0]);
        const gz = Math.round(ag.position[1]);
        const cellKey = `${gx},${gz}`;
        const existing = hotspotCounts.get(cellKey) ?? {
          center: [gx, gz] as Vec2,
          peakCount: 0,
          causeIds: new Set<string>(),
        };
        existing.peakCount = Math.max(existing.peakCount, nearbyCrowdCount + 1);
        for (const cid of ag.constrainingObjectIds) {
          existing.causeIds.add(cid);
        }
        hotspotCounts.set(cellKey, existing);
      }
    }
  }

  const attendeeTimesSec: Record<string, number> = {};
  const jammedAttendeeIds: string[] = [];
  const trappedAttendeeIds: string[] = [];
  let maxExitTimeSec = 0;

  // Safe emergency evacuation threshold scales with roster size:
  // 4-place dev fixture -> 10.5s; 24-place community hall -> 14.5s
  const targetThresholdSec = snapshot.roster.length <= 6 ? 10.5 : 14.5;
  const hasBlockedExit = activeExitCount < totalExitCount;

  for (const ag of agents) {
    const t = ag.exitTimeSec ?? maxSimDurationSec;
    attendeeTimesSec[ag.attendeeId] = Number(t.toFixed(2));
    if (t > maxExitTimeSec) {
      maxExitTimeSec = t;
    }
    if (ag.trappedByWall || ag.state !== 'exited') {
      trappedAttendeeIds.push(ag.attendeeId);
      jammedAttendeeIds.push(ag.attendeeId);
      continue;
    }
    // Flag attendee as jammed if their row is physically bunched/obstructed or an exit door is blocked and they exceed threshold
    const isRowBunched = ag.constrainingObjectIds.length > 0 && ag.extricationSpeedMps < ag.baseSpeedMps * 0.52;
    if (isRowBunched || (hasBlockedExit && t > targetThresholdSec)) {
      jammedAttendeeIds.push(ag.attendeeId);
    }
  }

  const bottleneckZones: EvacuationBottleneckZone[] = Array.from(
    hotspotCounts.values(),
  )
    .filter((h) => h.peakCount >= 2 || h.causeIds.size > 0)
    .sort((a, b) => b.peakCount - a.peakCount)
    .slice(0, 4)
    .map((h) => {
      const causeObjectIds = Array.from(h.causeIds);
      const description =
        causeObjectIds.length > 0
          ? `Congestion hotspot at [${h.center[0].toFixed(1)}, ${h.center[1].toFixed(1)}] (queue=${h.peakCount}) constrained by ${causeObjectIds.join(', ')}.`
          : `Aisle merge queue at [${h.center[0].toFixed(1)}, ${h.center[1].toFixed(1)}] (peak queue=${h.peakCount}).`;
      return {
        center: h.center,
        radiusM: 0.85,
        peakQueueCount: h.peakCount,
        causeObjectIds,
        description,
      };
    });

  const trappedCount = trappedAttendeeIds.length;
  const evacuationImpossibleReason =
    trappedCount > 0
      ? `Evacuation Impossible: ${trappedCount} of ${agents.length} people cannot reach an exit without phasing through walls, parapets, or isolated gallery levels. Run Repair to add reachable exits!`
      : undefined;

  const totalEvacuationTimeSec = Number(maxExitTimeSec.toFixed(2));
  const evacuationPass =
    trappedCount === 0 &&
    totalEvacuationTimeSec <= targetThresholdSec &&
    jammedAttendeeIds.length === 0;

  return {
    mode,
    durationSec: Number(simTimeSec.toFixed(2)),
    totalEvacuationTimeSec,
    targetThresholdSec,
    evacuationPass,
    activeExitCount,
    totalExitCount,
    peakCongestionDensity: Number(peakCongestionDensity.toFixed(2)),
    jammedAttendeeIds,
    trappedCount,
    trappedAttendeeIds,
    evacuationImpossibleReason,
    bottleneckZones,
    attendeeTimesSec,
    frames,
  };
}
