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

/**
 * Builds the deterministic waypoint chain from an attendee's seat to the optimal active exit portal.
 * In a tiered auditorium:
 * - Attendees extricate by stepping forward onto their SAME level platform (never stepping backward onto a higher tier).
 * - They walk laterally along their tier platform to the outside aisle ramp corridor.
 * - If on the elevated rear wheelchair terrace, wheelchair users evacuate directly through the terrace emergency exit.
 * - Otherwise, attendees safely descend along the outside ramps to the front floor exits (never jumping down).
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
  // verify that an exit is on a connected vertical level (`|seatY - exitY| <= 0.95m`)
  // AND has a 2D path that does NOT phase through any wall, parapet, or object!
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

    let bestBlockedAttempt: {
      waypoints: Vec2[];
      targetExitId: string;
      blockerId?: string;
      remainingDistToExit: number;
    } | null = null;

    // Step 0.32m out of the chair into the clear row cross-aisle so the person never walks through neighboring chairs
    const rowStepZ = Number((seatPos[1] - 0.32).toFixed(3));

    for (const exit of sortedByDist) {
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
          return {
            waypoints: check.truncatedWaypoints,
            targetExitId: exit.id,
            trappedByWall: false,
          };
        }

        // If blocked, compute how close this attempt gets the person to the nearest exit before stopping at the barrier
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

    // No exit can be reached without phasing through a wall/parapet or jumping off a gallery:
    // navigate as close as physically possible to the nearest exit and stop!
    return {
      waypoints: bestBlockedAttempt?.waypoints ?? [[seatPos[0], seatPos[1]]],
      targetExitId: bestBlockedAttempt?.targetExitId ?? sortedByDist[0]!.id,
      trappedByWall: true,
      blockingWallId: bestBlockedAttempt?.blockerId ?? 'wall_barrier',
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
 * Synthesizes new reachable `VenueExitPortal`s for any attendees (or seating tiers)
 * that cannot reach an existing exit without phasing through walls, parapets, or elevation drops.
 */
export function synthesizeReachableExitsForSnapshot(
  snapshot: SceneSnapshot,
): VenueExitPortal[] {
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
  const workingExits: VenueExitPortal[] = snapshot.exits
    ? structuredClone(snapshot.exits)
    : [];
  const addedExits: VenueExitPortal[] = [];

  // Inspect all occupied seats first, plus representative seats from each elevation tier
  const candidatePlaces: AudiencePlace[] = [];
  for (const member of snapshot.roster) {
    const p = placeById.get(member.assignedPlaceId);
    if (p) candidatePlaces.push(p);
  }
  const seenTierKeys = new Set<string>();
  for (const p of snapshot.places) {
    const obj = objectById.get(p.objectId);
    if (!obj) continue;
    const tierKey = `${Math.round(obj.transform.position[1])}:${Math.round(obj.transform.position[2] / 6)}`;
    if (!seenTierKeys.has(tierKey)) {
      seenTierKeys.add(tierKey);
      candidatePlaces.push(p);
    }
  }

  for (const place of candidatePlaces) {
    const obj = objectById.get(place.objectId);
    if (!obj) continue;
    const seatPos: Vec2 = [
      obj.transform.position[0],
      obj.transform.position[2],
    ];
    const seatY = obj.transform.position[1];

    const resolvedCurrent = resolveActiveExitPortals(
      { ...snapshot, exits: workingExits },
      movementBlockers,
    );
    const check = buildAgentEgressWaypoints(
      seatPos,
      seatY,
      place,
      { ...snapshot, exits: workingExits },
      resolvedCurrent,
      wallBlockers,
    );

    const lastWp =
      check.waypoints[check.waypoints.length - 1] ?? seatPos;
    const distToExit = Math.hypot(
      lastWp[0] - seatPos[0],
      lastWp[1] - seatPos[1],
    );
    if (!check.trappedByWall && distToExit <= 6.0) {
      continue;
    }

    // Place the new reachable exit in the clear row/aisle corridor (stepped 0.32m out into the row cross-aisle and laterally toward the nearest side aisle)
    const aisleZ = Number((seatPos[1] - 0.32).toFixed(2));
    const candidateDirs: Array<-1 | 1> =
      seatPos[0] <= 0 ? [-1, 1] : [1, -1];
    let chosenExitPos: Vec2 = [
      Number((seatPos[0] + 1.4).toFixed(2)),
      aisleZ,
    ];
    let chosenDir: -1 | 1 = candidateDirs[0]!;
    let bestClearDist = -1;

    for (const dSign of candidateDirs) {
      const targetX =
        dSign < 0
          ? Math.max(snapshot.roomBounds.min[0] + 1.2, seatPos[0] - 2.0)
          : Math.min(snapshot.roomBounds.max[0] - 1.2, seatPos[0] + 2.0);

      const hit = findFirstWallHitOnSegment(
        [seatPos[0], aisleZ],
        [targetX, aisleZ],
        seatY,
        wallBlockers,
        place.objectId,
      );

      const candidatePt: Vec2 = hit.blocked
        ? [
            Number((hit.stopPoint[0] - dSign * 0.25).toFixed(2)),
            aisleZ,
          ]
        : [Number(targetX.toFixed(2)), aisleZ];

      const verify = checkWaypointChainWallFree(
        seatPos,
        [[seatPos[0], aisleZ], candidatePt],
        seatY,
        wallBlockers,
        place.objectId,
      );
      const dist = Math.hypot(
        candidatePt[0] - seatPos[0],
        candidatePt[1] - seatPos[1],
      );
      if (verify.clear && dist > bestClearDist) {
        bestClearDist = dist;
        chosenExitPos = candidatePt;
        chosenDir = dSign;
      }
    }

    const exitPos: Vec2 = chosenExitPos;
    const dirSign = chosenDir;

    // Avoid duplicate exits within 2.2m on the same elevation tier so nearby people share the same reasonable aisle exit
    const alreadyExists = workingExits.some(
      (e) =>
        Math.hypot(e.position[0] - exitPos[0], e.position[1] - exitPos[1]) <
          2.2 && Math.abs((e.elevationM ?? 0) - seatY) <= 0.85,
    );
    if (alreadyExists) continue;

    const exitIdx = addedExits.length + 1;
    const newPortal: VenueExitPortal = {
      id: `exit_repaired_${exitIdx}`,
      label: `Added Aisle Exit ${exitIdx} (Tier Y=${seatY.toFixed(1)}m)`,
      position: exitPos,
      elevationM: Number(seatY.toFixed(2)),
      widthM: 1.4,
      yawDeg: dirSign < 0 ? 90 : -90,
      isEmergencyExit: true,
    };

    workingExits.push(newPortal);
    addedExits.push(newPortal);
  }

  return addedExits;
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
