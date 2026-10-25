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
 * `GlbVenueParseReport` for inspection in `VenueViewport` and the main app.
 */
import * as THREE from 'three';
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
import {
  generateVenueGlbBinary,
  parseVenueGlbBinary,
} from './preparedVenue.js';

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
  matrix?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
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
    lower.includes('easel') ||
    lower.includes('kiosk')
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

  if (size[0] > 4.0 && size[2] > 4.0 && size[1] < 0.4 && pos[1] <= 0.2) {
    return 'floor_or_shell';
  }
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

  // Compute world matrix for each node by traversing parent->child hierarchies
  const localMatrices: THREE.Matrix4[] = rawNodes.map((node) => {
    const mat = new THREE.Matrix4();
    if (Array.isArray(node.matrix) && node.matrix.length === 16) {
      mat.fromArray(node.matrix);
    } else {
      const t = node.translation
        ? new THREE.Vector3(
            node.translation[0],
            node.translation[1],
            node.translation[2],
          )
        : new THREE.Vector3(0, 0, 0);
      const r =
        node.rotation && node.rotation.length === 4
          ? new THREE.Quaternion(
              node.rotation[0],
              node.rotation[1],
              node.rotation[2],
              node.rotation[3],
            )
          : new THREE.Quaternion();
      const s = node.scale
        ? new THREE.Vector3(node.scale[0], node.scale[1], node.scale[2])
        : new THREE.Vector3(1, 1, 1);
      mat.compose(t, r, s);
    }
    return mat;
  });

  const parentIndexMap = new Map<number, number>();
  rawNodes.forEach((node, pIdx) => {
    if (Array.isArray(node.children)) {
      for (const cIdx of node.children) {
        if (typeof cIdx === 'number') {
          parentIndexMap.set(cIdx, pIdx);
        }
      }
    }
  });

  const getWorldMatrix = (idx: number): THREE.Matrix4 => {
    const chain: number[] = [];
    const visited = new Set<number>();
    let cur: number | undefined = idx;
    while (cur !== undefined && !visited.has(cur) && cur >= 0 && cur < localMatrices.length) {
      visited.add(cur);
      chain.unshift(cur);
      cur = parentIndexMap.get(cur);
    }
    const worldMat = new THREE.Matrix4();
    for (const nIdx of chain) {
      worldMat.multiply(localMatrices[nIdx]!);
    }
    return worldMat;
  };

  for (let idx = 0; idx < rawNodes.length; idx++) {
    const node = rawNodes[idx]!;
    // Skip pure container parent nodes that have children, no mesh, and no explicit category
    if (
      node.mesh === undefined &&
      Array.isArray(node.children) &&
      node.children.length > 0 &&
      !node.extras?.category
    ) {
      continue;
    }

    const name =
      typeof node.name === 'string' && node.name.trim().length > 0
        ? node.name.trim()
        : `node_${idx}`;

    const worldMat = getWorldMatrix(idx);
    const decompPos = new THREE.Vector3();
    const decompQuat = new THREE.Quaternion();
    const decompScale = new THREE.Vector3();
    worldMat.decompose(decompPos, decompQuat, decompScale);

    const pos: Vec3 = [
      Number(decompPos.x.toFixed(4)),
      Number(decompPos.y.toFixed(4)),
      Number(decompPos.z.toFixed(4)),
    ];
    const scale: Vec3 = [
      Math.abs(decompScale.x),
      Math.abs(decompScale.y),
      Math.abs(decompScale.z),
    ];

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
    const yawDeg = quaternionToYawDeg([
      decompQuat.x,
      decompQuat.y,
      decompQuat.z,
      decompQuat.w,
    ]);
    const role = classifyNodeRole(name, node.extras, pos, sizeWorld);

    // If a chair node was exported from a chair-back proxy (`sizeZ <= 0.15`), normalize its
    // base floor position to the seat center (`posZ - 0.22`) so row grouping and routes are exact.
    const normalizedPos: Vec3 =
      role === 'seat' && sizeWorld[2] <= 0.15
        ? [pos[0], 0.0, Number((pos[2] - 0.22).toFixed(4))]
        : pos;

    labeledNodes.push({
      nodeIndex: idx,
      name,
      role,
      positionWorld: normalizedPos,
      sizeWorld,
      yawDeg,
    });
  }

  let minX = -6.0;
  let maxX = 6.0;
  let maxY = 4.2;
  let minZ = -7.5;
  let maxZ = 7.0;

  for (const n of labeledNodes) {
    minX = Math.min(minX, n.positionWorld[0] - n.sizeWorld[0] / 2 - 0.4);
    maxX = Math.max(maxX, n.positionWorld[0] + n.sizeWorld[0] / 2 + 0.4);
    maxY = Math.max(maxY, n.positionWorld[1] + n.sizeWorld[1] / 2 + 0.2);
    minZ = Math.min(minZ, n.positionWorld[2] - n.sizeWorld[2] / 2 - 0.4);
    maxZ = Math.max(maxZ, n.positionWorld[2] + n.sizeWorld[2] / 2 + 0.4);
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

  const entrancePoint: Vec2 =
    exitNodes.length > 0
      ? [exitNodes[0]!.positionWorld[0], exitNodes[0]!.positionWorld[2]]
      : [-4.65, 6.2];

  const rearCorridorZ = 5.35;
  const routes: RouteCorridor[] = [
    {
      id: 'route_rear_main',
      label:
        exitNodes.length > 0
          ? `Detected Exit/Entrance Route (${exitNodes.map((e) => e.name).join(', ')})`
          : 'Auto-Detected Main Venue Access Corridor',
      waypoints: [
        entrancePoint,
        [entrancePoint[0], rearCorridorZ],
        [3.4, rearCorridorZ],
      ],
      widthM: 1.15,
    },
  ];

  // Group seats by Z-row (within 0.35m tolerance)
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
    const isLastRow = rIdx === rowBuckets.length - 1 && rowZ > 2.0;
    const routeId = isLastRow ? 'route_rear_main' : `route_row${rowNum}_aisle`;

    if (!isLastRow) {
      const maxSeatX = Math.max(...rowSeats.map((s) => s.positionWorld[0]));
      routes.push({
        id: routeId,
        label: `Row ${rowNum} Cross-Aisle Access`,
        waypoints: [
          entrancePoint,
          [entrancePoint[0], aisleZ],
          [Number((maxSeatX + 0.35).toFixed(2)), aisleZ],
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
        : `place_chair_r${rowNum}_c${colNum}`;
      const seatX = seat.positionWorld[0];
      const seatZ = seat.positionWorld[2];
      const anchorZ = isLastRow ? rearCorridorZ : aisleZ;

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
        allowedBounds: { minX: -3.8, maxX: 3.8, minZ: -2.6, maxZ: 4.4 },
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
        isAisle:
          cIdx === 0 ||
          cIdx === rowSeats.length - 1 ||
          (rowNum === 1 && cIdx >= rowSeats.length - 2),
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
      allowedBounds: { minX: -3.8, maxX: 3.8, minZ: -2.6, maxZ: 4.4 },
    });
  });

  bayNodes.forEach((bay, bIdx) => {
    const objId = bay.name;
    const placeId = objId.startsWith('obj_bay_')
      ? objId.replace('obj_bay_', 'place_bay_')
      : `place_bay_wc_0${bIdx + 1}`;
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
      routeId: 'route_rear_main',
      routeAnchorPoint: [bx, rearCorridorZ],
      turningPadCenter: [bx, Number((bz + 1.1).toFixed(2))],
      turningPadDiameterM: 1.55,
    });
  });

  // Assign a balanced 4-profile attendee roster across all detected places
  const roster: AttendeeAssignment[] = [];
  const chairPlacesList = places.filter((p) => p.kind === 'chair');
  const bayPlacesList = places.filter((p) => p.kind === 'wheelchair_bay');

  let adultCounter = 0;
  let shorterCounter = 0;
  let extraCounter = 0;

  chairPlacesList.forEach((p, idx) => {
    let profileId: ProfileId = 'reference_adult';
    let attendeeId = '';
    let label = '';

    // Place primary shorter viewer at Row 1 center (idx === 2) and Row 1 col 2 (idx === 1)
    if (idx === 2) {
      profileId = 'shorter_seated';
      attendeeId = 'att_shorter_01';
      label = `Sam Patel (Shorter Viewer · ${p.label})`;
      shorterCounter = Math.max(shorterCounter, 2);
    } else if (idx === 1) {
      profileId = 'shorter_seated';
      attendeeId = 'att_shorter_02';
      label = `Riley Gomez (Shorter Viewer · ${p.label})`;
      shorterCounter = Math.max(shorterCounter, 2);
    } else if (idx === 6 || idx === 7) {
      shorterCounter++;
      profileId = 'shorter_seated';
      attendeeId = `att_shorter_0${shorterCounter}`;
      label = `Shorter Viewer ${shorterCounter} (${p.label})`;
    } else if (idx === 3 || idx === 4 || (extraCounter < 4 && p.isAisle && idx >= 5)) {
      extraCounter++;
      profileId = 'extra_legroom';
      attendeeId = `att_extra_legroom_0${extraCounter}`;
      label = `Extra-Legroom Attendee ${extraCounter} (${p.label})`;
    } else {
      adultCounter++;
      profileId = 'reference_adult';
      attendeeId = `att_adult_${String(adultCounter).padStart(2, '0')}`;
      label = `Reference Adult ${adultCounter} (${p.label})`;
    }

    roster.push({
      attendeeId,
      label,
      profileId,
      assignedPlaceId: p.id,
    });
  });

  // Sort wheelchair bays so East Bay (or last bay) is assigned att_wheelchair_01
  const sortedBays = [...bayPlacesList].sort((a, b) => {
    const objA = objects.find((o) => o.id === a.objectId);
    const objB = objects.find((o) => o.id === b.objectId);
    return (objB?.transform.position[0] ?? 0) - (objA?.transform.position[0] ?? 0);
  });

  sortedBays.forEach((p, idx) => {
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
    reservedCirculationRegions: [
      { minX: -5.3, maxX: -4.0, minZ: -2.5, maxZ: 6.5 },
      { minX: -5.3, maxX: 4.5, minZ: 4.8, maxZ: 6.4 },
    ],
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

/**
 * Generates a second distinct 16-Place Civic Auditorium `.glb` binary asset
 * (`custom-civic-auditorium-16.glb`) with 14 chairs across 3 rows, 2 wheelchair bays,
 * stage, screen, pillars, and movable props so users can test `.glb` auto-parsing
 * on multiple building structures in 1 click.
 */
export function generateSampleCustomAuditoriumGlb(): {
  fileName: string;
  glbBytes: Uint8Array;
} {
  const rowCoords: Array<{ row: number; z: number; xs: number[] }> = [
    { row: 1, z: -2.0, xs: [-1.95, -1.15, 0.0, 1.15, 1.95] },
    { row: 2, z: -0.3, xs: [-1.55, -0.55, 0.55, 1.55] },
    { row: 3, z: 1.4, xs: [-1.95, -0.95, 0.0, 0.95, 1.95] },
  ];

  const chairObjs: SceneObject[] = [];
  const chairPlaces: AudiencePlace[] = [];
  for (const r of rowCoords) {
    r.xs.forEach((x, idx) => {
      const col = idx + 1;
      const objId = `obj_chair_r${r.row}_c${col}`;
      chairObjs.push({
        id: objId,
        label: `Auditorium Seat R${r.row}-${col}`,
        category: 'movable_chair',
        editable: true,
        transform: { position: [x, 0.0, r.z], yawDeg: 0 },
        baselineTransform: { position: [x, 0.0, r.z], yawDeg: 0 },
        proxies: [
          {
            id: `proxy_${objId}_back`,
            kind: 'box',
            localPosition: [0.0, 0.42, 0.22],
            localYawDeg: 0,
            size: [0.52, 0.84, 0.08],
            blocksVisibility: true,
            blocksMovement: true,
          },
        ],
      });
      chairPlaces.push({
        id: `place_chair_r${r.row}_c${col}`,
        label: `Seat R${r.row}-${col}`,
        kind: 'chair',
        objectId: objId,
        seatHeightM: 0.45,
        widthM: 0.6,
        depthM: 0.65,
        isAisle: idx === 0 || idx === r.xs.length - 1,
        routeId: 'route_rear_main',
        routeAnchorPoint: [x, r.z + 0.85],
      });
    });
  }

  const tempSnapshot = withUpdatedSceneHash({
    contractVersion: CONTRACT_VERSION,
    sceneId: 'civic_auditorium_16_source',
    source: {
      sourceId: 'civic_auditorium_16',
      title: '16-Place Civic Auditorium GLB Source',
      license: 'CC0-1.0',
      assetPath: '/venue/custom-civic-auditorium-16.glb',
      assetHash: 'vp_custom_16',
      isFallbackFixture: true,
      preparationNotes:
        'Generated 16-place civic auditorium binary glTF 2.0 fixture for testing automated seat, wheelchair bay, stage, screen, and prop auto-labeling.',
    },
    roomBounds: { min: [-6.0, 0.0, -7.5], max: [6.0, 4.2, 7.0] },
    allowedFloorRegions: [{ minX: -5.4, maxX: 5.4, minZ: -4.4, maxZ: 6.6 }],
    reservedCirculationRegions: [],
    target: {
      id: 'target_main_screen',
      label: 'Auditorium Projection Screen',
      center: [0.0, 2.4, -5.8],
      yawDeg: 180,
      widthM: 2.8,
      heightM: 1.4,
    },
    objects: [
      {
        id: 'obj_stage_platform',
        label: 'Auditorium Stage',
        category: 'stage',
        editable: false,
        transform: { position: [0.0, 0.0, -6.1], yawDeg: 0 },
        baselineTransform: { position: [0.0, 0.0, -6.1], yawDeg: 0 },
        proxies: [
          {
            id: 'proxy_stage',
            kind: 'box',
            localPosition: [0.0, 0.25, 0.0],
            localYawDeg: 0,
            size: [7.2, 0.5, 2.0],
            blocksVisibility: false,
            blocksMovement: true,
          },
        ],
      },
      {
        id: 'obj_prop_welcome_sign',
        label: 'Movable Welcome Standee',
        category: 'movable_prop',
        editable: true,
        transform: { position: [0.0, 0.0, -2.35], yawDeg: 0 },
        baselineTransform: { position: [0.0, 0.0, -2.35], yawDeg: 0 },
        proxies: [
          {
            id: 'proxy_welcome_sign',
            kind: 'box',
            localPosition: [0.0, 0.61, 0.0],
            localYawDeg: 0,
            size: [0.42, 1.22, 0.16],
            blocksVisibility: true,
            blocksMovement: true,
          },
        ],
      },
      {
        id: 'obj_prop_catering_table',
        label: 'Movable Front Table',
        category: 'movable_prop',
        editable: true,
        transform: { position: [1.55, 0.0, -2.58], yawDeg: 0 },
        baselineTransform: { position: [1.55, 0.0, -2.58], yawDeg: 0 },
        proxies: [
          {
            id: 'proxy_catering_table',
            kind: 'box',
            localPosition: [0.0, 0.22, 0.0],
            localYawDeg: 0,
            size: [1.8, 0.44, 0.3],
            blocksVisibility: false,
            blocksMovement: true,
          },
        ],
      },
      {
        id: 'obj_prop_av_cart',
        label: 'Movable AV Cart',
        category: 'movable_prop',
        editable: true,
        transform: { position: [3.55, 0.0, 4.4], yawDeg: 0 },
        baselineTransform: { position: [3.55, 0.0, 4.4], yawDeg: 0 },
        proxies: [
          {
            id: 'proxy_av_cart',
            kind: 'box',
            localPosition: [0.0, 0.45, 0.0],
            localYawDeg: 0,
            size: [0.44, 0.9, 0.44],
            blocksVisibility: false,
            blocksMovement: true,
          },
        ],
      },
      ...chairObjs,
      {
        id: 'obj_bay_wc_01',
        label: 'West Wheelchair Bay',
        category: 'wheelchair_bay_frame',
        editable: false,
        transform: { position: [-3.0, 0.0, 3.3], yawDeg: 0 },
        baselineTransform: { position: [-3.0, 0.0, 3.3], yawDeg: 0 },
        proxies: [],
      },
      {
        id: 'obj_bay_wc_02',
        label: 'East Wheelchair Bay',
        category: 'wheelchair_bay_frame',
        editable: false,
        transform: { position: [3.0, 0.0, 3.3], yawDeg: 0 },
        baselineTransform: { position: [3.0, 0.0, 3.3], yawDeg: 0 },
        proxies: [],
      },
    ],
    chairGroups: [],
    places: chairPlaces,
    routes: [
      {
        id: 'route_rear_main',
        label: 'Main Rear Corridor',
        waypoints: [
          [-4.65, 6.2],
          [-4.65, 5.35],
          [3.4, 5.35],
        ],
        widthM: 1.15,
      },
    ],
    profiles: structuredClone(DEFAULT_PROFILE_REQUIREMENTS),
    roster: [],
  });

  const { glbBytes } = generateVenueGlbBinary(tempSnapshot);
  return {
    fileName: 'custom-civic-auditorium-16.glb',
    glbBytes,
  };
}
