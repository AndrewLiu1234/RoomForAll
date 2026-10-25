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
  if (snapshot.exits && snapshot.exits.length > 0) {
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

  // For the 24-place community hall (or larger rooms width >= 9m), include the East Secondary Emergency Exit
  if (maxX - minX >= 9.0) {
    portals.push({
      id: 'exit_emergency_east',
      label: 'East Secondary Emergency Exit',
      position: [maxX - 0.65, 3.85],
      widthM: 1.25,
      yawDeg: -90,
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
  state: 'seated' | 'extricating' | 'walking' | 'queuing' | 'exited';
  exitTimeSec?: number;
  constrainingObjectIds: string[];
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
 */
function buildAgentEgressWaypoints(
  seatPos: Vec2,
  place: AudiencePlace,
  snapshot: SceneSnapshot,
  resolvedExits: ResolvedExitPortal[],
): { waypoints: Vec2[]; targetExitId: string } {
  const usableExits = resolvedExits.filter((e) => !e.isBlocked);
  const candidateExits = usableExits.length > 0 ? usableExits : resolvedExits;

  // Choose the exit that minimizes weighted travel distance from routeAnchorPoint
  const anchor = place.routeAnchorPoint;
  let bestExit = candidateExits[0]!;
  let bestScore = Infinity;

  for (const exit of candidateExits) {
    const distFromSeat = Math.hypot(
      exit.position[0] - seatPos[0],
      exit.position[1] - seatPos[1],
    );
    const distFromAnchor = Math.hypot(
      exit.position[0] - anchor[0],
      exit.position[1] - anchor[1],
    );
    // Narrower exits have a small impedance penalty
    const widthPenalty = exit.effectiveWidthM > 0 ? 1.2 / exit.effectiveWidthM : 10;
    const score = (distFromSeat * 0.4 + distFromAnchor * 0.6) * widthPenalty;
    if (score < bestScore) {
      bestScore = score;
      bestExit = exit;
    }
  }

  const waypoints: Vec2[] = [];

  // For uploaded .glb venues with explicit parsed exit points (`snapshot.exits`),
  // route each attendee along their row to the side aisle on the chosen exit's side,
  // and then straight along the side aisle into `[bestExit.position[0], bestExit.position[1]]`.
  if (snapshot.exits && snapshot.exits.length > 0 && !snapshot.source.isFallbackFixture) {
    let nearestExit = candidateExits[0]!;
    let nearestDist = Infinity;
    for (const exit of candidateExits) {
      const d = Math.hypot(
        exit.position[0] - seatPos[0],
        exit.position[1] - seatPos[1],
      );
      if (d < nearestDist) {
        nearestDist = d;
        nearestExit = exit;
      }
    }
    bestExit = nearestExit;

    const sideAisleX =
      bestExit.position[0] < 0
        ? Math.min(seatPos[0] - 0.35, bestExit.position[0] + 0.15)
        : Math.max(seatPos[0] + 0.35, bestExit.position[0] - 0.15);

    waypoints.push([Number(sideAisleX.toFixed(3)), seatPos[1]]);
    waypoints.push([bestExit.position[0], bestExit.position[1]]);
    return { waypoints, targetExitId: bestExit.id };
  }

  // 1. Step forward/backward into the row cross-aisle Z before moving laterally to aisle anchor
  const rowAislePoint: Vec2 = [seatPos[0], anchor[1]];
  if (Math.hypot(rowAislePoint[0] - seatPos[0], rowAislePoint[1] - seatPos[1]) > 0.15) {
    waypoints.push(rowAislePoint);
  }

  // 2. If routing to East Secondary Emergency Exit and seat is on the east side, head toward the east perimeter aisle
  if (bestExit.id === 'exit_emergency_east' && seatPos[0] >= -0.2) {
    const eastAisleX = Math.min(
      snapshot.roomBounds.max[0] - 0.95,
      bestExit.position[0] - 0.45,
    );
    waypoints.push([eastAisleX, anchor[1]]);
    waypoints.push([bestExit.position[0], bestExit.position[1]]);
    return { waypoints, targetExitId: bestExit.id };
  }

  // 3. Standard route via place.routeAnchorPoint and route corridor waypoints
  waypoints.push([anchor[0], anchor[1]]);

  const route = snapshot.routes.find((r) => r.id === place.routeId);
  if (route && route.waypoints.length >= 2) {
    // Route waypoints in SceneSnapshot are ordered from Entrance [0] -> Interior [last].
    // For egress, walk toward waypoint[0] (or toward bestExit).
    const entranceWp = route.waypoints[0]!;
    const midWp: Vec2 = [entranceWp[0], anchor[1]];
    if (Math.hypot(midWp[0] - anchor[0], midWp[1] - anchor[1]) > 0.25) {
      waypoints.push(midWp);
    }
  }

  waypoints.push([bestExit.position[0], bestExit.position[1]]);
  return { waypoints, targetExitId: bestExit.id };
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

    const { waypoints, targetExitId } = buildAgentEgressWaypoints(
      seatPos,
      place,
      snapshot,
      resolvedExits,
    );

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
    if (step % 2 === 0 || step === totalSteps) {
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
        };
      }
      frames.push({ timeSec: simTimeSec, agents: frameAgents });
    }

    // Check if all agents have exited
    if (agents.length > 0 && agents.every((a) => a.state === 'exited')) {
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

      ag.velocity = [vx, vz];
      ag.position = [
        ag.position[0] + vx * dt,
        ag.position[1] + vz * dt,
      ];

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

  const totalEvacuationTimeSec = Number(maxExitTimeSec.toFixed(2));
  const evacuationPass =
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
    bottleneckZones,
    attendeeTimesSec,
    frames,
  };
}
