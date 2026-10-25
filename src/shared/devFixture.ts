import {
  CONTRACT_VERSION,
  DEFAULT_PROFILE_REQUIREMENTS,
} from './constants.js';
import { withUpdatedSceneHash } from './hash.js';
import type { SceneSnapshot } from './types.js';

/**
 * Shared development fixture (`src/shared/devFixture.ts`) per PRD §10 Step 1:
 * Allows Streams B, C, and D to build and test immediately while Stream A
 * prepares the full 24-place venue asset.
 *
 * Geometry guarantees (verified by Adversarial Critic):
 * - Presentation target on stage at Z = -5.5m (facing +Z, yaw = 180°)
 * - Every assigned place satisfies its attendee's `requiredFootprintWidthM` and `requiredFootprintDepthM`
 * - `att_shorter_01` at `place_chair_r2_c1` ([0.0, 0.0, 0.5]) sits along X = 0.0 between
 *   the two front-row chairs (`[-1.2, 0.0, -0.8]` and `[1.2, 0.0, -0.8]`), occluded specifically
 *   by the movable freestanding sign `obj_prop_sign_01` at `[0.0, 0.0, -1.8]` (width 0.50m, height 1.15m).
 * - Moving `obj_prop_sign_01` by `deltaPositionM: [-0.55, 0, 0]` (within the <= 0.60m single-op limit
 *   and 0.05m step) cleanly resolves `att_shorter_01`'s sightline without regressing any other profile.
 * - Final-approach route anchors connect from the main corridor (`route_main_west`) without slicing
 *   through any other occupied chair or wheelchair bay.
 */
export function createDevFixtureSnapshot(): SceneSnapshot {
  const base: Omit<SceneSnapshot, 'sceneHash'> = {
    contractVersion: CONTRACT_VERSION,
    sceneId: 'dev_fixture_hall_v1',
    source: {
      sourceId: 'dev_fixture',
      title: 'VenuePilot Shared Development Fixture (4-Place Compact Hall)',
      license: 'CC0-1.0',
      isFallbackFixture: true,
      preparationNotes:
        'Compact 4-place development fixture for parallel stream development and unit tests.',
    },
    roomBounds: {
      min: [-5.0, 0.0, -7.0],
      max: [5.0, 4.0, 6.0],
    },
    allowedFloorRegions: [
      { minX: -4.2, maxX: 4.2, minZ: -3.5, maxZ: 5.0 },
    ],
    reservedCirculationRegions: [
      // West entrance corridor that furniture must not intrude into
      { minX: -4.2, maxX: -2.8, minZ: -2.5, maxZ: 5.0 },
    ],
    target: {
      id: 'target_main_screen',
      label: 'Main Presentation Screen',
      center: [0.0, 1.65, -5.5],
      yawDeg: 180,
      widthM: 3.2,
      heightM: 1.8,
    },
    objects: [
      {
        id: 'obj_stage_platform',
        label: 'Stage Platform',
        category: 'stage',
        editable: false,
        transform: { position: [0.0, 0.0, -5.5], yawDeg: 0 },
        baselineTransform: { position: [0.0, 0.0, -5.5], yawDeg: 0 },
        proxies: [
          {
            id: 'proxy_stage_box',
            kind: 'box',
            localPosition: [0.0, 0.25, 0.0],
            localYawDeg: 0,
            size: [6.0, 0.5, 2.0],
            blocksVisibility: false,
            blocksMovement: true,
          },
        ],
      },
      {
        id: 'obj_prop_sign_01',
        label: 'Movable Welcome Sign / Lectern Banner',
        category: 'movable_prop',
        editable: true,
        transform: { position: [0.0, 0.0, -1.1], yawDeg: 0 },
        baselineTransform: { position: [0.0, 0.0, -1.1], yawDeg: 0 },
        allowedBounds: { minX: -2.6, maxX: 2.6, minZ: -3.2, maxZ: 1.0 },
        proxies: [
          {
            id: 'proxy_prop_sign_01',
            kind: 'box',
            localPosition: [0.0, 0.54, 0.0],
            localYawDeg: 0,
            // 0.36m wide x 1.08m tall sign centered at X=0.0, Z=-1.1: blocks shorter viewer at [0, 0, 0.5] (114/135 < 122),
            // and can be shifted by dx = -0.60m (<= 0.60m patch limit) to completely clear all 4 profiles (135/135).
            size: [0.36, 1.08, 0.2],
            blocksVisibility: true,
            blocksMovement: true,
          },
        ],
      },
      {
        id: 'obj_chair_r1_c1',
        label: 'Row 1 Left Chair',
        category: 'movable_chair',
        editable: true,
        groupId: 'group_row1',
        transform: { position: [-1.2, 0.0, -0.8], yawDeg: 0 },
        baselineTransform: { position: [-1.2, 0.0, -0.8], yawDeg: 0 },
        allowedBounds: { minX: -2.5, maxX: 2.5, minZ: -2.2, maxZ: 2.5 },
        proxies: [
          {
            id: 'proxy_chair_r1_c1_back',
            kind: 'box',
            localPosition: [0.0, 0.44, 0.22],
            localYawDeg: 0,
            size: [0.55, 0.88, 0.08],
            blocksVisibility: true,
            blocksMovement: true,
          },
        ],
      },
      {
        id: 'obj_chair_r1_c2',
        label: 'Row 1 Right Chair (Aisle)',
        category: 'movable_chair',
        editable: true,
        groupId: 'group_row1',
        transform: { position: [1.2, 0.0, -0.8], yawDeg: 0 },
        baselineTransform: { position: [1.2, 0.0, -0.8], yawDeg: 0 },
        allowedBounds: { minX: -2.5, maxX: 2.5, minZ: -2.2, maxZ: 2.5 },
        proxies: [
          {
            id: 'proxy_chair_r1_c2_back',
            kind: 'box',
            localPosition: [0.0, 0.44, 0.22],
            localYawDeg: 0,
            size: [0.58, 0.88, 0.08],
            blocksVisibility: true,
            blocksMovement: true,
          },
        ],
      },
      {
        id: 'obj_chair_r2_c1',
        label: 'Row 2 Center Chair',
        category: 'movable_chair',
        editable: true,
        transform: { position: [0.0, 0.0, 0.5], yawDeg: 0 },
        baselineTransform: { position: [0.0, 0.0, 0.5], yawDeg: 0 },
        allowedBounds: { minX: -2.5, maxX: 2.5, minZ: -1.0, maxZ: 3.5 },
        proxies: [
          {
            id: 'proxy_chair_r2_c1_back',
            kind: 'box',
            localPosition: [0.0, 0.44, 0.22],
            localYawDeg: 0,
            size: [0.55, 0.88, 0.08],
            blocksVisibility: true,
            blocksMovement: true,
          },
        ],
      },
      {
        id: 'obj_bay_wc_01',
        label: 'Wheelchair Bay 1',
        category: 'wheelchair_bay_frame',
        editable: false,
        transform: { position: [-2.2, 0.0, -0.8], yawDeg: 0 },
        baselineTransform: { position: [-2.2, 0.0, -0.8], yawDeg: 0 },
        proxies: [],
      },
    ],
    chairGroups: [
      {
        id: 'group_row1',
        label: 'Row 1 Chair Pair',
        memberObjectIds: ['obj_chair_r1_c1', 'obj_chair_r1_c2'],
        transform: { position: [0.0, 0.0, -0.8], yawDeg: 0 },
        baselineTransform: { position: [0.0, 0.0, -0.8], yawDeg: 0 },
        allowedBounds: { minX: -2.5, maxX: 2.5, minZ: -2.2, maxZ: 2.5 },
      },
    ],
    places: [
      {
        id: 'place_chair_r1_c1',
        label: 'Seat R1-1',
        kind: 'chair',
        objectId: 'obj_chair_r1_c1',
        seatHeightM: 0.45,
        widthM: 0.60,
        depthM: 0.65,
        isAisle: false,
        routeId: 'route_main_west',
        routeAnchorPoint: [-1.2, 1.8],
      },
      {
        id: 'place_chair_r1_c2',
        label: 'Seat R1-2 (Aisle)',
        kind: 'chair',
        objectId: 'obj_chair_r1_c2',
        seatHeightM: 0.45,
        widthM: 0.62,
        depthM: 0.70,
        isAisle: true,
        routeId: 'route_main_west',
        routeAnchorPoint: [1.2, 1.8],
      },
      {
        id: 'place_chair_r2_c1',
        label: 'Seat R2-1',
        kind: 'chair',
        objectId: 'obj_chair_r2_c1',
        seatHeightM: 0.45,
        widthM: 0.60,
        depthM: 0.65,
        isAisle: false,
        routeId: 'route_main_west',
        routeAnchorPoint: [0.0, 1.8],
      },
      {
        id: 'place_bay_wc_01',
        label: 'Wheelchair Bay W1',
        kind: 'wheelchair_bay',
        objectId: 'obj_bay_wc_01',
        seatHeightM: 0.0,
        widthM: 0.95,
        depthM: 1.35,
        isAisle: true,
        routeId: 'route_main_west',
        routeAnchorPoint: [-3.4, 0.5],
        turningPadCenter: [-2.0, 1.3],
        turningPadDiameterM: 1.55,
      },
    ],
    routes: [
      {
        id: 'route_main_west',
        label: 'West Entrance & Rear Cross-Aisle Corridor',
        waypoints: [
          [-3.4, 4.5],
          [-3.4, 1.8],
          [1.2, 1.8],
        ],
        widthM: 1.2,
      },
    ],
    profiles: structuredClone(DEFAULT_PROFILE_REQUIREMENTS),
    roster: [
      {
        attendeeId: 'att_adult_01',
        label: 'Alex (Reference Adult)',
        profileId: 'reference_adult',
        assignedPlaceId: 'place_chair_r1_c1',
      },
      {
        attendeeId: 'att_extra_legroom_01',
        label: 'Morgan (Extra-Legroom)',
        profileId: 'extra_legroom',
        assignedPlaceId: 'place_chair_r1_c2',
      },
      {
        attendeeId: 'att_shorter_01',
        label: 'Sam (Shorter Viewer)',
        profileId: 'shorter_seated',
        assignedPlaceId: 'place_chair_r2_c1',
      },
      {
        attendeeId: 'att_wheelchair_01',
        label: 'Jordan (Wheelchair User)',
        profileId: 'wheelchair_user',
        assignedPlaceId: 'place_bay_wc_01',
      },
    ],
  };

  return withUpdatedSceneHash(base);
}
