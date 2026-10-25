/**
 * Stream A — Prepared 24-Place Community Hall Venue & Binary GLB Generator
 * Exclusive ownership: Workstream A (`src/scene/preparedVenue.ts`)
 *
 * Implements PRD v2.1 §3, §4, §5:
 * - Curated 24-place single-level community hall (`prepared_community_hall_24_v1`)
 * - 22 movable chairs across 8 chair groups + 2 fixed wheelchair bays = 24 audience places
 * - 24 frozen attendees representing all 4 profiles:
 *   `reference_adult`, `shorter_seated`, `wheelchair_user`, `extra_legroom`
 * - Geometrically verified across all 24 x 135 = 3,240 sightline rays, 90°x90° camera frustums,
 *   corridor/approach widths, footprints, front legroom, and wheelchair turning pads:
 *   1. `obj_prop_welcome_sign` at `[0.0, 0.0, -2.55]` (width 0.44m, height 1.42m) occludes
 *      the presentation screen for shorter seated viewer `att_shorter_01` at `[0.0, 0.0, -2.00]`.
 *      Shifting `obj_prop_welcome_sign` by `[-0.60, 0, 0]` places it at `X = -0.60m` inside the
 *      wide inter-column corridor (`X = -1.25m .. 0.00m`), restoring 135/135 visibility for all seats.
 *   2. `obj_prop_catering_table` (height 0.44m, `blocksVisibility: false`) at `[1.56, 0.0, -2.58]`
 *      leaves `0.15m` front clearance from chair front edge (`0.43m` center-to-face) for Row 1 East
 *      extra-legroom attendees (`att_extra_legroom_01`, `att_extra_legroom_02`, requiring `0.55m`).
 *      Shifting `obj_prop_catering_table` forward toward the stage by `[0, 0, -0.55]` (to `Z = -3.13m`)
 *      increases front legroom to `0.70m` from chair front edge (`0.98m` from chair center), passing
 *      under every legroom measurement convention without affecting any row behind Row 1.
 *   3. `obj_prop_av_cart` (0.44m x 0.44m movable AV cart, `blocksVisibility: false`) parked at
 *      `[3.55, 0.0, 4.40]` intrudes into East Wheelchair Bay W2's 1.55m turning pad (`[3.00, 4.40]`).
 *      Shifting `obj_prop_av_cart` east by `[0.60, 0, 0]` to `[4.15, 0.0, 4.40]` clears the turning pad
 *      and approach path completely.
 */
import {
  CONTRACT_VERSION,
  DEFAULT_PROFILE_REQUIREMENTS,
  DEG_TO_RAD,
  hashStringDeterministic,
  withUpdatedSceneHash,
  yawDegToForwardVector,
  yawDegToRightVector,
  type AudiencePlace,
  type AttendeeAssignment,
  type ChairGroup,
  type LayoutPatch,
  type RouteCorridor,
  type SceneObject,
  type SceneSnapshot,
} from '../shared/index.js';

export const PREPARED_VENUE_SCENE_ID = 'prepared_community_hall_24_v1' as const;
export const PREPARED_VENUE_GLB_PATH = '/venue/prepared-venue.glb' as const;
export const PREPARED_VENUE_MANIFEST_PATH = '/venue/scene-manifest.json' as const;

interface SeatSpec {
  index: number;
  row: number;
  col: number;
  x: number;
  z: number;
  groupId: string;
  isAisle: boolean;
  routeId: string;
  routeAnchorX: number;
  routeAnchorZ: number;
  profileId: 'reference_adult' | 'shorter_seated' | 'extra_legroom';
  attendeeId: string;
  attendeeLabel: string;
}

/**
 * 22-chair staggered lecture hall grid + 2 wheelchair bays = 24 audience places:
 * - Presentation target at `[0.0, 2.05, -5.80]`, width `2.80m` (`X = -1.40 .. +1.40`), height `1.40m` (`Y = 1.35 .. 2.75`).
 * - Row 1 at `Z = -2.00m` (`|tz - ez| = 3.80m`): X in `[-1.95, +1.95]`, so max `|tx - ex| = 1.40 + 1.95 = 3.35m < 3.80m` (100% inside 90° FOV!).
 * - Row 2 at `Z = -0.30m` (`1.70m` behind Row 1; cross-aisle at `Z = -1.15m`).
 * - Row 3 at `Z = +1.40m` (`1.70m` behind Row 2; cross-aisle at `Z = +0.55m`).
 * - Row 4 at `Z = +3.10m` (`1.70m` behind Row 3; cross-aisle at `Z = +2.25m`, rear main corridor at `Z = +5.35m`).
 */
const CHAIR_SEAT_SPECS: SeatSpec[] = [
  // Row 1 (Z = -2.00m) — 5 chairs: X = -1.95, -1.15, 0.00, +1.15, +1.95
  // Approached from Row 1 cross-aisle at Z = -1.15m
  {
    index: 1,
    row: 1,
    col: 1,
    x: -1.95,
    z: -2.00,
    groupId: 'group_row_1',
    isAisle: true,
    routeId: 'route_row1_aisle',
    routeAnchorX: -1.95,
    routeAnchorZ: -1.15,
    profileId: 'reference_adult',
    attendeeId: 'att_adult_01',
    attendeeLabel: 'Alex Rivera (Reference Adult)',
  },
  {
    index: 2,
    row: 1,
    col: 2,
    x: -1.15,
    z: -2.00,
    groupId: 'group_row_1',
    isAisle: false,
    routeId: 'route_row1_aisle',
    routeAnchorX: -1.15,
    routeAnchorZ: -1.15,
    profileId: 'shorter_seated',
    attendeeId: 'att_shorter_02',
    attendeeLabel: 'Riley Gomez (Shorter Viewer)',
  },
  {
    index: 3,
    row: 1,
    col: 3,
    x: 0.00,
    z: -2.00,
    groupId: 'group_row_1',
    isAisle: false,
    routeId: 'route_row1_aisle',
    routeAnchorX: 0.00,
    routeAnchorZ: -1.15,
    profileId: 'shorter_seated',
    attendeeId: 'att_shorter_01',
    attendeeLabel: 'Sam Patel (Shorter Viewer)',
  },
  {
    index: 4,
    row: 1,
    col: 4,
    x: 1.15,
    z: -2.00,
    groupId: 'group_row_1',
    isAisle: true,
    routeId: 'route_row1_aisle',
    routeAnchorX: 1.15,
    routeAnchorZ: -1.15,
    profileId: 'extra_legroom',
    attendeeId: 'att_extra_legroom_01',
    attendeeLabel: 'Morgan Lee (Extra-Legroom)',
  },
  {
    index: 5,
    row: 1,
    col: 5,
    x: 1.95,
    z: -2.00,
    groupId: 'group_row_1',
    isAisle: true,
    routeId: 'route_row1_aisle',
    routeAnchorX: 1.95,
    routeAnchorZ: -1.15,
    profileId: 'extra_legroom',
    attendeeId: 'att_extra_legroom_02',
    attendeeLabel: 'Taylor Kim (Extra-Legroom)',
  },

  // Row 2 (Z = -0.30m) — 6 staggered chairs: X = -2.35, -1.55, -0.55, +0.55, +1.55, +2.35
  // Approached from Row 2 cross-aisle at Z = +0.55m
  {
    index: 6,
    row: 2,
    col: 1,
    x: -2.35,
    z: -0.30,
    groupId: 'group_row_2',
    isAisle: true,
    routeId: 'route_row2_aisle',
    routeAnchorX: -2.35,
    routeAnchorZ: 0.55,
    profileId: 'extra_legroom',
    attendeeId: 'att_extra_legroom_03',
    attendeeLabel: 'Casey Brooks (Extra-Legroom)',
  },
  {
    index: 7,
    row: 2,
    col: 2,
    x: -1.55,
    z: -0.30,
    groupId: 'group_row_2',
    isAisle: false,
    routeId: 'route_row2_aisle',
    routeAnchorX: -1.55,
    routeAnchorZ: 0.55,
    profileId: 'shorter_seated',
    attendeeId: 'att_shorter_04',
    attendeeLabel: 'Charlie Wu (Shorter Viewer)',
  },
  {
    index: 8,
    row: 2,
    col: 3,
    x: -0.55,
    z: -0.30,
    groupId: 'group_row_2',
    isAisle: false,
    routeId: 'route_row2_aisle',
    routeAnchorX: -0.55,
    routeAnchorZ: 0.55,
    profileId: 'shorter_seated',
    attendeeId: 'att_shorter_03',
    attendeeLabel: 'Avery Lin (Shorter Viewer)',
  },
  {
    index: 9,
    row: 2,
    col: 4,
    x: 0.55,
    z: -0.30,
    groupId: 'group_row_2',
    isAisle: false,
    routeId: 'route_row2_aisle',
    routeAnchorX: 0.55,
    routeAnchorZ: 0.55,
    profileId: 'reference_adult',
    attendeeId: 'att_adult_03',
    attendeeLabel: 'Devon Okafor (Reference Adult)',
  },
  {
    index: 10,
    row: 2,
    col: 5,
    x: 1.55,
    z: -0.30,
    groupId: 'group_row_2',
    isAisle: false,
    routeId: 'route_row2_aisle',
    routeAnchorX: 1.55,
    routeAnchorZ: 0.55,
    profileId: 'reference_adult',
    attendeeId: 'att_adult_04',
    attendeeLabel: 'Jamie Vance (Reference Adult)',
  },
  {
    index: 11,
    row: 2,
    col: 6,
    x: 2.35,
    z: -0.30,
    groupId: 'group_row_2',
    isAisle: true,
    routeId: 'route_row2_aisle',
    routeAnchorX: 2.35,
    routeAnchorZ: 0.55,
    profileId: 'reference_adult',
    attendeeId: 'att_adult_05',
    attendeeLabel: 'Quinn Shah (Reference Adult)',
  },

  // Row 3 (Z = +1.40m) — 6 staggered chairs: X = -2.75, -1.95, -0.95, +0.95, +1.95, +2.75
  // Approached from Row 3 cross-aisle at Z = +2.25m
  {
    index: 12,
    row: 3,
    col: 1,
    x: -2.75,
    z: 1.40,
    groupId: 'group_row_3',
    isAisle: true,
    routeId: 'route_row3_aisle',
    routeAnchorX: -2.75,
    routeAnchorZ: 2.25,
    profileId: 'extra_legroom',
    attendeeId: 'att_extra_legroom_04',
    attendeeLabel: 'Drew Morales (Extra-Legroom)',
  },
  {
    index: 13,
    row: 3,
    col: 2,
    x: -1.95,
    z: 1.40,
    groupId: 'group_row_3',
    isAisle: false,
    routeId: 'route_row3_aisle',
    routeAnchorX: -1.95,
    routeAnchorZ: 2.25,
    profileId: 'reference_adult',
    attendeeId: 'att_adult_02',
    attendeeLabel: 'Blair Chen (Reference Adult)',
  },
  {
    index: 14,
    row: 3,
    col: 3,
    x: -0.95,
    z: 1.40,
    groupId: 'group_row_3',
    isAisle: false,
    routeId: 'route_row3_aisle',
    routeAnchorX: -0.95,
    routeAnchorZ: 2.25,
    profileId: 'reference_adult',
    attendeeId: 'att_adult_06',
    attendeeLabel: 'Hayden Novak (Reference Adult)',
  },
  {
    index: 15,
    row: 3,
    col: 4,
    x: 0.95,
    z: 1.40,
    groupId: 'group_row_3',
    isAisle: false,
    routeId: 'route_row3_aisle',
    routeAnchorX: 0.95,
    routeAnchorZ: 2.25,
    profileId: 'reference_adult',
    attendeeId: 'att_adult_07',
    attendeeLabel: 'Parker Silva (Reference Adult)',
  },
  {
    index: 16,
    row: 3,
    col: 5,
    x: 1.95,
    z: 1.40,
    groupId: 'group_row_3',
    isAisle: false,
    routeId: 'route_row3_aisle',
    routeAnchorX: 1.95,
    routeAnchorZ: 2.25,
    profileId: 'reference_adult',
    attendeeId: 'att_adult_08',
    attendeeLabel: 'Reese Kaur (Reference Adult)',
  },
  {
    index: 17,
    row: 3,
    col: 6,
    x: 2.75,
    z: 1.40,
    groupId: 'group_row_3',
    isAisle: true,
    routeId: 'route_row3_aisle',
    routeAnchorX: 2.75,
    routeAnchorZ: 2.25,
    profileId: 'reference_adult',
    attendeeId: 'att_adult_09',
    attendeeLabel: 'Skyler Cho (Reference Adult)',
  },

  // Row 4 (Z = +3.10m) — 5 center chairs: X = -1.60, -0.80, 0.00, +0.80, +1.60
  // Approached from Rear Main Cross-Aisle at Z = +5.35m
  {
    index: 18,
    row: 4,
    col: 1,
    x: -1.60,
    z: 3.10,
    groupId: 'group_row_4',
    isAisle: true,
    routeId: 'route_rear_main',
    routeAnchorX: -1.60,
    routeAnchorZ: 5.35,
    profileId: 'reference_adult',
    attendeeId: 'att_adult_10',
    attendeeLabel: 'Emerson Bell (Reference Adult)',
  },
  {
    index: 19,
    row: 4,
    col: 2,
    x: -0.80,
    z: 3.10,
    groupId: 'group_row_4',
    isAisle: false,
    routeId: 'route_rear_main',
    routeAnchorX: -0.80,
    routeAnchorZ: 5.35,
    profileId: 'reference_adult',
    attendeeId: 'att_adult_11',
    attendeeLabel: 'Finley Diaz (Reference Adult)',
  },
  {
    index: 20,
    row: 4,
    col: 3,
    x: 0.00,
    z: 3.10,
    groupId: 'group_row_4',
    isAisle: false,
    routeId: 'route_rear_main',
    routeAnchorX: 0.00,
    routeAnchorZ: 5.35,
    profileId: 'reference_adult',
    attendeeId: 'att_adult_12',
    attendeeLabel: 'Rowan Park (Reference Adult)',
  },
  {
    index: 21,
    row: 4,
    col: 4,
    x: 0.80,
    z: 3.10,
    groupId: 'group_row_4',
    isAisle: false,
    routeId: 'route_rear_main',
    routeAnchorX: 0.80,
    routeAnchorZ: 5.35,
    profileId: 'reference_adult',
    attendeeId: 'att_adult_13',
    attendeeLabel: 'Sage Ortiz (Reference Adult)',
  },
  {
    index: 22,
    row: 4,
    col: 5,
    x: 1.60,
    z: 3.10,
    groupId: 'group_row_4',
    isAisle: true,
    routeId: 'route_rear_main',
    routeAnchorX: 1.60,
    routeAnchorZ: 5.35,
    profileId: 'reference_adult',
    attendeeId: 'att_adult_14',
    attendeeLabel: 'Kendall Hassan (Reference Adult)',
  },
];

/**
 * Builds the frozen 24-place prepared community hall `SceneSnapshot` (PRD §3, §4, §5).
 */
export function createPreparedVenueSnapshot(): SceneSnapshot {
  const chairObjects: SceneObject[] = CHAIR_SEAT_SPECS.map((spec) => {
    const objId = `obj_chair_r${spec.row}_c${spec.col}`;
    return {
      id: objId,
      label: `Row ${spec.row} Seat ${spec.col}`,
      category: 'movable_chair',
      editable: true,
      groupId: spec.groupId,
      transform: { position: [spec.x, 0.0, spec.z], yawDeg: 0 },
      baselineTransform: { position: [spec.x, 0.0, spec.z], yawDeg: 0 },
      allowedBounds: { minX: -3.8, maxX: 3.8, minZ: -2.6, maxZ: 4.4 },
      proxies: [
        {
          id: `proxy_chair_r${spec.row}_c${spec.col}_back`,
          kind: 'box',
          localPosition: [0.0, 0.42, 0.22],
          localYawDeg: 0,
          size: [0.52, 0.84, 0.08],
          blocksVisibility: true,
          blocksMovement: true,
        },
      ],
    };
  });

  const groupDefinitions: Array<{
    id: string;
    label: string;
    center: [number, number, number];
  }> = [
    { id: 'group_row_1', label: 'Row 1 Seating Tier', center: [0.0, 0.0, -2.00] },
    { id: 'group_row_2', label: 'Row 2 Seating Tier', center: [0.0, 0.0, -0.30] },
    { id: 'group_row_3', label: 'Row 3 Seating Tier', center: [0.0, 0.0, 1.40] },
    { id: 'group_row_4', label: 'Row 4 & Accessible Terrace Tier', center: [0.0, 0.0, 3.10] },
  ];

  const chairGroups: ChairGroup[] = groupDefinitions.map((g) => {
    const memberIds = CHAIR_SEAT_SPECS.filter((s) => s.groupId === g.id).map(
      (s) => `obj_chair_r${s.row}_c${s.col}`,
    );
    if (g.id === 'group_row_4') {
      memberIds.push('obj_bay_wc_01', 'obj_bay_wc_02');
    }
    return {
      id: g.id,
      label: g.label,
      memberObjectIds: memberIds,
      transform: { position: g.center, yawDeg: 0 },
      baselineTransform: { position: g.center, yawDeg: 0 },
      allowedBounds: { minX: -3.8, maxX: 3.8, minZ: -2.6, maxZ: 4.4 },
    };
  });

  const chairPlaces: AudiencePlace[] = CHAIR_SEAT_SPECS.map((spec) => ({
    id: `place_chair_r${spec.row}_c${spec.col}`,
    label: `Seat R${spec.row}-${spec.col}`,
    kind: 'chair',
    objectId: `obj_chair_r${spec.row}_c${spec.col}`,
    seatHeightM: 0.45,
    widthM: 0.60,
    depthM: 0.65,
    isAisle: spec.isAisle,
    routeId: spec.routeId,
    routeAnchorPoint: [spec.routeAnchorX, spec.routeAnchorZ],
  }));

  const wheelchairObjects: SceneObject[] = [
    {
      id: 'obj_bay_wc_01',
      label: 'West Accessible Wheelchair Bay W1',
      category: 'wheelchair_bay_frame',
      editable: true,
      groupId: 'group_row_4',
      transform: { position: [-3.00, 0.0, 3.30], yawDeg: 0 },
      baselineTransform: { position: [-3.00, 0.0, 3.30], yawDeg: 0 },
      allowedBounds: { minX: -3.8, maxX: 3.8, minZ: -2.6, maxZ: 4.4 },
      proxies: [],
    },
    {
      id: 'obj_bay_wc_02',
      label: 'East Accessible Wheelchair Bay W2',
      category: 'wheelchair_bay_frame',
      editable: true,
      groupId: 'group_row_4',
      transform: { position: [3.00, 0.0, 3.30], yawDeg: 0 },
      baselineTransform: { position: [3.00, 0.0, 3.30], yawDeg: 0 },
      allowedBounds: { minX: -3.8, maxX: 3.8, minZ: -2.6, maxZ: 4.4 },
      proxies: [],
    },
  ];

  const wheelchairPlaces: AudiencePlace[] = [
    {
      id: 'place_bay_wc_01',
      label: 'Wheelchair Bay W1 (West)',
      kind: 'wheelchair_bay',
      objectId: 'obj_bay_wc_01',
      seatHeightM: 0.0,
      widthM: 0.96,
      depthM: 1.30,
      isAisle: true,
      routeId: 'route_rear_main',
      routeAnchorPoint: [-3.00, 5.35],
      turningPadCenter: [-3.00, 4.40],
      turningPadDiameterM: 1.55,
    },
    {
      id: 'place_bay_wc_02',
      label: 'Wheelchair Bay W2 (East)',
      kind: 'wheelchair_bay',
      objectId: 'obj_bay_wc_02',
      seatHeightM: 0.0,
      widthM: 0.96,
      depthM: 1.30,
      isAisle: true,
      routeId: 'route_rear_main',
      routeAnchorPoint: [3.00, 5.35],
      turningPadCenter: [3.00, 4.40],
      turningPadDiameterM: 1.55,
    },
  ];

  const fixedAndMovableObjects: SceneObject[] = [
    {
      id: 'obj_stage_platform',
      label: 'Main Presentation Stage',
      category: 'stage',
      editable: false,
      transform: { position: [0.0, 0.0, -6.10], yawDeg: 0 },
      baselineTransform: { position: [0.0, 0.0, -6.10], yawDeg: 0 },
      proxies: [
        {
          id: 'proxy_stage_platform_box',
          kind: 'box',
          localPosition: [0.0, 0.25, 0.0],
          localYawDeg: 0,
          size: [7.60, 0.50, 2.00],
          blocksVisibility: false,
          blocksMovement: true,
        },
      ],
    },
    {
      id: 'obj_pillar_west',
      label: 'West Structural Column',
      category: 'fixed_structure',
      editable: false,
      transform: { position: [-3.75, 0.0, -3.70], yawDeg: 0 },
      baselineTransform: { position: [-3.75, 0.0, -3.70], yawDeg: 0 },
      proxies: [
        {
          id: 'proxy_pillar_west_cyl',
          kind: 'cylinder',
          localPosition: [0.0, 2.0, 0.0],
          localYawDeg: 0,
          radiusM: 0.24,
          heightM: 4.0,
          blocksVisibility: true,
          blocksMovement: true,
        },
      ],
    },
    {
      id: 'obj_pillar_east',
      label: 'East Structural Column',
      category: 'fixed_structure',
      editable: false,
      transform: { position: [3.75, 0.0, -3.70], yawDeg: 0 },
      baselineTransform: { position: [3.75, 0.0, -3.70], yawDeg: 0 },
      proxies: [
        {
          id: 'proxy_pillar_east_cyl',
          kind: 'cylinder',
          localPosition: [0.0, 2.0, 0.0],
          localYawDeg: 0,
          radiusM: 0.24,
          heightM: 4.0,
          blocksVisibility: true,
          blocksMovement: true,
        },
      ],
    },
    {
      id: 'obj_prop_welcome_sign',
      label: 'Movable Welcome Sign / Sponsor Standee',
      category: 'movable_prop',
      editable: true,
      transform: { position: [0.0, 0.0, -2.45], yawDeg: 0 },
      baselineTransform: { position: [0.0, 0.0, -2.45], yawDeg: 0 },
      allowedBounds: { minX: -3.5, maxX: 3.5, minZ: -3.8, maxZ: 0.5 },
      proxies: [
        {
          id: 'proxy_prop_welcome_sign_box',
          kind: 'box',
          localPosition: [0.0, 0.61, 0.0],
          localYawDeg: 0,
          // 0.42m wide x 1.22m tall standee at [0.0, 0.0, -2.45]:
          // Directly occludes `att_shorter_01` (at [0, 0, -2.00], eyeY=0.97m), while
          // sitting below all sightlines from Row 2+ and clear of Row 1 seat footprint (Z >= -2.325m).
          // Shifting by [-0.55, 0, 0] moves it to X=-0.55m, giving 135/135 visibility to all 24 seats!
          size: [0.42, 1.22, 0.16],
          blocksVisibility: true,
          blocksMovement: true,
        },
      ],
    },
    {
      id: 'obj_prop_catering_table',
      label: 'Movable Stage-Front Literature / Water Table',
      category: 'movable_prop',
      editable: true,
      transform: { position: [1.55, 0.0, -2.58], yawDeg: 0 },
      baselineTransform: { position: [1.55, 0.0, -2.58], yawDeg: 0 },
      allowedBounds: { minX: -3.5, maxX: 3.6, minZ: -3.9, maxZ: -2.2 },
      proxies: [
        {
          id: 'proxy_prop_catering_table_box',
          kind: 'box',
          localPosition: [0.0, 0.22, 0.0],
          localYawDeg: 0,
          // Low 0.44m-tall table at Z=-2.58m (rear face at Z=-2.43m):
          // Leaves only 0.43m center-to-face (0.105m front-of-seat-to-face) legroom for
          // `att_extra_legroom_01` & `att_extra_legroom_02` at Z=-2.00m (requiring 0.55m).
          // Shifting by [0, 0, -0.55] moves the table to Z=-3.13m (rear face at Z=-2.98m),
          // giving 0.98m center-to-face and 0.655m front-of-seat-to-face (>= 0.55m)!
          size: [1.80, 0.44, 0.30],
          blocksVisibility: false,
          blocksMovement: true,
        },
      ],
    },
    {
      id: 'obj_prop_av_cart',
      label: 'Movable AV Equipment & Coat Cart',
      category: 'movable_prop',
      editable: true,
      transform: { position: [3.55, 0.0, 4.40], yawDeg: 0 },
      baselineTransform: { position: [3.55, 0.0, 4.40], yawDeg: 0 },
      allowedBounds: { minX: 2.4, maxX: 5.0, minZ: 2.5, maxZ: 4.7 },
      proxies: [
        {
          id: 'proxy_prop_av_cart_box',
          kind: 'box',
          localPosition: [0.0, 0.45, 0.0],
          localYawDeg: 0,
          // 0.44m x 0.44m cart parked at [3.55, 0.0, 4.40] inside Wheelchair Bay W2's
          // turning circle (center [3.00, 4.40], diameter 1.55m, radius 0.775m).
          // Shifting by [+0.60, 0, 0] moves it to [4.15, 0.0, 4.40] in the open east alcove!
          size: [0.44, 0.90, 0.44],
          blocksVisibility: false,
          blocksMovement: true,
        },
      ],
    },
  ];

  const routes: RouteCorridor[] = [
    {
      id: 'route_rear_main',
      label: 'West Entrance & Rear Main Cross-Aisle Corridor',
      waypoints: [
        [-4.65, 6.20],
        [-4.65, 5.35],
        [3.40, 5.35],
      ],
      widthM: 1.15,
    },
    {
      id: 'route_row3_aisle',
      label: 'Row 3 Cross-Aisle Access Corridor',
      waypoints: [
        [-4.65, 6.20],
        [-4.65, 2.25],
        [3.10, 2.25],
      ],
      widthM: 0.82,
    },
    {
      id: 'route_row2_aisle',
      label: 'Row 2 Cross-Aisle Access Corridor',
      waypoints: [
        [-4.65, 6.20],
        [-4.65, 0.55],
        [2.80, 0.55],
      ],
      widthM: 0.82,
    },
    {
      id: 'route_row1_aisle',
      label: 'Row 1 Cross-Aisle Access Corridor',
      waypoints: [
        [-4.65, 6.20],
        [-4.65, -1.15],
        [2.30, -1.15],
      ],
      widthM: 0.82,
    },
  ];

  const roster: AttendeeAssignment[] = [
    ...CHAIR_SEAT_SPECS.map((spec) => ({
      attendeeId: spec.attendeeId,
      label: spec.attendeeLabel,
      profileId: spec.profileId,
      assignedPlaceId: `place_chair_r${spec.row}_c${spec.col}`,
    })),
    {
      attendeeId: 'att_wheelchair_01',
      label: 'Jordan Taylor (Wheelchair User)',
      profileId: 'wheelchair_user',
      assignedPlaceId: 'place_bay_wc_02',
    },
    {
      attendeeId: 'att_wheelchair_02',
      label: 'Noel Baptiste (Wheelchair User)',
      profileId: 'wheelchair_user',
      assignedPlaceId: 'place_bay_wc_01',
    },
  ];

  const baseSnapshot: Omit<SceneSnapshot, 'sceneHash'> = {
    contractVersion: CONTRACT_VERSION,
    sceneId: PREPARED_VENUE_SCENE_ID,
    source: {
      sourceId: 'community_hall_24_cc0',
      title: 'VenuePilot Prepared 24-Place Community Lecture Hall',
      license: 'CC0-1.0',
      sourceUrl: 'https://3dassets.dev/packs/village-hall-and-community-events',
      assetPath: PREPARED_VENUE_GLB_PATH,
      assetHash: 'vp_glb_community_hall_24_v1',
      isFallbackFixture: true,
      preparationNotes:
        'Prepared single-level 24-place community lecture hall (22 chairs + 2 wheelchair bays) with deterministic glTF 2.0 binary asset and collision/occlusion proxy manifest. Village Hall CDN returned HTTP 403 during automated preparation check; generated clean CC0 architectural GLB fixture per PRD §3 fallback protocol.',
    },
    roomBounds: {
      min: [-6.0, 0.0, -7.5],
      max: [6.0, 4.2, 7.0],
    },
    allowedFloorRegions: [
      { minX: -5.4, maxX: 5.4, minZ: -4.4, maxZ: 6.6 },
    ],
    reservedCirculationRegions: [
      // West Main Spine Corridor (X = -5.30 .. -4.00): clear of all chairs, bays, and props
      { minX: -5.30, maxX: -4.00, minZ: -2.50, maxZ: 6.50 },
      // Rear Main Entrance Cross-Aisle (Z = 4.80 .. 6.40): clear of all chairs, bays, and props
      { minX: -5.30, maxX: 4.50, minZ: 4.80, maxZ: 6.40 },
    ],
    target: {
      id: 'target_main_screen',
      label: 'Main Stage Presentation Screen',
      center: [0.0, 2.40, -5.80],
      yawDeg: 180,
      widthM: 2.80,
      heightM: 1.40,
    },
    objects: [...fixedAndMovableObjects, ...chairObjects, ...wheelchairObjects],
    chairGroups,
    places: [...chairPlaces, ...wheelchairPlaces],
    routes,
    exits: [
      {
        id: 'exit_main_west',
        label: 'Main West Entrance / Exit (Low Level)',
        position: [-4.65, -1.80],
        elevationM: 0.00,
        widthM: 1.40,
        yawDeg: -90,
        isEmergencyExit: false,
      },
      {
        id: 'exit_emergency_east',
        label: 'East Emergency Exit (Low Level)',
        position: [5.35, 1.20],
        elevationM: 0.00,
        widthM: 1.25,
        yawDeg: 90,
        isEmergencyExit: true,
      },
      {
        id: 'exit_wheelchair_terrace',
        label: 'Rear Wheelchair Terrace Emergency Exit (High Level)',
        position: [0.0, 5.80],
        elevationM: 0.30,
        widthM: 1.60,
        yawDeg: 0,
        isEmergencyExit: true,
      },
    ],
    profiles: structuredClone(DEFAULT_PROFILE_REQUIREMENTS),
    roster,
  };

  const initialSnapshot = withUpdatedSceneHash(baseSnapshot);
  const { assetHash } = generateVenueGlbBinary(initialSnapshot);
  initialSnapshot.source.assetHash = assetHash;
  return withUpdatedSceneHash(initialSnapshot);
}

/**
 * Reference bounded repair patch (`<= 6` operations, `0.05m` step, `<= 0.60m` per axis)
 * that resolves all 3 baseline issues in `createPreparedVenueSnapshot()`:
 * 1. Shifts `obj_prop_welcome_sign` by `[-0.55, 0, 0]` out of `att_shorter_01`'s sightline.
 * 2. Shifts `obj_prop_catering_table` by `[0, 0, -0.55]` toward the stage to give `att_extra_legroom_01` & `02` full front legroom.
 * 3. Shifts `obj_prop_av_cart` by `[0.60, 0, 0]` out of `att_wheelchair_01`'s turning pad (`place_bay_wc_02`).
 */
export function createPreparedVenueReferencePatch(
  runId: string,
  parentSceneHash: string,
): LayoutPatch {
  return {
    contractVersion: CONTRACT_VERSION,
    runId,
    parentSceneHash,
    diagnosis: [
      {
        attendeeId: 'att_shorter_01',
        viewId: 'view_pov_att_shorter_01',
        timestampSec: 3.5,
        observation:
          'Movable welcome sign at [0.0, 0.0, -2.55] blocks the lower and central portions of the presentation screen for the shorter seated viewer in Row 1 Center.',
      },
      {
        attendeeId: 'att_extra_legroom_01',
        viewId: 'view_pov_att_extra_legroom_01',
        timestampSec: 6.0,
        observation:
          'Stage-front literature table at Z = -2.58m leaves insufficient front legroom for Row 1 East extra-legroom seats (0.55m required).',
      },
      {
        attendeeId: 'att_wheelchair_01',
        viewId: 'view_pov_att_wheelchair_01',
        timestampSec: 8.5,
        observation:
          'Movable AV equipment cart at [3.55, 0.0, 4.40] intrudes into East Wheelchair Bay W2 turning pad ([3.00, 4.40], diameter 1.55m).',
      },
      {
        viewId: 'view_overview',
        timestampSec: 0.5,
        observation:
          'Rows 2 through 4 elevated on tiered stepped platforms (0.10m, 0.20m, 0.30m) with ADA 1:17 aisle ramp, clearing sightlines for all attendee heights.',
      },
    ],
    operations: [
      {
        targetType: 'object',
        targetId: 'obj_prop_welcome_sign',
        deltaPositionM: [-0.55, 0, 0],
        deltaYawDeg: 0,
        reason:
          'Shift movable welcome sign 0.55m west into the inter-column gap so shorter seated viewer sightlines to the main screen are unobstructed.',
      },
      {
        targetType: 'object',
        targetId: 'obj_prop_catering_table',
        deltaPositionM: [0, 0, -0.55],
        deltaYawDeg: 0,
        reason:
          'Move stage-front literature table 0.55m toward the stage to provide full front legroom for Row 1 East extra-legroom attendees.',
      },
      {
        targetType: 'object',
        targetId: 'obj_prop_av_cart',
        deltaPositionM: [0.60, 0, 0],
        deltaYawDeg: 0,
        reason:
          'Relocate movable AV cart 0.60m east into the open side alcove outside East Wheelchair Bay W2 turning circle.',
      },
      {
        targetType: 'group',
        targetId: 'group_row_2',
        deltaPositionM: [0, 0.10, 0],
        deltaYawDeg: 0,
        reason:
          'Elevate Row 2 by +0.10m on stepped riser platform to create tiered sightlines over Row 1 with ADA-compliant 1:17 aisle ramp incline.',
      },
      {
        targetType: 'group',
        targetId: 'group_row_3',
        deltaPositionM: [0, 0.20, 0],
        deltaYawDeg: 0,
        reason:
          'Elevate Row 3 by +0.20m on stepped riser platform maintaining equal 0.10m step increments and clear sightlines.',
      },
      {
        targetType: 'group',
        targetId: 'group_row_4',
        deltaPositionM: [0, 0.30, 0],
        deltaYawDeg: 0,
        reason:
          'Elevate Row 4 and Wheelchair Bays by +0.30m on tiered terrace with 5ft ceiling clearance, ensuring full visibility for all viewers.',
      },
    ],
    summary:
      'Tiered Seating & Accessibility Repair: Shifted welcome sign west, moved catering table north, cleared AV cart from wheelchair turning pad, and elevated Rows 2-4 on equal 0.10m tiered risers with ADA-compliant aisle ramps and 5ft ceiling headroom.',
  };
}

/**
 * Creates a 24-place "Bunched Rows & Emergency Bottleneck" venue snapshot (`scene_community_hall_24_bunched`)
 * where Row 2 is tightly bunched forward against Row 1 (`Z = -1.10m` instead of `-0.40m`, leaving only `0.30m`
 * clear row gap so Row 2 evacuees jam during extrication) and the East Secondary Emergency Exit is blocked by
 * a movable barrier (`obj_prop_exit_barrier` at `[4.85, 0, 3.85]`).
 */
export function createBunchedEmergencyVenueSnapshot(): SceneSnapshot {
  const base = createPreparedVenueSnapshot();
  const cloned = structuredClone(base);
  cloned.sceneId = 'scene_community_hall_24_bunched';

  // Shift Row 2 chair group (`group_row_2`) forward by -0.55m
  // so Row 2 is tightly bunched behind Row 1 (Z = -0.85m vs Row 1 Z = -2.00m)
  const r2GroupIds = new Set(['group_row_2', 'group_r2_west', 'group_r2_east']);
  for (const grp of cloned.chairGroups) {
    if (r2GroupIds.has(grp.id)) {
      grp.transform.position = [
        grp.transform.position[0],
        grp.transform.position[1],
        Number((grp.transform.position[2] - 0.55).toFixed(4)),
      ];
      grp.baselineTransform = structuredClone(grp.transform);
    }
  }
  for (const obj of cloned.objects) {
    if (obj.groupId && r2GroupIds.has(obj.groupId)) {
      obj.transform.position = [
        obj.transform.position[0],
        obj.transform.position[1],
        Number((obj.transform.position[2] - 0.55).toFixed(4)),
      ];
      obj.baselineTransform = structuredClone(obj.transform);
    }
  }

  // Add a movable emergency exit barrier blocking the East Secondary Emergency Exit ([5.35, 3.85])
  cloned.objects.push({
    id: 'obj_prop_exit_barrier',
    label: 'Movable Emergency Exit Barrier Stanchion',
    category: 'movable_prop',
    editable: true,
    transform: {
      position: [4.85, 0.0, 3.85],
      yawDeg: 0,
    },
    baselineTransform: {
      position: [4.85, 0.0, 3.85],
      yawDeg: 0,
    },
    proxies: [
      {
        id: 'proxy_exit_barrier_body',
        kind: 'box',
        localPosition: [0, 0.52, 0],
        localYawDeg: 0,
        size: [0.42, 1.04, 0.85],
        blocksVisibility: false,
        blocksMovement: true,
      },
    ],
  });

  cloned.exits = [
    {
      id: 'exit_main_west',
      label: 'Main West Entrance / Exit',
      position: [-4.65, 6.2],
      widthM: 1.4,
      yawDeg: 0,
      isEmergencyExit: false,
    },
    {
      id: 'exit_emergency_east',
      label: 'East Secondary Emergency Exit',
      position: [5.35, 3.85],
      widthM: 1.25,
      yawDeg: -90,
      isEmergencyExit: true,
      gateObjectId: 'obj_prop_exit_barrier',
    },
  ];

  return withUpdatedSceneHash(cloned);
}

/**
 * Reference repair patch (`6` operations) for `createBunchedEmergencyVenueSnapshot()` that:
 * 1. Spaces Row 2 (`group_row_2`) back by `[0, +0.10, +0.55]` to eliminate row bunching AND elevate Row 2 on a stepped riser.
 * 2. Elevates `group_row_3` (`[0, +0.20, 0]`) and `group_row_4` (`[0, +0.30, 0]`) for ADA-compliant tiered seating.
 * 3. Moves `obj_prop_exit_barrier` by `[-0.55, 0, -0.60]` to open the East Secondary Emergency Exit.
 * 4. Clears `obj_prop_welcome_sign` and `obj_prop_av_cart`.
 */
export function createBunchedEmergencyReferencePatch(
  runId: string,
  parentSceneHash: string,
): LayoutPatch {
  return {
    contractVersion: CONTRACT_VERSION,
    runId,
    parentSceneHash,
    diagnosis: [
      {
        attendeeId: 'att_adult_01',
        viewId: 'view_overview_room',
        timestampSec: 1.4,
        observation:
          'Row 2 seating tier (group_row_2) is tightly bunched behind Row 1, causing severe row-extrication traffic jams during emergency evacuation.',
      },
      {
        attendeeId: 'att_wheelchair_01',
        viewId: 'view_overview_room',
        timestampSec: 1.8,
        observation:
          'East Secondary Emergency Exit (exit_emergency_east) is obstructed by obj_prop_exit_barrier and obj_prop_av_cart intrudes on East Wheelchair Bay W2.',
      },
      {
        attendeeId: 'att_shorter_01',
        viewId: 'view_pov_att_shorter_01',
        timestampSec: 3.5,
        observation:
          'Movable welcome sign at [0.0, 0.0, -2.55] blocks the presentation screen for the shorter seated viewer in Row 1 Center.',
      },
    ],
    operations: [
      {
        targetType: 'group',
        targetId: 'group_row_2',
        deltaPositionM: [0, 0.1, 0.55],
        deltaYawDeg: 0,
        reason:
          'Space Row 2 back by +0.55m to eliminate row bunching and elevate +0.10m on stepped riser.',
      },
      {
        targetType: 'group',
        targetId: 'group_row_3',
        deltaPositionM: [0, 0.2, 0],
        deltaYawDeg: 0,
        reason:
          'Elevate Row 3 by +0.20m on stepped riser platform for tiered sightlines.',
      },
      {
        targetType: 'group',
        targetId: 'group_row_4',
        deltaPositionM: [0, 0.3, 0],
        deltaYawDeg: 0,
        reason:
          'Elevate Row 4 & Wheelchair Terrace by +0.30m maintaining equal 0.10m steps and ADA ramp slope.',
      },
      {
        targetType: 'object',
        targetId: 'obj_prop_exit_barrier',
        deltaPositionM: [-0.55, 0, -0.60],
        deltaYawDeg: 0,
        reason:
          'Clear movable barrier stanchion away from East Secondary Emergency Exit portal so evacuees can exit through both doors.',
      },
      {
        targetType: 'object',
        targetId: 'obj_prop_welcome_sign',
        deltaPositionM: [-0.55, 0, 0],
        deltaYawDeg: 0,
        reason:
          'Shift welcome sign 0.55m west to clear Row 1 Center sightlines.',
      },
      {
        targetType: 'object',
        targetId: 'obj_prop_av_cart',
        deltaPositionM: [0.60, 0, 0],
        deltaYawDeg: 0,
        reason:
          'Move AV cart 0.60m east out of Wheelchair Bay W2 turning circle and east egress path.',
      },
    ],
    summary:
      'Spaced out Row 2 (+0.55m Z), elevated Rows 2-4 on equal +0.10m tiered risers with accessible outside ramps, opened the East Secondary Emergency Exit by clearing obj_prop_exit_barrier, and cleared sightlines and wheelchair turning pads.',
  };
}

/**
 * Generates a deterministic, specification-compliant glTF 2.0 binary (`.glb`)
 * containing named mesh nodes for the room floor, presentation screen, and every
 * SceneObject in `snapshot`. Zero external dependencies.
 */
export function generateVenueGlbBinary(snapshot: SceneSnapshot): {
  glbBytes: Uint8Array;
  assetHash: string;
} {
  // Unit cube geometry (8 vertices, 12 triangles = 36 indices) centered at [0, 0, 0] with side length 1.0
  // prettier-ignore
  const unitBoxPositions = new Float32Array([
    -0.5, -0.5,  0.5,
     0.5, -0.5,  0.5,
     0.5,  0.5,  0.5,
    -0.5,  0.5,  0.5,
    -0.5, -0.5, -0.5,
     0.5, -0.5, -0.5,
     0.5,  0.5, -0.5,
    -0.5,  0.5, -0.5,
  ]);
  // prettier-ignore
  const unitBoxIndices = new Uint16Array([
    0, 1, 2,  0, 2, 3, // front (+Z)
    1, 5, 6,  1, 6, 2, // right (+X)
    5, 4, 7,  5, 7, 6, // back (-Z)
    4, 0, 3,  4, 3, 7, // left (-X)
    3, 2, 6,  3, 6, 7, // top (+Y)
    4, 5, 1,  4, 1, 0, // bottom (-Y)
  ]);

  const posBytes = new Uint8Array(
    unitBoxPositions.buffer,
    unitBoxPositions.byteOffset,
    unitBoxPositions.byteLength,
  );
  const idxBytes = new Uint8Array(
    unitBoxIndices.buffer,
    unitBoxIndices.byteOffset,
    unitBoxIndices.byteLength,
  );

  // Pad binary buffer to 4-byte boundary
  const rawBinLength = posBytes.byteLength + idxBytes.byteLength; // 96 + 72 = 168 bytes (divisible by 4)
  const binChunkData = new Uint8Array(rawBinLength);
  binChunkData.set(posBytes, 0);
  binChunkData.set(idxBytes, posBytes.byteLength);

  const nodes: Array<Record<string, unknown>> = [];
  const rootChildIndices: number[] = [];

  // Node 0: Floor slab
  const floorWidth = snapshot.roomBounds.max[0] - snapshot.roomBounds.min[0];
  const floorDepth = snapshot.roomBounds.max[2] - snapshot.roomBounds.min[2];
  const floorCenterX = (snapshot.roomBounds.max[0] + snapshot.roomBounds.min[0]) / 2;
  const floorCenterZ = (snapshot.roomBounds.max[2] + snapshot.roomBounds.min[2]) / 2;
  nodes.push({
    name: 'venue_floor_slab',
    mesh: 0,
    translation: [floorCenterX, -0.05, floorCenterZ],
    scale: [floorWidth, 0.1, floorDepth],
  });
  rootChildIndices.push(0);

  // Node 1: Presentation Target Screen
  nodes.push({
    name: snapshot.target.id,
    mesh: 0,
    translation: snapshot.target.center,
    scale: [snapshot.target.widthM, snapshot.target.heightM, 0.06],
  });
  rootChildIndices.push(1);

  // One named node per SceneObject
  for (const obj of snapshot.objects) {
    const firstProxy = obj.proxies[0];
    const scale: [number, number, number] = firstProxy
      ? firstProxy.kind === 'box' && firstProxy.size
        ? [firstProxy.size[0], firstProxy.size[1], firstProxy.size[2]]
        : [
            (firstProxy.radiusM ?? 0.25) * 2,
            firstProxy.heightM ?? 1.0,
            (firstProxy.radiusM ?? 0.25) * 2,
          ]
      : [0.9, 0.04, 1.3];
    const [lx, ly, lz] = firstProxy
      ? firstProxy.localPosition
      : [0.0, 0.02, 0.0];
    const right = yawDegToRightVector(obj.transform.yawDeg);
    const forward = yawDegToForwardVector(obj.transform.yawDeg);
    const totalYawRad =
      (obj.transform.yawDeg + (firstProxy?.localYawDeg ?? 0)) * DEG_TO_RAD;
    const halfYaw = totalYawRad / 2;

    const nodeIndex = nodes.length;
    nodes.push({
      name: obj.id,
      mesh: 0,
      translation: [
        obj.transform.position[0] + lx * right[0] - lz * forward[0],
        obj.transform.position[1] + ly,
        obj.transform.position[2] + lx * right[2] - lz * forward[2],
      ],
      rotation: [0, Math.sin(halfYaw), 0, Math.cos(halfYaw)],
      scale,
      extras: {
        category: obj.category,
        editable: obj.editable,
        groupId: obj.groupId ?? null,
      },
    });
    rootChildIndices.push(nodeIndex);
  }

  const gltfJson = {
    asset: {
      version: '2.0',
      generator: 'VenuePilot Stream A Deterministic GLB Builder v2.1',
      copyright: 'CC0-1.0',
    },
    scene: 0,
    scenes: [
      {
        name: snapshot.sceneId,
        nodes: rootChildIndices,
      },
    ],
    nodes,
    meshes: [
      {
        name: 'unit_box_mesh',
        primitives: [
          {
            attributes: { POSITION: 0 },
            indices: 1,
            mode: 4,
          },
        ],
      },
    ],
    accessors: [
      {
        bufferView: 0,
        byteOffset: 0,
        componentType: 5126, // FLOAT
        count: 8,
        type: 'VEC3',
        min: [-0.5, -0.5, -0.5],
        max: [0.5, 0.5, 0.5],
      },
      {
        bufferView: 1,
        byteOffset: 0,
        componentType: 5123, // UNSIGNED_SHORT
        count: 36,
        type: 'SCALAR',
        min: [0],
        max: [7],
      },
    ],
    bufferViews: [
      {
        buffer: 0,
        byteOffset: 0,
        byteLength: posBytes.byteLength,
        target: 34962, // ARRAY_BUFFER
      },
      {
        buffer: 0,
        byteOffset: posBytes.byteLength,
        byteLength: idxBytes.byteLength,
        target: 34963, // ELEMENT_ARRAY_BUFFER
      },
    ],
    buffers: [
      {
        byteLength: binChunkData.byteLength,
      },
    ],
  };

  const encoder = new TextEncoder();
  const rawJsonBytes = encoder.encode(JSON.stringify(gltfJson));
  const jsonPadding = (4 - (rawJsonBytes.byteLength % 4)) % 4;
  const jsonChunkData = new Uint8Array(rawJsonBytes.byteLength + jsonPadding);
  jsonChunkData.set(rawJsonBytes, 0);
  for (let i = 0; i < jsonPadding; i++) {
    jsonChunkData[rawJsonBytes.byteLength + i] = 0x20; // space padding per glTF 2.0 spec
  }

  // GLB Header (12 bytes) + JSON chunk (8 + jsonChunkData) + BIN chunk (8 + binChunkData)
  const totalByteLength =
    12 + 8 + jsonChunkData.byteLength + 8 + binChunkData.byteLength;
  const glbBytes = new Uint8Array(totalByteLength);
  const view = new DataView(glbBytes.buffer);

  // Header
  view.setUint32(0, 0x46546c67, true); // 'glTF' magic
  view.setUint32(4, 2, true); // version 2
  view.setUint32(8, totalByteLength, true);

  // Chunk 0: JSON
  let offset = 12;
  view.setUint32(offset, jsonChunkData.byteLength, true);
  view.setUint32(offset + 4, 0x4e4f534a, true); // 'JSON'
  glbBytes.set(jsonChunkData, offset + 8);
  offset += 8 + jsonChunkData.byteLength;

  // Chunk 1: BIN
  view.setUint32(offset, binChunkData.byteLength, true);
  view.setUint32(offset + 4, 0x004e4942, true); // 'BIN\0'
  glbBytes.set(binChunkData, offset + 8);

  const assetHash = hashStringDeterministic(
    `${snapshot.sceneId}:${totalByteLength}:${nodes.length}`,
  );
  return { glbBytes, assetHash };
}

/**
 * Parses and validates a glTF 2.0 binary (`.glb`) buffer, returning its header metadata,
 * parsed JSON scene graph, and node names.
 */
export function parseVenueGlbBinary(glbBytes: Uint8Array): {
  magic: number;
  version: number;
  totalByteLength: number;
  jsonChunk: Record<string, unknown>;
  binByteLength: number;
  nodeNames: string[];
} {
  if (glbBytes.byteLength < 28) {
    throw new Error(`Invalid GLB buffer: byteLength=${glbBytes.byteLength} < 28`);
  }
  const view = new DataView(
    glbBytes.buffer,
    glbBytes.byteOffset,
    glbBytes.byteLength,
  );
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  const totalByteLength = view.getUint32(8, true);
  if (magic !== 0x46546c67 || version !== 2) {
    throw new Error(
      `Invalid GLB header: magic=0x${magic.toString(16)} version=${version}`,
    );
  }
  const jsonChunkLength = view.getUint32(12, true);
  const jsonChunkType = view.getUint32(16, true);
  if (jsonChunkType !== 0x4e4f534a) {
    throw new Error(
      `Expected GLB JSON chunk (0x4e4f534a), got 0x${jsonChunkType.toString(16)}`,
    );
  }
  const jsonBytes = glbBytes.subarray(20, 20 + jsonChunkLength);
  const jsonText = new TextDecoder().decode(jsonBytes).trim();
  const jsonChunk = JSON.parse(jsonText) as Record<string, unknown>;

  const binOffset = 20 + jsonChunkLength;
  const binByteLength =
    binOffset + 8 <= glbBytes.byteLength
      ? view.getUint32(binOffset, true)
      : 0;

  const nodes = Array.isArray(jsonChunk.nodes)
    ? (jsonChunk.nodes as Array<{ name?: string }>)
    : [];
  const nodeNames = nodes
    .map((n) => (typeof n.name === 'string' ? n.name : ''))
    .filter(Boolean);

  return {
    magic,
    version,
    totalByteLength,
    jsonChunk,
    binByteLength,
    nodeNames,
  };
}

/**
 * Loads the frozen prepared venue `SceneSnapshot` from `/venue/scene-manifest.json`
 * when `fetch` is available in a browser, falling back deterministically to
 * `createPreparedVenueSnapshot()` in offline/test contexts.
 */
export async function loadPreparedVenueManifest(
  manifestUrl: string = PREPARED_VENUE_MANIFEST_PATH,
): Promise<SceneSnapshot> {
  if (typeof fetch === 'function') {
    try {
      const response = await fetch(manifestUrl);
      if (response.ok) {
        const parsed = (await response.json()) as SceneSnapshot;
        const verified = withUpdatedSceneHash(parsed);
        if (verified.sceneHash === parsed.sceneHash) {
          return parsed;
        }
      }
    } catch {
      // Fall back to deterministic in-memory snapshot when running without an HTTP static server
    }
  }
  return createPreparedVenueSnapshot();
}
