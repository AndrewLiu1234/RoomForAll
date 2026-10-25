/**
 * Stream A — Binary glTF 2.0 (`.glb`) 3D Building Parser & Auto-Labeler (`src/scene/glbAutoLabeler.ts`)
 * Exclusive ownership: Workstream A (`src/scene/`).
 *
 * Parses any binary `.glb` 3D venue/auditorium model, extracts 3D node transforms and
 * mesh bounding boxes, automatically classifies and labels:
 * - Seats (`movable_chair` + `AudiencePlace`)
 * - Wheelchair bays (`wheelchair_bay_frame` + `AudiencePlace`)
 * - Exits / entrances / aisles (`RouteCorridor`)
 * - Stage platform & presentation target screen (`stage` + `PresentationTarget`)
 * - Fixed pillars / walls (`fixed_structure`)
 * - Movable props (`movable_prop`)
 * and produces a complete, evaluator-ready `SceneSnapshot` plus a human-readable
 * `GlbVenueParseReport` for inspection in `VenueViewport`.
 */
import {
  CONTRACT_VERSION,
  DEFAULT_PROFILE_REQUIREMENTS,
  RAD_TO_DEG,
  hashStringDeterministic,
  withUpdatedSceneHash,
  type AudiencePlace,
  type AttendeeAssignment,
  type ChairGroup,
  type ProfileId,
  type RouteCorridor,
  type SceneObject,
  type SceneSnapshot,
  type Vec2,
  type Vec3,
} from '../shared/index.js';
import { parseVenueGlbBinary } from './preparedVenue.js';

export type AutoLabeledNodeRole =
  | 'seat'
  | 'wheelchair_bay'
  | 'exit_or_entrance'
  | 'stage'
  | 'presentation_screen'
  | 'pillar_or_structure'
  | 'movable_prop'
  | 'floor_or_shell';

export interface AutoLabeledGlbNode {
  nodeIndex: number;
  name: string;
  role: AutoLabeledNodeRole;
  positionWorld: Vec3;
  sizeWorld: Vec3;
  yawDeg: number;
}

export interface GlbVenueParseReport {
  fileName: string;
  byteLength: number;
  assetHash: string;
  totalNodes: number;
  roomBounds: { min: Vec3; max: Vec3 };
  counts: {
    seats: number;
    wheelchairBays: number;
    exitsAndEntrances: number;
    stagesAndScreens: number;
    pillarsAndStructures: number;
    movableProps: number;
    shellAndFloor: number;
  };
  labeledNodes: AutoLabeledGlbNode[];
  snapshot: SceneSnapshot;
}

interface RawGlbNode {
  name?: string;
  mesh?: number;
  translation?: [number, number, number];
  rotation?: [number, number, number, number]; // quaternion [x, y, z, w]
  scale?: [number, number, number];
  children?: number[];
  extras?: Record<string, unknown>;
}

interface RawGlbMesh {
  name?: string;
  primitives?: Array<{
    attributes?: Record<string, number>;
  }>;
}

interface RawGlbAccessor {
  min?: number[];
  max?: number[];
}

function quaternionToYawDeg(q?: [number, number, number, number]): number {
  if (!q || q.length !== 4) return 0;
  const [x, y, z, w] = q;
  const sinyCosp = 2 * (w * y + x * z);
  const cosyCosp = 1 - 2 * (y * y + z * z);
  const yawRad = Math.atan2(sinyCosp, cosyCosp);
  const deg = Number((yawRad * RAD_TO_DEG).toFixed(2));
  return Object.is(deg, -0) ? 0 : deg;
}

function classifyNodeRole(
  name: string,
  extras: Record<string, unknown> | undefined,
  pos: Vec3,
  size: Vec3,
): AutoLabeledNodeRole {
  const lower = name.toLowerCase();
  const extraCat =
    typeof extras?.category === 'string' ? extras.category : undefined;

  if (
    lower.includes('floor') ||
    lower.includes('slab') ||
    lower.includes('ceiling') ||
    lower.includes('roof') ||
    lower.includes('shell')
  ) {
    return 'floor_or_shell';
  }
  if (
    lower.includes('exit') ||
    lower.includes('entrance') ||
    lower.includes('door') ||
    lower.includes('egress') ||
    lower.includes('portal')
  ) {
    return 'exit_or_entrance';
  }
  if (
    lower.includes('target') ||
    lower.includes('screen') ||
    lower.includes('projector') ||
    lower.includes('board') ||
    lower.includes('slide')
  ) {
    return 'presentation_screen';
  }
  if (
    extraCat === 'stage' ||
    lower.includes('stage') ||
    lower.includes('podium') ||
    lower.includes('dais') ||
    lower.includes('platform')
  ) {
    return 'stage';
  }
  if (
    extraCat === 'wheelchair_bay_frame' ||
    lower.includes('bay_wc') ||
    lower.includes('wheelchair') ||
    lower.includes('accessible_bay') ||
    lower.includes('ada_bay')
  ) {
    return 'wheelchair_bay';
  }
  if (
    extraCat === 'movable_chair' ||
    lower.includes('chair') ||
    lower.includes('seat') ||
    lower.includes('stool') ||
    lower.includes('pew')
  ) {
    return 'seat';
  }
  if (
    extraCat === 'movable_prop' ||
    lower.includes('prop') ||
    lower.includes('sign') ||
    lower.includes('table') ||
    lower.includes('cart') ||
    lower.includes('stand') ||
    lower.includes('lectern') ||
    lower.includes('easel')
  ) {
    return 'movable_prop';
  }
  if (
    extraCat === 'fixed_structure' ||
    lower.includes('pillar') ||
    lower.includes('column') ||
    lower.includes('wall') ||
    lower.includes('partition') ||
    lower.includes('post')
  ) {
    return 'pillar_or_structure';
  }

  // Geometric heuristic fallback for unnamed/generic CAD nodes:
  // Wide flat slab near Y=0 -> floor
  if (size[0] > 4.0 && size[2] > 4.0 && size[1] < 0.4 && pos[1] <= 0.2) {
    return 'floor_or_shell';
  }
  // Chair-sized object near floor -> seat
  if (
    size[0] >= 0.35 &&
    size[0] <= 0.85 &&
    size[1] >= 0.4 &&
    size[1] <= 1.25 &&
    size[2] >= 0.05 &&
    size[2] <= 0.85
  ) {
    return 'seat';
  }

  return 'pillar_or_structure';
}

/**
 * Parses any binary glTF 2.0 (`.glb`) buffer, auto-labels all architectural, seating,
 * exit, stage, and prop nodes, and constructs a normalized `SceneSnapshot`.
 */
export function parseAndLabelGlbVenue(
  glbBytes: Uint8Array,
  options: { fileName?: string } = {},
): GlbVenueParseReport {
  const fileName = options.fileName ?? 'uploaded-venue.glb';
  const parsed = parseVenueGlbBinary(glbBytes);
  const json = parsed.jsonChunk;

  const rawNodes = Array.isArray(json.nodes)
    ? (json.nodes as RawGlbNode[])
    : [];
  const rawMeshes = Array.isArray(json.meshes)
    ? (json.meshes as RawGlbMesh[])
    : [];
  const rawAccessors = Array.isArray(json.accessors)
    ? (json.accessors as RawGlbAccessor[])
    : [];

  const labeledNodes: AutoLabeledGlbNode[] = [];

  for (let idx = 0; idx < rawNodes.length; idx++) {
    const node = rawNodes[idx]!;
    const name =
      typeof node.name === 'string' && node.name.trim().length > 0
        ? node.name.trim()
        : `node_${idx}`;
    const pos: Vec3 = node.translation
      ? [
          Number(node.translation[0].toFixed(4)),
          Number(node.translation[1].toFixed(4)),
          Number(node.translation[2].toFixed(4)),
        ]
      : [0, 0, 0];
    const scale: Vec3 = node.scale
      ? [
          Math.abs(node.scale[0]),
          Math.abs(node.scale[1]),
          Math.abs(node.scale[2]),
        ]
      : [1, 1, 1];

    // Derive local mesh dimensions from POSITION accessor min/max if available
    let meshSpan: Vec3 = [1, 1, 1];
    if (typeof node.mesh === 'number' && rawMeshes[node.mesh]) {
      const prim = rawMeshes[node.mesh]?.primitives?.[0];
      const posAccIdx = prim?.attributes?.POSITION;
      if (typeof posAccIdx === 'number' && rawAccessors[posAccIdx]) {
        const acc = rawAccessors[posAccIdx]!;
        if (
          Array.isArray(acc.min) &&
          Array.isArray(acc.max) &&
          acc.min.length === 3 &&
          acc.max.length === 3
        ) {
          meshSpan = [
            Math.max(0.02, acc.max[0]! - acc.min[0]!),
            Math.max(0.02, acc.max[1]! - acc.min[1]!),
            Math.max(0.02, acc.max[2]! - acc.min[2]!),
          ];
        }
      }
    }

    const sizeWorld: Vec3 = [
      Number((meshSpan[0] * scale[0]).toFixed(4)),
      Number((meshSpan[1] * scale[1]).toFixed(4)),
      Number((meshSpan[2] * scale[2]).toFixed(4)),
    ];
    const yawDeg = quaternionToYawDeg(node.rotation);
    const role = classifyNodeRole(name, node.extras, pos, sizeWorld);

    labeledNodes.push({
      nodeIndex: idx,
      name,
      role,
      positionWorld: pos,
      sizeWorld,
      yawDeg,
    });
  }

  // Compute overall room bounds from all nodes
  let minX = -6.0;
  let maxX = 6.0;
  let maxY = 4.2;
  let minZ = -7.5;
  let maxZ = 7.0;

  for (const n of labeledNodes) {
    minX = Math.min(minX, n.positionWorld[0] - n.sizeWorld[0] / 2 - 0.5);
    maxX = Math.max(maxX, n.positionWorld[0] + n.sizeWorld[0] / 2 + 0.5);
    maxY = Math.max(maxY, n.positionWorld[1] + n.sizeWorld[1] / 2 + 0.2);
    minZ = Math.min(minZ, n.positionWorld[2] - n.sizeWorld[2] / 2 - 0.5);
    maxZ = Math.max(maxZ, n.positionWorld[2] + n.sizeWorld[2] / 2 + 0.5);
  }

  const roomBounds = {
    min: [Number(minX.toFixed(2)), 0.0, Number(minZ.toFixed(2))] as Vec3,
    max: [
      Number(maxX.toFixed(2)),
      Number(maxY.toFixed(2)),
      Number(maxZ.toFixed(2)),
    ] as Vec3,
  };

  const screenNode = labeledNodes.find((n) => n.role === 'presentation_screen');
  const stageNode = labeledNodes.find((n) => n.role === 'stage');
  const exitNodes = labeledNodes.filter((n) => n.role === 'exit_or_entrance');
  const seatNodes = labeledNodes.filter((n) => n.role === 'seat');
  const bayNodes = labeledNodes.filter((n) => n.role === 'wheelchair_bay');
  const pillarNodes = labeledNodes.filter(
    (n) => n.role === 'pillar_or_structure',
  );
  const propNodes = labeledNodes.filter((n) => n.role === 'movable_prop');
  const shellNodes = labeledNodes.filter((n) => n.role === 'floor_or_shell');

  const objects: SceneObject[] = [];
  const places: AudiencePlace[] = [];

  // Stage object
  if (stageNode) {
    objects.push({
      id: stageNode.name,
      label: `Stage (${stageNode.name})`,
      category: 'stage',
      editable: false,
      transform: {
        position: [stageNode.positionWorld[0], 0.0, stageNode.positionWorld[2]],
        yawDeg: stageNode.yawDeg,
      },
      baselineTransform: {
        position: [stageNode.positionWorld[0], 0.0, stageNode.positionWorld[2]],
        yawDeg: stageNode.yawDeg,
      },
      proxies: [
        {
          id: `proxy_${stageNode.name}_box`,
          kind: 'box',
          localPosition: [0.0, stageNode.sizeWorld[1] / 2, 0.0],
          localYawDeg: 0,
          size: stageNode.sizeWorld,
          blocksVisibility: false,
          blocksMovement: true,
        },
      ],
    });
  }

  // Pillars / fixed structures
  for (const pil of pillarNodes) {
    objects.push({
      id: pil.name,
      label: `Structure (${pil.name})`,
      category: 'fixed_structure',
      editable: false,
      transform: {
        position: [pil.positionWorld[0], 0.0, pil.positionWorld[2]],
        yawDeg: pil.yawDeg,
      },
      baselineTransform: {
        position: [pil.positionWorld[0], 0.0, pil.positionWorld[2]],
        yawDeg: pil.yawDeg,
      },
      proxies: [
        {
          id: `proxy_${pil.name}_cyl`,
          kind: 'cylinder',
          localPosition: [0.0, pil.sizeWorld[1] / 2, 0.0],
          localYawDeg: 0,
          radiusM: Number(
            (Math.max(pil.sizeWorld[0], pil.sizeWorld[2]) / 2).toFixed(4),
          ),
          heightM: pil.sizeWorld[1],
          blocksVisibility: true,
          blocksMovement: true,
        },
      ],
    });
  }

  // Movable props
  for (const prop of propNodes) {
    const blocksVis = prop.sizeWorld[1] >= 1.0;
    objects.push({
      id: prop.name,
      label: `Movable Prop (${prop.name})`,
      category: 'movable_prop',
      editable: true,
      transform: {
        position: [prop.positionWorld[0], 0.0, prop.positionWorld[2]],
        yawDeg: prop.yawDeg,
      },
      baselineTransform: {
        position: [prop.positionWorld[0], 0.0, prop.positionWorld[2]],
        yawDeg: prop.yawDeg,
      },
      allowedBounds: {
        minX: roomBounds.min[0] + 0.5,
        maxX: roomBounds.max[0] - 0.5,
        minZ: roomBounds.min[2] + 1.0,
        maxZ: roomBounds.max[2] - 0.5,
      },
      proxies: [
        {
          id: `proxy_${prop.name}_box`,
          kind: 'box',
          localPosition: [0.0, prop.sizeWorld[1] / 2, 0.0],
          localYawDeg: 0,
          size: prop.sizeWorld,
          blocksVisibility: blocksVis,
          blocksMovement: true,
        },
      ],
    });
  }

  // Primary entrance/exit waypoint
  const entrancePoint: Vec2 =
    exitNodes.length > 0
      ? [exitNodes[0]!.positionWorld[0], exitNodes[0]!.positionWorld[2]]
      : [roomBounds.min[0] + 1.35, roomBounds.max[2] - 0.8];

  const rearCorridorZ = Number((roomBounds.max[2] - 1.65).toFixed(2));
  const routes: RouteCorridor[] = [
    {
      id: 'route_auto_main',
      label:
        exitNodes.length > 0
          ? `Detected Exit/Entrance Route (${exitNodes.map((e) => e.name).join(', ')})`
          : 'Auto-Detected Main Venue Access Corridor',
      waypoints: [
        entrancePoint,
        [entrancePoint[0], rearCorridorZ],
        [Number((roomBounds.max[0] - 2.0).toFixed(2)), rearCorridorZ],
      ],
      widthM: 1.15,
    },
  ];

  // Group seats by Z-row (within 0.4m tolerance)
  const sortedSeats = [...seatNodes].sort((a, b) => {
    if (Math.abs(a.positionWorld[2] - b.positionWorld[2]) > 0.35) {
      return a.positionWorld[2] - b.positionWorld[2];
    }
    return a.positionWorld[0] - b.positionWorld[0];
  });

  const rowBuckets: AutoLabeledGlbNode[][] = [];
  for (const seat of sortedSeats) {
    const existingRow = rowBuckets.find(
      (r) =>
        r.length > 0 &&
        Math.abs(r[0]!.positionWorld[2] - seat.positionWorld[2]) <= 0.35,
    );
    if (existingRow) {
      existingRow.push(seat);
    } else {
      rowBuckets.push([seat]);
    }
  }

  const chairGroups: ChairGroup[] = [];

  rowBuckets.forEach((rowSeats, rIdx) => {
    const rowNum = rIdx + 1;
    const rowZ = rowSeats[0]!.positionWorld[2];
    const aisleZ = Number((rowZ + 0.85).toFixed(2));
    const routeId =
      rIdx === rowBuckets.length - 1
        ? 'route_auto_main'
        : `route_auto_row_${rowNum}`;

    if (routeId !== 'route_auto_main') {
      routes.push({
        id: routeId,
        label: `Row ${rowNum} Cross-Aisle Access`,
        waypoints: [
          entrancePoint,
          [entrancePoint[0], aisleZ],
          [Number((roomBounds.max[0] - 2.5).toFixed(2)), aisleZ],
        ],
        widthM: 0.82,
      });
    }

    const groupId = `group_auto_row_${rowNum}`;
    const memberIds: string[] = [];

    rowSeats.forEach((seat, cIdx) => {
      const colNum = cIdx + 1;
      const objId = seat.name;
      const placeId = objId.startsWith('obj_chair_')
        ? objId.replace('obj_chair_', 'place_chair_')
        : `place_seat_r${rowNum}_c${colNum}`;
      // Note: if seat.translation had localOffsetZ=0.22 baked in GLB node, recover base Z
      const seatZ = Number(
        (
          seat.sizeWorld[2] <= 0.15
            ? seat.positionWorld[2] - 0.22
            : seat.positionWorld[2]
        ).toFixed(4),
      );
      const seatX = seat.positionWorld[0];
      const anchorZ =
        routeId === 'route_auto_main' ? rearCorridorZ : aisleZ;

      memberIds.push(objId);
      objects.push({
        id: objId,
        label: `Row ${rowNum} Seat ${colNum} (${objId})`,
        category: 'movable_chair',
        editable: true,
        groupId,
        transform: { position: [seatX, 0.0, seatZ], yawDeg: seat.yawDeg },
        baselineTransform: {
          position: [seatX, 0.0, seatZ],
          yawDeg: seat.yawDeg,
        },
        proxies: [
          {
            id: `proxy_${objId}_back`,
            kind: 'box',
            localPosition: [0.0, 0.42, 0.22],
            localYawDeg: 0,
            size: [
              Math.max(0.48, Math.min(0.6, seat.sizeWorld[0])),
              Math.max(0.75, Math.min(0.95, seat.sizeWorld[1])),
              0.08,
            ],
            blocksVisibility: true,
            blocksMovement: true,
          },
        ],
      });

      places.push({
        id: placeId,
        label: `Seat R${rowNum}-${colNum}`,
        kind: 'chair',
        objectId: objId,
        seatHeightM: 0.45,
        widthM: 0.6,
        depthM: 0.65,
        isAisle: cIdx === 0 || cIdx === rowSeats.length - 1,
        routeId,
        routeAnchorPoint: [seatX, anchorZ],
      });
    });

    const avgX = Number(
      (
        rowSeats.reduce((acc, s) => acc + s.positionWorld[0], 0) /
        rowSeats.length
      ).toFixed(4),
    );
    chairGroups.push({
      id: groupId,
      label: `Auto-Detected Row ${rowNum} Group`,
      memberObjectIds: memberIds,
      transform: { position: [avgX, 0.0, rowZ], yawDeg: 0 },
      baselineTransform: { position: [avgX, 0.0, rowZ], yawDeg: 0 },
    });
  });

  // Wheelchair bays
  bayNodes.forEach((bay, bIdx) => {
    const objId = bay.name;
    const placeId = objId.startsWith('obj_bay_')
      ? objId.replace('obj_bay_', 'place_bay_')
      : `place_bay_auto_${bIdx + 1}`;
    const bx = bay.positionWorld[0];
    const bz = bay.positionWorld[2];

    objects.push({
      id: objId,
      label: `Accessible Wheelchair Bay ${bIdx + 1} (${objId})`,
      category: 'wheelchair_bay_frame',
      editable: false,
      transform: { position: [bx, 0.0, bz], yawDeg: bay.yawDeg },
      baselineTransform: { position: [bx, 0.0, bz], yawDeg: bay.yawDeg },
      proxies: [],
    });

    places.push({
      id: placeId,
      label: `Wheelchair Bay ${bIdx + 1}`,
      kind: 'wheelchair_bay',
      objectId: objId,
      seatHeightM: 0.0,
      widthM: 0.96,
      depthM: 1.3,
      isAisle: true,
      routeId: 'route_auto_main',
      routeAnchorPoint: [bx, rearCorridorZ],
      turningPadCenter: [bx, Number((bz + 1.1).toFixed(2))],
      turningPadDiameterM: 1.55,
    });
  });

  // Assign a balanced 4-profile attendee roster across all detected places
  const roster: AttendeeAssignment[] = [];
  const chairPlacesList = places.filter((p) => p.kind === 'chair');
  const bayPlacesList = places.filter((p) => p.kind === 'wheelchair_bay');

  let shorterCount = 0;
  let extraLegroomCount = 0;
  let adultCount = 0;

  chairPlacesList.forEach((p, idx) => {
    let profileId: ProfileId = 'reference_adult';
    let attendeeId = '';
    let label = '';

    if (idx === 1 || idx === 2 || (shorterCount < 4 && idx % 6 === 2)) {
      shorterCount++;
      profileId = 'shorter_seated';
      attendeeId = `att_shorter_0${shorterCount}`;
      label = `Shorter Viewer ${shorterCount} (${p.label})`;
    } else if (
      extraLegroomCount < 4 &&
      p.isAisle &&
      (idx === 3 || idx === 4 || idx % 5 === 0)
    ) {
      extraLegroomCount++;
      profileId = 'extra_legroom';
      attendeeId = `att_extra_legroom_0${extraLegroomCount}`;
      label = `Extra-Legroom Attendee ${extraLegroomCount} (${p.label})`;
    } else {
      adultCount++;
      profileId = 'reference_adult';
      attendeeId = `att_adult_${String(adultCount).padStart(2, '0')}`;
      label = `Reference Adult ${adultCount} (${p.label})`;
    }

    roster.push({
      attendeeId,
      label,
      profileId,
      assignedPlaceId: p.id,
    });
  });

  bayPlacesList.forEach((p, idx) => {
    const wcNum = idx + 1;
    roster.push({
      attendeeId: `att_wheelchair_0${wcNum}`,
      label: `Wheelchair User ${wcNum} (${p.label})`,
      profileId: 'wheelchair_user',
      assignedPlaceId: p.id,
    });
  });

  const assetHash = hashStringDeterministic(
    `${fileName}:${glbBytes.byteLength}:${labeledNodes.length}`,
  );

  const snapshot = withUpdatedSceneHash({
    contractVersion: CONTRACT_VERSION,
    sceneId: `glb_parsed_${fileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    source: {
      sourceId: `uploaded_glb_${assetHash}`,
      title: `Auto-Parsed 3D Venue (${fileName})`,
      license: 'CC0-1.0 / User-Provided GLB',
      assetPath: `/venue/${fileName}`,
      assetHash,
      isFallbackFixture: false,
      preparationNotes: `Automatically parsed ${labeledNodes.length} glTF 2.0 nodes: ${seatNodes.length} seats, ${bayNodes.length} wheelchair bays, ${exitNodes.length} exits/entrances, ${propNodes.length} movable props.`,
    },
    roomBounds,
    allowedFloorRegions: [
      {
        minX: Number((roomBounds.min[0] + 0.4).toFixed(2)),
        maxX: Number((roomBounds.max[0] - 0.4).toFixed(2)),
        minZ: Number((roomBounds.min[2] + 1.0).toFixed(2)),
        maxZ: Number((roomBounds.max[2] - 0.4).toFixed(2)),
      },
    ],
    reservedCirculationRegions: [],
    target: screenNode
      ? {
          id: screenNode.name,
          label: `Presentation Target (${screenNode.name})`,
          center: screenNode.positionWorld,
          yawDeg: 180,
          widthM: Math.max(1.6, screenNode.sizeWorld[0]),
          heightM: Math.max(1.0, screenNode.sizeWorld[1]),
        }
      : {
          id: 'target_auto_screen',
          label: 'Auto-Detected Stage Screen',
          center: [0.0, 2.4, Number((roomBounds.min[2] + 1.7).toFixed(2))],
          yawDeg: 180,
          widthM: 2.8,
          heightM: 1.4,
        },
    objects,
    chairGroups,
    places,
    routes,
    profiles: structuredClone(DEFAULT_PROFILE_REQUIREMENTS),
    roster,
  });

  return {
    fileName,
    byteLength: glbBytes.byteLength,
    assetHash,
    totalNodes: labeledNodes.length,
    roomBounds,
    counts: {
      seats: seatNodes.length,
      wheelchairBays: bayNodes.length,
      exitsAndEntrances: exitNodes.length,
      stagesAndScreens: (stageNode ? 1 : 0) + (screenNode ? 1 : 0),
      pillarsAndStructures: pillarNodes.length,
      movableProps: propNodes.length,
      shellAndFloor: shellNodes.length,
    },
    labeledNodes,
    snapshot,
  };
}
