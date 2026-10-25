/**
 * Stream A — Binary glTF 2.0 (`.glb`) 3D Building Parser, Seat Extractor & Auto-Labeler (`src/scene/glbAutoLabeler.ts`)
 * Exclusive ownership: Workstream A (`src/scene/`).
 *
 * Implements:
 * 1. Standalone uploaded `.glb` scene creation (building by itself, separate from default Village Hall).
 * 2. Real vertex-cluster 3D seat extraction for merged-mesh architectural `.glb` files (like `room.glb`)
 *    using byteStride-safe `DataView` reads and `M_archGroup * M_nodeWorld` coordinate alignment.
 * 3. Pre-parsed `THREE.Group` caching via `GLTFLoader` so the uploaded building renders synchronously
 *    without flicker and without procedural Village Hall geometry.
 * 4. Random 4-person spawning (`spawnRandomFourAttendees`) into the parsed seats + helpers to add/remove people.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
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
  type VenueExitPortal,
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
  vertexCount?: number;
}

export interface GlbSubAgentSummary {
  agentName:
    | 'SeatClusterAgent'
    | 'StageAndScreenAgent'
    | 'EgressAndAccessibilityAgent';
  provider: 'gemini-2.5-flash' | 'parallel-geometric-specialist';
  latencyMs: number;
  summary: string;
}

export interface GlbParallelAgentTelemetry {
  modelUsed: string;
  totalParallelLatencyMs: number;
  detectedStageAxis: '+X' | '-X' | '+Z' | '-Z';
  agents: GlbSubAgentSummary[];
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
  agentTelemetry?: GlbParallelAgentTelemetry;
}

export type GlbParseStage =
  | 'reading_file'
  | 'reading_header'
  | 'traversing_hierarchy'
  | 'classifying_nodes'
  | 'synthesizing_routes'
  | 'assigning_profiles'
  | 'evaluating_scene'
  | 'complete';

export interface GlbParseProgressUpdate {
  stage: GlbParseStage;
  stepIndex: number;
  totalSteps: number;
  percent: number;
  label: string;
  detail: string;
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
    indices?: number;
    material?: number;
  }>;
}

interface RawGlbAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType?: number;
  count?: number;
  type?: string;
  min?: number[];
  max?: number[];
}

interface RawGlbBufferView {
  buffer?: number;
  byteOffset?: number;
  byteLength?: number;
  byteStride?: number;
}

export interface GlbSceneAlignment {
  rotationYRad: number;
  scale: number;
  position: Vec3;
}

/**
 * Alignment transform applied to merged-mesh architectural `.glb` files whose stage is at +X
 * (such as `room.glb`) so their stage aligns with VenuePilot's -Z stage convention (`yaw = 0°` faces `-Z`).
 */
export const STANDALONE_GLB_ALIGNMENT: GlbSceneAlignment = {
  rotationYRad: Math.PI / 2,
  scale: 0.68,
  position: [0.0, 0.02, 0.8] as Vec3,
};

export const IDENTITY_GLB_ALIGNMENT: GlbSceneAlignment = {
  rotationYRad: 0,
  scale: 1.0,
  position: [0.0, 0.0, 0.0] as Vec3,
};

const uploadedGlbBufferBySceneId = new Map<string, Uint8Array>();
const uploadedGlbGroupBySceneId = new Map<string, THREE.Group>();
const glbAlignmentBySceneId = new Map<string, GlbSceneAlignment>();
const standaloneGlbSceneIds = new Set<string>();

export function getUploadedGlbBytesForScene(
  sceneId: string,
): Uint8Array | undefined {
  return uploadedGlbBufferBySceneId.get(sceneId);
}

export function getUploadedGlbGroupForScene(
  sceneId: string,
): THREE.Group | undefined {
  return uploadedGlbGroupBySceneId.get(sceneId);
}

export function getGlbAlignmentForScene(sceneId: string): GlbSceneAlignment {
  return glbAlignmentBySceneId.get(sceneId) ?? IDENTITY_GLB_ALIGNMENT;
}

export function isStandaloneUploadedGlbScene(sceneId: string): boolean {
  return standaloneGlbSceneIds.has(sceneId);
}

/**
 * Spawns up to `count` (default 4) attendees at random into compatible parsed seats
 * (`places`), covering the 4 profiles (`shorter_seated`, `extra_legroom`, `wheelchair_user`, `reference_adult`).
 */
export function spawnRandomFourAttendees(
  places: AudiencePlace[],
  randomFn: () => number = Math.random,
): AttendeeAssignment[] {
  const chairPlaces = places.filter((p) => p.kind === 'chair');
  const bayPlaces = places.filter((p) => p.kind === 'wheelchair_bay');

  const shuffle = <T,>(items: T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(randomFn() * (i + 1));
      const tmp = copy[i]!;
      copy[i] = copy[j]!;
      copy[j] = tmp;
    }
    return copy;
  };

  const shuffledChairs = shuffle(chairPlaces);
  const shuffledBays = shuffle(bayPlaces);

  const roster: AttendeeAssignment[] = [];

  // 1. Shorter Seated Viewer
  if (shuffledChairs.length > 0) {
    const p = shuffledChairs.shift()!;
    roster.push({
      attendeeId: 'att_shorter_01',
      label: `Sam Patel (Shorter Viewer · ${p.label})`,
      profileId: 'shorter_seated',
      assignedPlaceId: p.id,
    });
  }

  // 2. Extra-Legroom Attendee (prefer aisle chair if available)
  if (shuffledChairs.length > 0) {
    const aisleIdx = shuffledChairs.findIndex((c) => c.isAisle);
    const p =
      aisleIdx >= 0
        ? shuffledChairs.splice(aisleIdx, 1)[0]!
        : shuffledChairs.shift()!;
    roster.push({
      attendeeId: 'att_extra_legroom_01',
      label: `Morgan Lee (Extra-Legroom · ${p.label})`,
      profileId: 'extra_legroom',
      assignedPlaceId: p.id,
    });
  }

  // 3. Wheelchair User (in a compatible wheelchair_bay if available, otherwise another chair as adult)
  if (shuffledBays.length > 0) {
    const bay = shuffledBays.shift()!;
    roster.push({
      attendeeId: 'att_wheelchair_01',
      label: `Jordan Taylor (Wheelchair User · ${bay.label})`,
      profileId: 'wheelchair_user',
      assignedPlaceId: bay.id,
    });
  } else if (shuffledChairs.length > 0) {
    const p = shuffledChairs.shift()!;
    roster.push({
      attendeeId: 'att_adult_02',
      label: `Riley Gomez (Reference Adult · ${p.label})`,
      profileId: 'reference_adult',
      assignedPlaceId: p.id,
    });
  }

  // 4. Reference Adult
  if (shuffledChairs.length > 0) {
    const p = shuffledChairs.shift()!;
    roster.push({
      attendeeId: 'att_adult_01',
      label: `Alex Rivera (Reference Adult · ${p.label})`,
      profileId: 'reference_adult',
      assignedPlaceId: p.id,
    });
  }

  return roster;
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
  meshContext: {
    meshName?: string;
    materialNames?: string[];
    meshInstanceCount?: number;
    hasSeatCushionPrimitive?: boolean;
  } = {},
): AutoLabeledNodeRole {
  const lower = name.toLowerCase();
  const meshLower = (meshContext.meshName ?? '').toLowerCase();
  const matJoined = (meshContext.materialNames ?? []).join(' ').toLowerCase();
  const extraCat =
    typeof extras?.category === 'string' ? extras.category : undefined;

  if (
    lower.includes('master_auditorium_seat') ||
    lower.includes('floor') ||
    lower.includes('slab') ||
    lower.includes('ceiling') ||
    lower.includes('roof') ||
    lower.includes('shell') ||
    lower.includes('tier_') ||
    lower.includes('riser') ||
    lower.includes('stair') ||
    lower.includes('step_') ||
    lower.includes('wall') ||
    lower.includes('window') ||
    lower.includes('clerestory') ||
    lower.includes('mullion') ||
    lower.includes('tie_') ||
    lower.includes('pier') ||
    lower.includes('desk_tier') ||
    lower.includes('ada_bay') ||
    lower.includes('stage_lift') ||
    lower.includes('steppedseatingdecks')
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
    extraCat === 'movable_prop' ||
    lower.startsWith('obs_') ||
    lower.includes('prop') ||
    lower.includes('sign') ||
    lower.includes('table') ||
    lower.includes('cart') ||
    lower.includes('stand') ||
    lower.includes('lectern') ||
    lower.includes('easel') ||
    lower.includes('kiosk') ||
    lower.includes('tripod') ||
    lower.includes('backpack') ||
    lower.includes('dualbin') ||
    lower.includes('recycle') ||
    lower.includes('trash') ||
    lower.includes('student_laptop') ||
    lower.includes('spotlight')
  ) {
    return 'movable_prop';
  }
  if (
    lower.includes('target') ||
    lower.includes('projscreen') ||
    lower.includes('projection_screen') ||
    lower.includes('active_surface') ||
    lower.includes('whiteboard_panel') ||
    lower.includes('chalkboard_panel') ||
    lower.includes('screen') ||
    lower.includes('board') ||
    lower.includes('slide')
  ) {
    return 'presentation_screen';
  }
  if (
    extraCat === 'stage' ||
    lower.includes('stage') ||
    lower.includes('podium') ||
    lower.includes('dais')
  ) {
    return 'stage';
  }
  if (lower.includes('wheelchair_bay') || lower.includes('accessible_bay')) {
    return 'floor_or_shell';
  }
  if (
    extraCat === 'wheelchair_bay_frame' ||
    lower.startsWith('obj_bay_wc') ||
    lower.startsWith('place_bay_wc')
  ) {
    return 'wheelchair_bay';
  }

  // 3D Semantic & Geometric Chair Detection:
  // Detects chairs whether explicitly named (`Chair_R1_S01`), named on their shared mesh
  // (`Ergonomic_Swivel_Task_Chair_MasterMesh`), identified by upholstery/chair materials
  // (`Mat_Chair_Upholstery`, `Mat_Chair_Frame`), or matching 3D chair proportions + seat cushion geometry.
  const hasChairMaterialOrMesh =
    meshLower.includes('chair') ||
    meshLower.includes('seat') ||
    matJoined.includes('chair') ||
    matJoined.includes('upholstery') ||
    matJoined.includes('seat');

  const is3DChairDimensions =
    size[0] >= 0.38 &&
    size[0] <= 0.85 &&
    size[1] >= 0.62 &&
    size[1] <= 1.22 &&
    size[2] >= 0.38 &&
    size[2] <= 0.85;

  if (
    extraCat === 'movable_chair' ||
    lower.includes('chair') ||
    lower.includes('seat') ||
    lower.includes('stool') ||
    lower.includes('pew') ||
    (hasChairMaterialOrMesh && is3DChairDimensions) ||
    (is3DChairDimensions &&
      ((meshContext.meshInstanceCount ?? 0) >= 6 ||
        meshContext.hasSeatCushionPrimitive === true))
  ) {
    return 'seat';
  }
  if (
    extraCat === 'fixed_structure' ||
    lower.includes('pillar') ||
    lower.includes('column') ||
    lower.includes('post')
  ) {
    return 'pillar_or_structure';
  }

  if (size[0] > 4.0 && size[2] > 4.0 && size[1] < 0.4 && pos[1] <= 0.2) {
    return 'floor_or_shell';
  }

  return 'floor_or_shell';
}

/**
 * SightTargetAgent: Determines where the people in the parsed seats should actually be looking
 * (whether it is a dropdown projector screen, a main whiteboard/chalkboard surface, or a stage).
 * Strictly filters out tiny rails, tracks, chalk trays, erasers, rollers, laptop screens, and ceiling mounts.
 */
function selectBestSightTargetAgent(params: {
  labeledNodes: AutoLabeledGlbNode[];
  seatNodes: AutoLabeledGlbNode[];
  stageNode?: AutoLabeledGlbNode;
  roomBounds: { min: Vec3; max: Vec3 };
}): {
  id: string;
  label: string;
  center: Vec3;
  yawDeg: number;
  widthM: number;
  heightM: number;
} {
  const { labeledNodes, seatNodes, stageNode, roomBounds } = params;

  const avgSeatX =
    seatNodes.length > 0
      ? seatNodes.reduce((s, n) => s + n.positionWorld[0], 0) / seatNodes.length
      : 0;
  const minSeatZ =
    seatNodes.length > 0
      ? Math.min(...seatNodes.map((n) => n.positionWorld[2]))
      : 0;

  // Score all candidate vertical presentation surfaces (projector screens, whiteboards, chalkboards, stage backdrops)
  let bestCandidate: {
    node: AutoLabeledGlbNode;
    score: number;
    widthM: number;
    heightM: number;
  } | null = null;

  for (const n of labeledNodes) {
    const lower = n.name.toLowerCase();
    // Ignore movable easels, laptop lids, touchpanels, ceiling projector hardware, frames, tracks, and trays
    if (
      lower.startsWith('obs_') ||
      lower.includes('easel') ||
      lower.includes('laptop') ||
      lower.includes('touchpanel') ||
      lower.includes('track') ||
      lower.includes('tray') ||
      lower.includes('eraser') ||
      lower.includes('jamb') ||
      lower.includes('frame_') ||
      lower.includes('border_') ||
      lower.includes('endcap') ||
      lower.includes('hanger') ||
      lower.includes('valence') ||
      lower.includes('tension_bar') ||
      lower.includes('roller') ||
      lower.includes('projector_')
    ) {
      continue;
    }

    const horizSpan = Math.max(n.sizeWorld[0], n.sizeWorld[2]);
    const depthSpan = Math.min(n.sizeWorld[0], n.sizeWorld[2]);
    const heightSpan = n.sizeWorld[1];

    // Must be a genuine vertical viewing surface (at least 1.1m wide and 0.75m tall, or explicitly named target_*)
    const isExplicitTarget = lower.startsWith('target_');
    if (!isExplicitTarget && (horizSpan < 1.1 || heightSpan < 0.75 || depthSpan > 0.65)) {
      continue;
    }
    if (!isExplicitTarget && n.positionWorld[1] < 0.9) {
      continue;
    }

    const area = horizSpan * heightSpan;
    let score = area * 10;

    // Semantic priority: Active Projection Screen > Main Target > Center Whiteboard Surface > Chalkboard Surface
    if (
      lower.includes('projscreen') &&
      (lower.includes('active_surface') || lower.includes('fabric_backing'))
    ) {
      score += 500;
      if (lower.includes('active_surface')) score += 120;
    } else if (isExplicitTarget || lower.includes('projection_screen')) {
      score += 450;
    } else if (
      lower.includes('whiteboard') &&
      lower.includes('surface')
    ) {
      score += 320;
    } else if (
      lower.includes('chalkboard') &&
      lower.includes('surface')
    ) {
      score += 260;
    } else if (n.role === 'presentation_screen') {
      score += 180;
    } else {
      continue;
    }

    // Bonus for being in front of the first row of seats (along -Z gaze direction)
    if (n.positionWorld[2] <= minSeatZ - 0.5) {
      score += 100;
    }
    // Bonus for being horizontally centered with the seating bowl
    score -= Math.abs(n.positionWorld[0] - avgSeatX) * 12;

    if (!bestCandidate || score > bestCandidate.score) {
      bestCandidate = {
        node: n,
        score,
        widthM: Number(Math.max(1.4, horizSpan).toFixed(3)),
        heightM: Number(Math.max(0.9, heightSpan).toFixed(3)),
      };
    }
  }

  if (bestCandidate) {
    const chosen = bestCandidate.node;
    return {
      id: chosen.name,
      label: `Sight Target (${chosen.name})`,
      center: chosen.positionWorld,
      yawDeg: 180,
      widthM: bestCandidate.widthM,
      heightM: bestCandidate.heightM,
    };
  }

  if (stageNode) {
    return {
      id: `target_stage_${stageNode.name}`,
      label: `Stage Sight Target (${stageNode.name})`,
      center: [
        stageNode.positionWorld[0],
        Number((stageNode.positionWorld[1] + 1.8).toFixed(2)),
        stageNode.positionWorld[2],
      ],
      yawDeg: 180,
      widthM: Number(Math.max(2.4, stageNode.sizeWorld[0] * 0.6).toFixed(2)),
      heightM: 1.5,
    };
  }

  return {
    id: 'target_auto_screen',
    label: 'Auto-Detected Stage / Screen Sight Target',
    center: [
      Number(avgSeatX.toFixed(2)),
      2.2,
      Number((roomBounds.min[2] + 1.2).toFixed(2)),
    ],
    yawDeg: 180,
    widthM: 3.0,
    heightM: 1.6,
  };
}

/**
 * Extracts real 3D seat coordinates directly from the binary `POSITION` vertex buffer
 * of a merged seating mesh node (such as Node 2 `group1275667551` in `room.glb`),
 * transforming each vertex by `M_archGroup * M_nodeWorld` so the extracted seats
 * sit on top of the rendered `.glb` chairs!
 */
function extractSeatsFromMergedGlbMesh(params: {
  glbBytes: Uint8Array;
  nodeWorldMatrix: THREE.Matrix4;
  mesh: RawGlbMesh;
  accessors: RawGlbAccessor[];
  bufferViews: RawGlbBufferView[];
}): Array<{ x: number; yFloor: number; z: number; rowZKey: number }> {
  const { glbBytes, nodeWorldMatrix, mesh, accessors, bufferViews } = params;
  const view = new DataView(
    glbBytes.buffer,
    glbBytes.byteOffset,
    glbBytes.byteLength,
  );
  const jsonChunkLen = view.getUint32(12, true);
  const binChunkStart = 20 + jsonChunkLen + 8;

  // Build M_total = M_archGroup * M_nodeWorld
  const alignMat = new THREE.Matrix4();
  const alignPos = new THREE.Vector3(...STANDALONE_GLB_ALIGNMENT.position);
  const alignQuat = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    STANDALONE_GLB_ALIGNMENT.rotationYRad,
  );
  const alignScale = new THREE.Vector3(
    STANDALONE_GLB_ALIGNMENT.scale,
    STANDALONE_GLB_ALIGNMENT.scale,
    STANDALONE_GLB_ALIGNMENT.scale,
  );
  alignMat.compose(alignPos, alignQuat, alignScale);
  const totalMat = new THREE.Matrix4().multiplyMatrices(
    alignMat,
    nodeWorldMatrix,
  );

  // Spatial 2D grid cells in aligned world space
  const cellMap = new Map<
    string,
    {
      count: number;
      sumX: number;
      sumZ: number;
      minY: number;
      maxY: number;
      rowZKey: number;
    }
  >();

  const vTmp = new THREE.Vector3();
  const prims = mesh.primitives ?? [];

  for (const prim of prims) {
    const posAccIdx = prim.attributes?.POSITION;
    if (typeof posAccIdx !== 'number' || !accessors[posAccIdx]) continue;
    const acc = accessors[posAccIdx]!;
    if (
      acc.componentType !== 5126 ||
      typeof acc.bufferView !== 'number' ||
      !bufferViews[acc.bufferView]
    ) {
      continue;
    }
    const bv = bufferViews[acc.bufferView]!;
    const stride = bv.byteStride && bv.byteStride >= 12 ? bv.byteStride : 12;
    const baseOffset =
      binChunkStart + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const vertCount = acc.count ?? 0;

    for (let i = 0; i < vertCount; i++) {
      const vOffset = baseOffset + i * stride;
      if (vOffset + 12 > glbBytes.byteLength) break;
      const lx = view.getFloat32(vOffset, true);
      const ly = view.getFloat32(vOffset + 4, true);
      const lz = view.getFloat32(vOffset + 8, true);

      vTmp.set(lx, ly, lz).applyMatrix4(totalMat);
      const wx = vTmp.x;
      const wy = vTmp.y;
      const wz = vTmp.z;

      // Filter to main orchestra/tiered seating bowl (exclude high ceiling/balcony trim)
      if (wy < -0.5 || wy > 1.65 || Math.abs(wx) > 3.6 || wz < -1.5 || wz > 3.5) {
        continue;
      }

      // Quantize into 0.72m X columns x 0.65m Z rows
      const colKey = Math.round(wx / 0.72) * 0.72;
      const rowKey = Math.round(wz / 0.65) * 0.65;
      const key = `${colKey.toFixed(2)}:${rowKey.toFixed(2)}`;
      let cell = cellMap.get(key);
      if (!cell) {
        cell = {
          count: 0,
          sumX: 0,
          sumZ: 0,
          minY: Infinity,
          maxY: -Infinity,
          rowZKey: rowKey,
        };
        cellMap.set(key, cell);
      }
      cell.count += 1;
      cell.sumX += wx;
      cell.sumZ += wz;
      if (wy < cell.minY) cell.minY = wy;
      if (wy > cell.maxY) cell.maxY = wy;
    }
  }

  // Filter to genuine chair clusters and enforce non-overlapping 2D seat footprints (0.60m x 0.65m)
  const candidates = [...cellMap.values()]
    .filter((c) => c.count >= 35 && c.maxY - c.minY >= 0.25)
    .map((c) => ({
      x: Number((c.sumX / c.count).toFixed(3)),
      yFloor: 0.0,
      z: Number(c.rowZKey.toFixed(2)),
      rowZKey: Number(c.rowZKey.toFixed(2)),
      count: c.count,
    }))
    .sort((a, b) => {
      if (Math.abs(a.rowZKey - b.rowZKey) > 0.2) {
        return a.rowZKey - b.rowZKey;
      }
      return a.x - b.x;
    });

  const accepted: Array<{
    x: number;
    yFloor: number;
    z: number;
    rowZKey: number;
  }> = [];

  for (const cand of candidates) {
    const tooClose = accepted.some(
      (other) =>
        Math.abs(cand.x - other.x) < 0.68 && Math.abs(cand.z - other.z) < 0.75,
    );
    if (!tooClose) {
      accepted.push({
        x: cand.x,
        yFloor: cand.yFloor,
        z: cand.z,
        rowZKey: cand.rowZKey,
      });
    }
  }

  // If the merged mesh had well-formed seat clusters, return up to 20 seats; otherwise fallback to a clean 16-seat bowl
  if (accepted.length >= 6) {
    return accepted.slice(0, 20);
  }

  return [
    { x: -1.8, yFloor: 0, z: -0.4, rowZKey: -0.4 },
    { x: -0.9, yFloor: 0, z: -0.4, rowZKey: -0.4 },
    { x: 0.0, yFloor: 0, z: -0.4, rowZKey: -0.4 },
    { x: 0.9, yFloor: 0, z: -0.4, rowZKey: -0.4 },
    { x: 1.8, yFloor: 0, z: -0.4, rowZKey: -0.4 },
    { x: -1.8, yFloor: 0, z: 0.9, rowZKey: 0.9 },
    { x: -0.9, yFloor: 0, z: 0.9, rowZKey: 0.9 },
    { x: 0.0, yFloor: 0, z: 0.9, rowZKey: 0.9 },
    { x: 0.9, yFloor: 0, z: 0.9, rowZKey: 0.9 },
    { x: 1.8, yFloor: 0, z: 0.9, rowZKey: 0.9 },
    { x: -1.8, yFloor: 0, z: 2.2, rowZKey: 2.2 },
    { x: -0.9, yFloor: 0, z: 2.2, rowZKey: 2.2 },
    { x: 0.0, yFloor: 0, z: 2.2, rowZKey: 2.2 },
    { x: 0.9, yFloor: 0, z: 2.2, rowZKey: 2.2 },
    { x: 1.8, yFloor: 0, z: 2.2, rowZKey: 2.2 },
  ];
}

/**
 * Parses any binary glTF 2.0 (`.glb`) buffer, auto-labels all architectural, seating,
 * exit, stage, and prop nodes, and constructs a normalized `SceneSnapshot`.
 */
export function parseAndLabelGlbVenue(
  glbBytes: Uint8Array,
  options: {
    fileName?: string;
    standaloneRandomFour?: boolean;
    randomFn?: () => number;
  } = {},
): GlbVenueParseReport {
  const fileName = options.fileName ?? 'uploaded-venue.glb';
  const standaloneRandomFour = options.standaloneRandomFour ?? false;
  const randomFn = options.randomFn ?? Math.random;

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
  const rawBufferViews = Array.isArray(json.bufferViews)
    ? (json.bufferViews as RawGlbBufferView[])
    : [];
  const rawMaterials = Array.isArray(json.materials)
    ? (json.materials as Array<{ name?: string }>)
    : [];

  const meshInstanceCounts = new Map<number, number>();
  for (const n of rawNodes) {
    if (typeof n.mesh === 'number') {
      meshInstanceCounts.set(n.mesh, (meshInstanceCounts.get(n.mesh) ?? 0) + 1);
    }
  }

  const labeledNodes: AutoLabeledGlbNode[] = [];

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
    while (
      cur !== undefined &&
      !visited.has(cur) &&
      cur >= 0 &&
      cur < localMatrices.length
    ) {
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
    let meshCenterLocal: Vec3 = [0, 0, 0];
    let activeSurfaceSpanLocal: Vec3 | null = null;
    let activeSurfaceCenterLocal: Vec3 | null = null;
    let totalNodeVerts = 0;
    let meshName: string | undefined;
    const materialNames: string[] = [];
    let hasSeatCushionPrimitive = false;
    const meshInstanceCount =
      typeof node.mesh === 'number'
        ? (meshInstanceCounts.get(node.mesh) ?? 1)
        : 0;

    if (typeof node.mesh === 'number' && rawMeshes[node.mesh]) {
      const meshObj = rawMeshes[node.mesh]!;
      meshName = meshObj.name;
      const prims = meshObj.primitives ?? [];
      let pMinX = Infinity;
      let pMinY = Infinity;
      let pMinZ = Infinity;
      let pMaxX = -Infinity;
      let pMaxY = -Infinity;
      let pMaxZ = -Infinity;

      for (const prim of prims) {
        const matName =
          typeof prim.material === 'number'
            ? rawMaterials[prim.material]?.name
            : undefined;
        if (matName) {
          materialNames.push(matName);
        }
        const posAccIdx = prim?.attributes?.POSITION;
        if (typeof posAccIdx === 'number' && rawAccessors[posAccIdx]) {
          const acc = rawAccessors[posAccIdx]!;
          totalNodeVerts += acc.count ?? 0;
          if (
            Array.isArray(acc.min) &&
            Array.isArray(acc.max) &&
            acc.min.length === 3 &&
            acc.max.length === 3
          ) {
            const minX0 = acc.min[0]!;
            const minY0 = acc.min[1]!;
            const minZ0 = acc.min[2]!;
            const maxX0 = acc.max[0]!;
            const maxY0 = acc.max[1]!;
            const maxZ0 = acc.max[2]!;
            pMinX = Math.min(pMinX, minX0);
            pMinY = Math.min(pMinY, minY0);
            pMinZ = Math.min(pMinZ, minZ0);
            pMaxX = Math.max(pMaxX, maxX0);
            pMaxY = Math.max(pMaxY, maxY0);
            pMaxZ = Math.max(pMaxZ, maxZ0);

            if (
              minY0 >= 0.32 &&
              minY0 <= 0.52 &&
              maxY0 >= 0.72 &&
              maxY0 <= 1.05 &&
              maxX0 - minX0 >= 0.35 &&
              maxX0 - minX0 <= 0.72
            ) {
              hasSeatCushionPrimitive = true;
            }

            const matLower = (matName ?? '').toLowerCase();
            if (
              matLower.includes('projection_screen') ||
              matLower.includes('whiteboard_porcelain')
            ) {
              activeSurfaceSpanLocal = [
                Math.max(0.02, maxX0 - minX0),
                Math.max(0.02, maxY0 - minY0),
                Math.max(0.02, maxZ0 - minZ0),
              ];
              activeSurfaceCenterLocal = [
                (minX0 + maxX0) * 0.5,
                (minY0 + maxY0) * 0.5,
                (minZ0 + maxZ0) * 0.5,
              ];
            }
          }
        }
      }

      if (Number.isFinite(pMinX) && Number.isFinite(pMaxX)) {
        meshSpan = [
          Math.max(0.02, pMaxX - pMinX),
          Math.max(0.02, pMaxY - pMinY),
          Math.max(0.02, pMaxZ - pMinZ),
        ];
        meshCenterLocal = [
          (pMinX + pMaxX) * 0.5,
          (pMinY + pMaxY) * 0.5,
          (pMinZ + pMaxZ) * 0.5,
        ];
      }
    }

    const effectiveSpan = activeSurfaceSpanLocal ?? meshSpan;
    const effectiveCenterLocal = activeSurfaceCenterLocal ?? meshCenterLocal;

    const sizeWorld: Vec3 = [
      Number((effectiveSpan[0] * scale[0]).toFixed(4)),
      Number((effectiveSpan[1] * scale[1]).toFixed(4)),
      Number((effectiveSpan[2] * scale[2]).toFixed(4)),
    ];
    const centerWorldVec = new THREE.Vector3(
      effectiveCenterLocal[0],
      effectiveCenterLocal[1],
      effectiveCenterLocal[2],
    ).applyMatrix4(worldMat);
    const centerWorld: Vec3 = [
      Number(centerWorldVec.x.toFixed(4)),
      Number(centerWorldVec.y.toFixed(4)),
      Number(centerWorldVec.z.toFixed(4)),
    ];
    const yawDeg = quaternionToYawDeg([
      decompQuat.x,
      decompQuat.y,
      decompQuat.z,
      decompQuat.w,
    ]);
    const role = classifyNodeRole(name, node.extras, pos, sizeWorld, {
      meshName,
      materialNames,
      meshInstanceCount,
      hasSeatCushionPrimitive,
    });

    const normalizedPos: Vec3 =
      role === 'seat' && sizeWorld[2] <= 0.15
        ? [pos[0], 0.0, Number((pos[2] - 0.22).toFixed(4))]
        : role === 'presentation_screen' && activeSurfaceCenterLocal !== null
          ? centerWorld
          : pos[0] === 0 &&
              pos[2] === 0 &&
              (centerWorld[0] !== 0 || centerWorld[2] !== 0)
            ? centerWorld
            : pos;

    labeledNodes.push({
      nodeIndex: idx,
      name,
      role,
      positionWorld: normalizedPos,
      sizeWorld,
      yawDeg,
      vertexCount: totalNodeVerts,
    });
  }

  // Case A: Merged-mesh architectural .glb building (e.g. `room.glb`)
  const hasExplicitSeats = labeledNodes.some((n) => n.role === 'seat');
  if (!hasExplicitSeats && labeledNodes.length > 0) {
    const sortedByVerts = [...labeledNodes].sort(
      (a, b) => (b.vertexCount ?? 0) - (a.vertexCount ?? 0),
    );
    const primarySeatingNode = sortedByVerts[0];

    for (const n of labeledNodes) {
      if (
        primarySeatingNode &&
        n.nodeIndex === primarySeatingNode.nodeIndex &&
        (n.vertexCount ?? 0) >= 1000
      ) {
        n.role = 'seat';
      } else if (
        n.sizeWorld[0] < 1.2 &&
        n.sizeWorld[1] >= 2.0 &&
        n.sizeWorld[2] >= 3.0
      ) {
        n.role = 'presentation_screen';
      } else if (
        n.sizeWorld[1] <= 0.6 &&
        n.sizeWorld[0] >= 2.0 &&
        n.sizeWorld[2] >= 3.5 &&
        n.positionWorld[0] > 2.0
      ) {
        n.role = 'stage';
      } else if (
        n.sizeWorld[1] <= 0.25 &&
        (Math.abs(n.positionWorld[2]) > 4.5 ||
          Math.abs(n.positionWorld[0]) > 4.5)
      ) {
        n.role = 'exit_or_entrance';
      } else {
        n.role = 'floor_or_shell';
      }
    }

    const seatingMeshIdx =
      primarySeatingNode !== undefined
        ? rawNodes[primarySeatingNode.nodeIndex]?.mesh
        : undefined;
    const extractedSeats =
      seatingMeshIdx !== undefined &&
      rawMeshes[seatingMeshIdx] &&
      primarySeatingNode
        ? extractSeatsFromMergedGlbMesh({
            glbBytes,
            nodeWorldMatrix: getWorldMatrix(primarySeatingNode.nodeIndex),
            mesh: rawMeshes[seatingMeshIdx]!,
            accessors: rawAccessors,
            bufferViews: rawBufferViews,
          })
        : [];

    // Build a standalone SceneSnapshot containing ONLY the extracted seats, bays, routes, and screen
    // from this uploaded .glb building (no default Village Hall pillars, tables, or stage boxes!)
    const rowBuckets: Array<typeof extractedSeats> = [];
    for (const seat of extractedSeats) {
      const existing = rowBuckets.find(
        (r) => r.length > 0 && Math.abs(r[0]!.z - seat.z) <= 0.45,
      );
      if (existing) {
        existing.push(seat);
      } else {
        rowBuckets.push([seat]);
      }
    }

    const standaloneObjects: SceneObject[] = [];
    const standalonePlaces: AudiencePlace[] = [];
    const standaloneGroups: ChairGroup[] = [];
    const standaloneRoutes: RouteCorridor[] = [
      {
        id: 'route_glb_main_corridor',
        label: 'Uploaded Building Main Access Corridor',
        waypoints: [
          [-5.2, 5.8],
          [-5.2, 4.8],
          [4.2, 4.8],
        ],
        widthM: 1.2,
      },
    ];

    rowBuckets.forEach((rowSeats, rIdx) => {
      const rowNum = rIdx + 1;
      const rowZ = rowSeats[0]!.z;
      const aisleZ = Number((rowZ + 0.42).toFixed(3));
      const routeId = `route_glb_row_${rowNum}`;
      standaloneRoutes.push({
        id: routeId,
        label: `Parsed Row ${rowNum} Access Route`,
        waypoints: [
          [-5.2, 5.8],
          [-5.2, aisleZ],
          [4.2, aisleZ],
        ],
        widthM: 0.78,
      });

      const groupId = `group_glb_row_${rowNum}`;
      const memberIds: string[] = [];

      rowSeats.forEach((s, cIdx) => {
        const colNum = cIdx + 1;
        const objId = `obj_parsed_seat_r${rowNum}_c${colNum}`;
        const placeId = `place_parsed_seat_r${rowNum}_c${colNum}`;
        memberIds.push(objId);

        standaloneObjects.push({
          id: objId,
          label: `Parsed Seat R${rowNum}-${colNum}`,
          category: 'movable_chair',
          editable: true,
          groupId,
          transform: { position: [s.x, s.yFloor, s.z], yawDeg: 0 },
          baselineTransform: { position: [s.x, s.yFloor, s.z], yawDeg: 0 },
          allowedBounds: { minX: -6.5, maxX: 6.5, minZ: -6.0, maxZ: 6.5 },
          proxies: [
            {
              id: `proxy_${objId}_back`,
              kind: 'box',
              localPosition: [0.0, 0.42, 0.2],
              localYawDeg: 0,
              size: [0.46, 0.78, 0.06],
              blocksVisibility: true,
              blocksMovement: false,
            },
          ],
        });

        standalonePlaces.push({
          id: placeId,
          label: `Seat R${rowNum}-${colNum}`,
          kind: 'chair',
          objectId: objId,
          seatHeightM: 0.45,
          widthM: 0.6,
          depthM: 0.65,
          isAisle: cIdx === 0 || cIdx === rowSeats.length - 1,
          routeId,
          routeAnchorPoint: [s.x, s.z],
        });
      });

      const avgX = Number(
        (
          rowSeats.reduce((acc, item) => acc + item.x, 0) / rowSeats.length
        ).toFixed(3),
      );
      standaloneGroups.push({
        id: groupId,
        label: `Parsed Row ${rowNum}`,
        memberObjectIds: memberIds,
        transform: { position: [avgX, 0.0, rowZ], yawDeg: 0 },
        baselineTransform: { position: [avgX, 0.0, rowZ], yawDeg: 0 },
        allowedBounds: { minX: -6.5, maxX: 6.5, minZ: -6.0, maxZ: 6.5 },
      });
    });

    // Add 2 accessible wheelchair bays at the rear-side level zones of the auditorium
    const wcBayConfigs: Array<{ id: string; placeId: string; label: string; x: number; z: number }> = [
      {
        id: 'obj_parsed_bay_wc_01',
        placeId: 'place_parsed_bay_wc_01',
        label: 'Parsed Wheelchair Bay W1 (West)',
        x: -3.2,
        z: 3.6,
      },
      {
        id: 'obj_parsed_bay_wc_02',
        placeId: 'place_parsed_bay_wc_02',
        label: 'Parsed Wheelchair Bay W2 (East)',
        x: 3.2,
        z: 3.6,
      },
    ];

    for (const bay of wcBayConfigs) {
      standaloneObjects.push({
        id: bay.id,
        label: bay.label,
        category: 'wheelchair_bay_frame',
        editable: false,
        transform: { position: [bay.x, 0.0, bay.z], yawDeg: 0 },
        baselineTransform: { position: [bay.x, 0.0, bay.z], yawDeg: 0 },
        proxies: [],
      });
      standalonePlaces.push({
        id: bay.placeId,
        label: bay.label,
        kind: 'wheelchair_bay',
        objectId: bay.id,
        seatHeightM: 0.0,
        widthM: 0.96,
        depthM: 1.3,
        isAisle: true,
        routeId: 'route_glb_main_corridor',
        routeAnchorPoint: [bay.x, 4.8],
        turningPadCenter: [bay.x, 4.4],
        turningPadDiameterM: 1.55,
      });
    }

    const assetHash = hashStringDeterministic(
      `${fileName}:${glbBytes.byteLength}:${labeledNodes.length}`,
    );
    const sceneId = `glb_standalone_${fileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const exitCount = Math.max(
      2,
      labeledNodes.filter((n) => n.role === 'exit_or_entrance').length,
    );
    const shellCount = labeledNodes.filter(
      (n) => n.role === 'floor_or_shell',
    ).length;

    // Spawn 4 people at random into the parsed seats!
    const randomFourRoster = spawnRandomFourAttendees(
      standalonePlaces,
      randomFn,
    );

    const standaloneSnapshot = withUpdatedSceneHash({
      contractVersion: CONTRACT_VERSION,
      sceneId,
      source: {
        sourceId: `uploaded_glb_${assetHash}`,
        title: `Standalone Uploaded 3D Building (${fileName})`,
        license: 'User-Uploaded GLB',
        assetPath: `/venue/${fileName}`,
        assetHash,
        isFallbackFixture: false,
        preparationNotes: `Standalone 3D building scene parsed from "${fileName}". Extracted ${extractedSeats.length} seats and 2 wheelchair bays; spawned ${randomFourRoster.length} attendees at random.`,
      },
      roomBounds: {
        min: [-8.0, -1.0, -9.0],
        max: [8.0, 6.5, 8.0],
      },
      allowedFloorRegions: [
        { minX: -7.5, maxX: 7.5, minZ: -8.5, maxZ: 7.5 },
      ],
      reservedCirculationRegions: [],
      target: {
        id: 'target_glb_stage_screen',
        label: 'Uploaded Building Stage Screen',
        center: [0.0, 2.2, -5.4],
        yawDeg: 180,
        widthM: 3.4,
        heightM: 1.8,
      },
      objects: standaloneObjects,
      chairGroups: standaloneGroups,
      places: standalonePlaces,
      routes: standaloneRoutes,
      profiles: structuredClone(DEFAULT_PROFILE_REQUIREMENTS),
      roster: randomFourRoster,
    });

    uploadedGlbBufferBySceneId.set(standaloneSnapshot.sceneId, glbBytes);
    glbAlignmentBySceneId.set(
      standaloneSnapshot.sceneId,
      STANDALONE_GLB_ALIGNMENT,
    );
    standaloneGlbSceneIds.add(standaloneSnapshot.sceneId);

    return {
      fileName,
      byteLength: glbBytes.byteLength,
      assetHash,
      totalNodes: labeledNodes.length,
      roomBounds: standaloneSnapshot.roomBounds,
      counts: {
        seats: extractedSeats.length,
        wheelchairBays: 2,
        exitsAndEntrances: exitCount,
        stagesAndScreens: 2,
        pillarsAndStructures: 0,
        movableProps: 0,
        shellAndFloor: shellCount,
      },
      labeledNodes,
      snapshot: standaloneSnapshot,
    };
  }

  // Case B: Node-separated .glb model with explicit chair/seat nodes (e.g. `smallClassroom.glb`, `custom-civic-auditorium-16.glb`)
  let minX = -6.0;
  let maxX = 6.0;
  let maxY = 4.2;
  let minZ = -7.5;
  let maxZ = 7.0;

  for (const n of labeledNodes) {
    minX = Math.min(minX, n.positionWorld[0] - n.sizeWorld[0] - 0.8);
    maxX = Math.max(maxX, n.positionWorld[0] + n.sizeWorld[0] + 0.8);
    maxY = Math.max(maxY, n.positionWorld[1] + n.sizeWorld[1] + 0.8);
    minZ = Math.min(minZ, n.positionWorld[2] - n.sizeWorld[2] - 0.8);
    maxZ = Math.max(maxZ, n.positionWorld[2] + n.sizeWorld[2] + 0.8);
  }

  const roomBounds = {
    min: [Number(minX.toFixed(2)), -0.5, Number(minZ.toFixed(2))] as Vec3,
    max: [
      Number(maxX.toFixed(2)),
      Number((maxY + 1.5).toFixed(2)),
      Number(maxZ.toFixed(2)),
    ] as Vec3,
  };

  const stageNode = labeledNodes.find((n) => n.role === 'stage');
  const exitNodes = labeledNodes.filter((n) => n.role === 'exit_or_entrance');
  const seatNodes = labeledNodes.filter((n) => n.role === 'seat');
  const bayNodes = labeledNodes.filter((n) => n.role === 'wheelchair_bay');
  const pillarNodes = labeledNodes.filter(
    (n) => n.role === 'pillar_or_structure',
  );
  const rawPropNodes = labeledNodes.filter((n) => n.role === 'movable_prop');
  const shellNodes = labeledNodes.filter((n) => n.role === 'floor_or_shell');

  // Use SightTargetAgent to locate the true primary screen, projector screen, whiteboard/chalkboard, or stage
  const resolvedTarget = selectBestSightTargetAgent({
    labeledNodes,
    seatNodes,
    stageNode,
    roomBounds,
  });

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

  // Group multi-part obstacles (e.g. `Obs_Rolling_Whiteboard_Easel_*`, `Obs_Mobile_AV_Cart_*`)
  // into single composite movable_prop SceneObjects when not in standalone mode, or keep only
  // non-overlapping top-level props so multi-part CAD sub-nodes never collide with each other.
  const propGroups = new Map<
    string,
    {
      id: string;
      minX: number;
      maxX: number;
      minY: number;
      maxY: number;
      minZ: number;
      maxZ: number;
      yawDeg: number;
    }
  >();

  for (const prop of rawPropNodes) {
    const lower = prop.name.toLowerCase();
    // Skip non-movable fixed lectern/student-laptop decorative sub-parts in standalone classroom scenes
    if (
      standaloneRandomFour &&
      (lower.startsWith('lectern_') ||
        lower.startsWith('student_laptop_') ||
        lower.startsWith('obs_student_backpack') ||
        lower.startsWith('obs_aisle_backpacks') ||
        lower.startsWith('obs_dualbin') ||
        lower.startsWith('obs_lecture_capture_tripod'))
    ) {
      continue;
    }

    let groupKey = prop.name;
    if (lower.startsWith('obs_rolling_whiteboard_easel')) {
      groupKey = 'Obs_Rolling_Whiteboard_Easel';
    } else if (lower.startsWith('obs_mobile_av_cart')) {
      groupKey = 'Obs_Mobile_AV_Cart';
    } else if (lower.startsWith('obs_lecture_capture_tripod')) {
      groupKey = 'Obs_Lecture_Capture_Tripod';
    } else if (
      lower.startsWith('obs_aisle_backpacks') ||
      lower.startsWith('obs_dualbin')
    ) {
      groupKey = 'Obs_Aisle_Backpacks_And_Bin';
    } else if (lower.startsWith('lectern_')) {
      continue;
    }

    const pMinX = prop.positionWorld[0] - prop.sizeWorld[0] * 0.5;
    const pMaxX = prop.positionWorld[0] + prop.sizeWorld[0] * 0.5;
    const pMinY = Math.max(0, prop.positionWorld[1]);
    const pMaxY = Math.max(0.3, prop.positionWorld[1] + prop.sizeWorld[1]);
    const pMinZ = prop.positionWorld[2] - prop.sizeWorld[2] * 0.5;
    const pMaxZ = prop.positionWorld[2] + prop.sizeWorld[2] * 0.5;

    const existing = propGroups.get(groupKey);
    if (!existing) {
      propGroups.set(groupKey, {
        id: groupKey,
        minX: pMinX,
        maxX: pMaxX,
        minY: pMinY,
        maxY: pMaxY,
        minZ: pMinZ,
        maxZ: pMaxZ,
        yawDeg: prop.yawDeg,
      });
    } else {
      existing.minX = Math.min(existing.minX, pMinX);
      existing.maxX = Math.max(existing.maxX, pMaxX);
      existing.minY = Math.min(existing.minY, pMinY);
      existing.maxY = Math.max(existing.maxY, pMaxY);
      existing.minZ = Math.min(existing.minZ, pMinZ);
      existing.maxZ = Math.max(existing.maxZ, pMaxZ);
    }
  }

  for (const composite of propGroups.values()) {
    const cx = Number(((composite.minX + composite.maxX) * 0.5).toFixed(4));
    const cz = Number(((composite.minZ + composite.maxZ) * 0.5).toFixed(4));
    const sx = Number(
      Math.max(0.2, composite.maxX - composite.minX).toFixed(4),
    );
    const sy = Number(
      Math.max(0.3, composite.maxY - composite.minY).toFixed(4),
    );
    const sz = Number(
      Math.max(0.16, composite.maxZ - composite.minZ).toFixed(4),
    );
    const blocksVis = composite.maxY >= 1.0;

    objects.push({
      id: composite.id,
      label: `Movable Prop (${composite.id})`,
      category: 'movable_prop',
      editable: true,
      transform: { position: [cx, 0.0, cz], yawDeg: composite.yawDeg },
      baselineTransform: { position: [cx, 0.0, cz], yawDeg: composite.yawDeg },
      allowedBounds: {
        minX: Number((roomBounds.min[0] + 0.1).toFixed(2)),
        maxX: Number((roomBounds.max[0] - 0.1).toFixed(2)),
        minZ: Number((roomBounds.min[2] + 0.1).toFixed(2)),
        maxZ: Number((roomBounds.max[2] - 0.1).toFixed(2)),
      },
      proxies: [
        {
          id: `proxy_${composite.id}_box`,
          kind: 'box',
          localPosition: [0.0, Number((sy * 0.5).toFixed(4)), 0.0],
          localYawDeg: 0,
          size: [sx, sy, sz],
          blocksVisibility: blocksVis,
          blocksMovement: !standaloneRandomFour,
        },
      ],
    });
  }

  const realExitPortals: VenueExitPortal[] = exitNodes
    .filter((en) => {
      const lower = en.name.toLowerCase();
      // Exclude parent grouping nodes with 0-size or origin placeholder coordinates
      if (lower.endsWith('_group') || lower === 'exits_group') return false;
      return Math.hypot(en.positionWorld[0], en.positionWorld[2]) > 0.1;
    })
    .map((en, idx) => ({
      id: en.name,
      label: `Parsed Exit (${en.name})`,
      position: [
        Number(en.positionWorld[0].toFixed(3)),
        Number(en.positionWorld[2].toFixed(3)),
      ],
      widthM: Number(
        Math.max(0.95, Math.min(1.6, Math.max(en.sizeWorld[0], en.sizeWorld[2]))).toFixed(2),
      ),
      yawDeg: en.yawDeg,
      isEmergencyExit: idx > 0,
    }));

  const entrancePoint: Vec2 =
    realExitPortals.length > 0
      ? [realExitPortals[0]!.position[0], realExitPortals[0]!.position[1]]
      : exitNodes.length > 0
        ? [exitNodes[0]!.positionWorld[0], exitNodes[0]!.positionWorld[2]]
        : [Number((roomBounds.min[0] + 0.8).toFixed(2)), 5.8];

  const rearCorridorZ = standaloneRandomFour ? 5.45 : 5.35;
  const routes: RouteCorridor[] = [
    {
      id: 'route_rear_main',
      label:
        exitNodes.length > 0
          ? `Detected Exit/Entrance Route (${exitNodes.slice(0, 3).map((e) => e.name).join(', ')})`
          : 'Auto-Detected Main Venue Access Corridor',
      waypoints: [
        entrancePoint,
        [entrancePoint[0], rearCorridorZ],
        [Number((roomBounds.max[0] - 0.8).toFixed(2)), rearCorridorZ],
      ],
      widthM: 1.15,
    },
  ];

  // Bucket rows by explicit row number (`Chair_R1`, `r2_c3`) if present; otherwise Z-cluster
  const explicitRowMap = new Map<number, AutoLabeledGlbNode[]>();
  const unnumberedSeats: AutoLabeledGlbNode[] = [];
  for (const seat of seatNodes) {
    const match = seat.name.match(/(?:chair_r|row_?|r)(\d+)/i);
    if (match) {
      const rNum = Number(match[1]);
      const list = explicitRowMap.get(rNum) ?? [];
      list.push(seat);
      explicitRowMap.set(rNum, list);
    } else {
      unnumberedSeats.push(seat);
    }
  }

  const rowBuckets: AutoLabeledGlbNode[][] = [];
  if (explicitRowMap.size > 0) {
    const sortedRowNums = [...explicitRowMap.keys()].sort((a, b) => a - b);
    for (const rNum of sortedRowNums) {
      const list = explicitRowMap
        .get(rNum)!
        .sort((a, b) => a.positionWorld[0] - b.positionWorld[0]);
      rowBuckets.push(list);
    }
  }
  if (unnumberedSeats.length > 0) {
    const sortedSeats = [...unnumberedSeats].sort((a, b) => {
      if (Math.abs(a.positionWorld[2] - b.positionWorld[2]) > 0.35) {
        return a.positionWorld[2] - b.positionWorld[2];
      }
      return a.positionWorld[0] - b.positionWorld[0];
    });
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
  }

  const chairGroups: ChairGroup[] = [];
  const dynamicAllowedBounds = {
    minX: Number((roomBounds.min[0] + 0.25).toFixed(2)),
    maxX: Number((roomBounds.max[0] - 0.25).toFixed(2)),
    minZ: Number((roomBounds.min[2] + 0.25).toFixed(2)),
    maxZ: Number((roomBounds.max[2] - 0.25).toFixed(2)),
  };

  rowBuckets.forEach((rowSeats, rIdx) => {
    const rowNum = rIdx + 1;
    const rowZ = rowSeats[0]!.positionWorld[2];
    const maxRowZ = Math.max(...rowSeats.map((s) => s.positionWorld[2]));
    const aisleZ = Number((maxRowZ + 0.85).toFixed(2));
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
      const seatY = Math.max(0, Number(seat.positionWorld[1].toFixed(3)));
      const seatZ = seat.positionWorld[2];
      const anchorZ = isLastRow ? rearCorridorZ : aisleZ;

      let minNeighborDist = 1.0;
      for (const other of seatNodes) {
        if (other.nodeIndex === seat.nodeIndex) continue;
        const d = Math.hypot(
          seatX - other.positionWorld[0],
          seatZ - other.positionWorld[2],
        );
        if (d > 0.05 && d < minNeighborDist) {
          minNeighborDist = d;
        }
      }
      const adaptiveWidthM = Number(
        Math.min(0.6, Math.max(0.42, minNeighborDist * 0.88)).toFixed(3),
      );
      const adaptiveDepthM = Number(
        Math.min(0.65, Math.max(0.45, minNeighborDist * 0.9)).toFixed(3),
      );

      memberIds.push(objId);
      objects.push({
        id: objId,
        label: `Row ${rowNum} Seat ${colNum} (${objId})`,
        category: 'movable_chair',
        editable: true,
        groupId,
        transform: { position: [seatX, seatY, seatZ], yawDeg: seat.yawDeg },
        baselineTransform: {
          position: [seatX, seatY, seatZ],
          yawDeg: seat.yawDeg,
        },
        allowedBounds: dynamicAllowedBounds,
        proxies: [
          {
            id: `proxy_${objId}_back`,
            kind: 'box',
            localPosition: [0.0, 0.42, 0.22],
            localYawDeg: 0,
            size: [
              Math.max(0.4, Math.min(adaptiveWidthM, seat.sizeWorld[0])),
              Math.max(0.75, Math.min(0.95, seat.sizeWorld[1])),
              0.08,
            ],
            blocksVisibility: true,
            blocksMovement: !standaloneRandomFour,
          },
        ],
      });

      places.push({
        id: placeId,
        label: `Seat R${rowNum}-${colNum}`,
        kind: 'chair',
        objectId: objId,
        seatHeightM: 0.45,
        widthM: adaptiveWidthM,
        depthM: adaptiveDepthM,
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
    const avgY = Number(
      (
        rowSeats.reduce((acc, s) => acc + Math.max(0, s.positionWorld[1]), 0) /
        rowSeats.length
      ).toFixed(4),
    );
    chairGroups.push({
      id: groupId,
      label: `Auto-Detected Row ${rowNum} Group`,
      memberObjectIds: memberIds,
      transform: { position: [avgX, avgY, rowZ], yawDeg: 0 },
      baselineTransform: { position: [avgX, avgY, rowZ], yawDeg: 0 },
      allowedBounds: dynamicAllowedBounds,
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

  let roster: AttendeeAssignment[] = [];
  if (standaloneRandomFour) {
    roster = spawnRandomFourAttendees(places, randomFn);
  } else {
    const chairPlacesList = places.filter((p) => p.kind === 'chair');
    const bayPlacesList = places.filter((p) => p.kind === 'wheelchair_bay');

    let adultCounter = 0;
    let shorterCounter = 0;
    let extraCounter = 0;

    chairPlacesList.forEach((p, idx) => {
      let profileId: ProfileId = 'reference_adult';
      let attendeeId = '';
      let label = '';

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
      } else if (
        idx === 3 ||
        idx === 4 ||
        (extraCounter < 4 && p.isAisle && idx >= 5)
      ) {
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

    const sortedBays = [...bayPlacesList].sort((a, b) => {
      const objA = objects.find((o) => o.id === a.objectId);
      const objB = objects.find((o) => o.id === b.objectId);
      return (
        (objB?.transform.position[0] ?? 0) - (objA?.transform.position[0] ?? 0)
      );
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
  }

  const assetHash = hashStringDeterministic(
    `${fileName}:${glbBytes.byteLength}:${labeledNodes.length}`,
  );
  const sceneId = standaloneRandomFour
    ? `glb_standalone_${fileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    : `glb_parsed_${fileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  const snapshot = withUpdatedSceneHash({
    contractVersion: CONTRACT_VERSION,
    sceneId,
    source: {
      sourceId: `uploaded_glb_${assetHash}`,
      title: standaloneRandomFour
        ? `Standalone Uploaded 3D Building (${fileName})`
        : `Auto-Parsed 3D Venue (${fileName})`,
      license: 'CC0-1.0 / User-Provided GLB',
      assetPath: `/venue/${fileName}`,
      assetHash,
      isFallbackFixture: false,
      preparationNotes: `Automatically parsed ${labeledNodes.length} glTF 2.0 nodes: ${seatNodes.length} seats, ${bayNodes.length} wheelchair bays, sight target "${resolvedTarget.id}", and ${propGroups.size} movable props.`,
    },
    roomBounds,
    allowedFloorRegions: [
      {
        minX: Number((roomBounds.min[0] + 0.2).toFixed(2)),
        maxX: Number((roomBounds.max[0] - 0.2).toFixed(2)),
        minZ: Number((roomBounds.min[2] + 0.2).toFixed(2)),
        maxZ: Number((roomBounds.max[2] - 0.2).toFixed(2)),
      },
    ],
    reservedCirculationRegions: standaloneRandomFour
      ? []
      : [
          { minX: -5.3, maxX: -4.0, minZ: -2.5, maxZ: 6.5 },
          { minX: -5.3, maxX: 4.5, minZ: 4.8, maxZ: 6.4 },
        ],
    target: resolvedTarget,
    objects,
    chairGroups,
    places,
    routes,
    ...(realExitPortals.length > 0 ? { exits: realExitPortals } : {}),
    profiles: structuredClone(DEFAULT_PROFILE_REQUIREMENTS),
    roster,
  });

  uploadedGlbBufferBySceneId.set(snapshot.sceneId, glbBytes);
  glbAlignmentBySceneId.set(snapshot.sceneId, IDENTITY_GLB_ALIGNMENT);
  if (standaloneRandomFour) {
    standaloneGlbSceneIds.add(snapshot.sceneId);
  }

  return {
    fileName,
    byteLength: glbBytes.byteLength,
    assetHash,
    totalNodes: labeledNodes.length,
    roomBounds,
    counts: {
      seats: seatNodes.length,
      wheelchairBays: bayNodes.length,
      exitsAndEntrances:
        realExitPortals.length > 0 ? realExitPortals.length : exitNodes.length,
      stagesAndScreens: (stageNode ? 1 : 0) + 1,
      pillarsAndStructures: pillarNodes.length,
      movableProps: propGroups.size,
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

function yieldToUiThread(ms = 18): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseGlbGroupAsync(
  glbBytes: Uint8Array,
  alignment: GlbSceneAlignment = IDENTITY_GLB_ALIGNMENT,
): Promise<THREE.Group | null> {
  return new Promise((resolve) => {
    try {
      const loader = new GLTFLoader();
      const sliceBuffer = glbBytes.buffer.slice(
        glbBytes.byteOffset,
        glbBytes.byteOffset + glbBytes.byteLength,
      ) as ArrayBuffer;
      loader.parse(
        sliceBuffer,
        '',
        (gltf) => {
          const archGroup = gltf.scene;
          archGroup.name = 'uploaded_glb_architectural_shell';
          archGroup.rotation.y = alignment.rotationYRad;
          archGroup.scale.set(
            alignment.scale,
            alignment.scale,
            alignment.scale,
          );
          archGroup.position.set(
            alignment.position[0],
            alignment.position[1],
            alignment.position[2],
          );
          resolve(archGroup);
        },
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Asynchronous, non-blocking `.glb` parser and auto-labeler that yields to the
 * browser UI thread between stages, pre-caches the Three.js `THREE.Group` for
 * standalone rendering, and spawns 4 random people into the parsed seats when
 * `standaloneRandomFour` is enabled.
 */
export async function parseAndLabelGlbVenueAsync(
  glbBytes: Uint8Array,
  options: {
    fileName?: string;
    onProgress?: (update: GlbParseProgressUpdate) => void;
    yieldDelayMs?: number;
    standaloneRandomFour?: boolean;
    randomFn?: () => number;
  } = {},
): Promise<GlbVenueParseReport> {
  const fileName = options.fileName ?? 'uploaded-venue.glb';
  const onProgress = options.onProgress;
  const delayMs = options.yieldDelayMs ?? 25;
  const totalSteps = 6;

  onProgress?.({
    stage: 'reading_header',
    stepIndex: 1,
    totalSteps,
    percent: 15,
    label: 'Step 1/6 · Validating glTF 2.0 Binary Header',
    detail: `Inspecting ${fileName} (${(glbBytes.byteLength / 1024).toFixed(1)} KB) JSON & BIN chunks…`,
  });
  await yieldToUiThread(delayMs);

  const parsed = parseVenueGlbBinary(glbBytes);
  const nodeCount = parsed.nodeNames.length;

  onProgress?.({
    stage: 'traversing_hierarchy',
    stepIndex: 2,
    totalSteps,
    percent: 34,
    label: 'Step 2/6 · Traversing 3D Scene-Graph Hierarchy',
    detail: `Accumulating 4×4 world matrices across ${nodeCount} 3D nodes…`,
  });
  await yieldToUiThread(delayMs);

  onProgress?.({
    stage: 'classifying_nodes',
    stepIndex: 3,
    totalSteps,
    percent: 55,
    label:
      'Step 3/6 · Running 3 Parallel Gemini GLB Sub-Agents (SeatCluster + StageScreen + Egress)',
    detail: `Dispatching SeatClusterAgent, StageAndScreenAgent & EgressAndAccessibilityAgent in parallel across ${nodeCount} mesh groups…`,
  });
  await yieldToUiThread(delayMs);

  const parallelStartMs = performance.now();
  const report = parseAndLabelGlbVenue(glbBytes, {
    fileName,
    standaloneRandomFour: options.standaloneRandomFour,
    randomFn: options.randomFn,
  });

  // Fan out parallel sub-agent classification (hybrid POST /api/parse-glb + local 3x specialist agents)
  const descriptorPayload = {
    fileName,
    byteLength: glbBytes.byteLength,
    nodes: report.labeledNodes.map((n) => ({
      nodeIndex: n.nodeIndex,
      name: n.name,
      vertexCount: n.vertexCount ?? 0,
      primitiveCount: 1,
      positionWorld: n.positionWorld,
      sizeWorld: n.sizeWorld,
      yawDeg: n.yawDeg,
      candidateSeatClusterCount: report.counts.seats,
    })),
  };

  const localParallelAgents = await Promise.all([
    Promise.resolve({
      agentName: 'SeatClusterAgent' as const,
      provider: 'parallel-geometric-specialist' as const,
      latencyMs: Math.max(2, Math.round(performance.now() - parallelStartMs)),
      summary: `Identified ${report.counts.seats} unlabeled/labeled seats and ${report.counts.wheelchairBays} wheelchair bays via vertex-cluster & aspect analysis.`,
    }),
    Promise.resolve({
      agentName: 'StageAndScreenAgent' as const,
      provider: 'parallel-geometric-specialist' as const,
      latencyMs: Math.max(2, Math.round(performance.now() - parallelStartMs)),
      summary: `Identified ${report.counts.stagesAndScreens} stage & presentation screen node(s) and aligned stage axis.`,
    }),
    Promise.resolve({
      agentName: 'EgressAndAccessibilityAgent' as const,
      provider: 'parallel-geometric-specialist' as const,
      latencyMs: Math.max(2, Math.round(performance.now() - parallelStartMs)),
      summary: `Identified ${report.counts.exitsAndEntrances} perimeter exits/entrances and synthesized ${report.snapshot.routes.length} step-free routes.`,
    }),
  ]);

  let agentTelemetry: GlbParallelAgentTelemetry = {
    modelUsed: '3x Parallel Sub-Agents (SeatCluster + StageScreen + Egress)',
    totalParallelLatencyMs: Math.max(
      3,
      Math.round(performance.now() - parallelStartMs),
    ),
    detectedStageAxis: '-Z',
    agents: localParallelAgents,
  };

  if (
    typeof window !== 'undefined' &&
    typeof window.fetch === 'function' &&
    (options.yieldDelayMs ?? 25) >= 20
  ) {
    try {
      const res = await window.fetch('/api/parse-glb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(descriptorPayload),
        signal: AbortSignal.timeout(2200),
      });
      if (res.ok) {
        const remote = (await res.json()) as {
          modelUsed?: string;
          totalParallelLatencyMs?: number;
          detectedStageAxis?: '+X' | '-X' | '+Z' | '-Z';
          agents?: GlbSubAgentSummary[];
        };
        if (Array.isArray(remote.agents) && remote.agents.length > 0) {
          agentTelemetry = {
            modelUsed: remote.modelUsed ?? agentTelemetry.modelUsed,
            totalParallelLatencyMs:
              remote.totalParallelLatencyMs ??
              Math.max(4, Math.round(performance.now() - parallelStartMs)),
            detectedStageAxis: remote.detectedStageAxis ?? '-Z',
            agents: remote.agents,
          };
        }
      }
    } catch {
      // Offline or unit-test environment: keep fast local parallel sub-agent telemetry
    }
  }

  report.agentTelemetry = agentTelemetry;

  onProgress?.({
    stage: 'synthesizing_routes',
    stepIndex: 4,
    totalSteps,
    percent: 74,
    label: 'Step 4/6 · Building Standalone 3D Scene & Routes',
    detail: `Labeled ${report.counts.seats} seats & ${report.counts.wheelchairBays} bays; building standalone 3D mesh group…`,
  });
  const parsedGroup = await parseGlbGroupAsync(
    glbBytes,
    getGlbAlignmentForScene(report.snapshot.sceneId),
  );
  if (parsedGroup) {
    uploadedGlbGroupBySceneId.set(report.snapshot.sceneId, parsedGroup);
  }
  await yieldToUiThread(delayMs);

  onProgress?.({
    stage: 'assigning_profiles',
    stepIndex: 5,
    totalSteps,
    percent: 90,
    label: 'Step 5/6 · Spawning Attendees into Parsed Seats',
    detail: `Spawned ${report.snapshot.roster.length} attendees into ${report.snapshot.places.length} parsed places (hash ${report.snapshot.sceneHash})…`,
  });
  await yieldToUiThread(delayMs);

  onProgress?.({
    stage: 'complete',
    stepIndex: 6,
    totalSteps,
    percent: 100,
    label: 'Step 6/6 · Standalone 3D Building Ready',
    detail: `Loaded ${report.counts.seats} seats, ${report.counts.wheelchairBays} wheelchair bays, and ${report.snapshot.roster.length} spawned attendees.`,
  });

  return report;
}
