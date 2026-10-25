import type { ProfileId, ProfileRequirements, Vec3 } from './types.js';

export const CONTRACT_VERSION = '2.1.0' as const;

/**
 * Coordinate & Transform Conventions (PRD §10 Step 1)
 * - Length unit: metres (m)
 * - Up axis: +Y
 * - Angles persisted in degrees
 * - Right-handed yaw about +Y
 * - Zero yaw (0°) faces -Z: forward = [0, 0, -1], right = [+1, 0, 0]
 */
export const COORDINATE_CONVENTIONS = {
  lengthUnit: 'metres',
  angleUnit: 'degrees',
  upAxis: '+Y',
  zeroYawForward: '-Z',
  handedness: 'right-handed',
} as const;

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
export const NUMERIC_EPSILON = 1e-6;

/**
 * Converts a right-handed yaw angle (in degrees about +Y, where 0° faces -Z)
 * into a unit forward direction vector [x, y, z].
 * - yaw = 0°   -> [ 0, 0, -1]
 * - yaw = 90°  -> [-1, 0,  0]
 * - yaw = -90° -> [ 1, 0,  0]
 */
export function yawDegToForwardVector(yawDeg: number): Vec3 {
  const rad = yawDeg * DEG_TO_RAD;
  const x = -Math.sin(rad);
  const z = -Math.cos(rad);
  return [
    Math.abs(x) < NUMERIC_EPSILON ? 0 : x,
    0,
    Math.abs(z) < NUMERIC_EPSILON ? 0 : z,
  ];
}

/**
 * Converts a right-handed yaw angle (in degrees about +Y, where 0° faces -Z)
 * into a unit right-hand direction vector [x, y, z].
 * - yaw = 0°  -> [1, 0,  0]
 * - yaw = 90° -> [0, 0, -1]
 */
export function yawDegToRightVector(yawDeg: number): Vec3 {
  const rad = yawDeg * DEG_TO_RAD;
  const x = Math.cos(rad);
  const z = -Math.sin(rad);
  return [
    Math.abs(x) < NUMERIC_EPSILON ? 0 : x,
    0,
    Math.abs(z) < NUMERIC_EPSILON ? 0 : z,
  ];
}

/**
 * Visibility & Camera Constants (PRD §6)
 * - 15 cols x 9 rows = 135 target samples
 * - Clear threshold: >= 122 / 135 samples (~90.37%)
 * - Square perspective camera with 90° horizontal & vertical FOV
 */
export const VISIBILITY_GRID_COLS = 15 as const;
export const VISIBILITY_GRID_ROWS = 9 as const;
export const VISIBILITY_TOTAL_SAMPLES = 135 as const; // 15 * 9
export const VISIBILITY_CLEAR_MIN_SAMPLES = 122 as const; // >= 122/135 is clear
export const VISIBILITY_CLEAR_RATIO = VISIBILITY_CLEAR_MIN_SAMPLES / VISIBILITY_TOTAL_SAMPLES;

export const INSPECTION_CAMERA = {
  fovDeg: 90,
  aspect: 1.0,
  nearM: 0.05,
  farM: 50.0,
  defaultResolutionPx: 512,
} as const;

/**
 * Bounded Patch Constraints (PRD §4, §5)
 * - Maximum 6 operations on non-overlapping targets
 * - 0.05 m translation quantization step
 * - At most 0.60 m per horizontal axis (X or Z) per proposal
 * - At most 10° yaw change per proposal
 * - At most 1.50 m Euclidean horizontal displacement from frozen baseline
 */
export const PATCH_CONSTRAINTS = {
  maxOperations: 6,
  translationStepM: 0.05,
  maxAxisDeltaM: 0.60,
  maxYawDeltaDeg: 10,
  maxTotalDisplacementFromBaselineM: 1.50,
} as const;

/**
 * Live Run & Media Loop Timing (PRD §7)
 * - 110-second total live deadline including baseline capture, critique, verification,
 *   revised capture, and final inspection.
 */
export const RUN_TIMING = {
  liveDeadlineMs: 110_000,
  recommendedClipDurationMinSec: 10,
  recommendedClipDurationMaxSec: 15,
  devSmokeClipDurationSec: 3,
} as const;

/**
 * Default explicit audience profile presets (PRD §5).
 * Values are visible, editable before a run, and frozen during comparison.
 */
export const DEFAULT_PROFILE_REQUIREMENTS: Record<ProfileId, ProfileRequirements> = {
  reference_adult: {
    id: 'reference_adult',
    label: 'Reference seated adult',
    compatiblePlaceKinds: ['chair'],
    eyeHeightMode: 'seat_offset',
    eyeOffsetAboveSeatM: 0.78,
    requiredFootprintWidthM: 0.55,
    requiredFootprintDepthM: 0.60,
    requiredFrontLegroomM: 0.35,
    requiredRouteWidthM: 0.65,
    requiredTurningCircleDiameterM: 0,
    prefersAisle: false,
    torsoProxyHeightM: 0.85,
    torsoProxyWidthM: 0.46,
    torsoProxyDepthM: 0.30,
  },
  shorter_seated: {
    id: 'shorter_seated',
    label: 'Child / shorter seated viewer',
    compatiblePlaceKinds: ['chair'],
    eyeHeightMode: 'seat_offset',
    eyeOffsetAboveSeatM: 0.52,
    requiredFootprintWidthM: 0.50,
    requiredFootprintDepthM: 0.55,
    requiredFrontLegroomM: 0.30,
    requiredRouteWidthM: 0.65,
    requiredTurningCircleDiameterM: 0,
    prefersAisle: false,
    torsoProxyHeightM: 0.60,
    torsoProxyWidthM: 0.38,
    torsoProxyDepthM: 0.26,
  },
  wheelchair_user: {
    id: 'wheelchair_user',
    label: 'Wheelchair user',
    compatiblePlaceKinds: ['wheelchair_bay'],
    eyeHeightMode: 'independent',
    independentEyeHeightM: 1.18,
    requiredFootprintWidthM: 0.85,
    requiredFootprintDepthM: 1.25,
    requiredFrontLegroomM: 0.20,
    requiredRouteWidthM: 0.92,
    requiredTurningCircleDiameterM: 1.50,
    prefersAisle: true,
    torsoProxyHeightM: 1.25,
    torsoProxyWidthM: 0.65,
    torsoProxyDepthM: 0.60,
  },
  extra_legroom: {
    id: 'extra_legroom',
    label: 'Extra-legroom attendee (optionally labeled pregnant)',
    compatiblePlaceKinds: ['chair'],
    eyeHeightMode: 'seat_offset',
    eyeOffsetAboveSeatM: 0.75,
    requiredFootprintWidthM: 0.58,
    requiredFootprintDepthM: 0.65,
    requiredFrontLegroomM: 0.55,
    requiredRouteWidthM: 0.75,
    requiredTurningCircleDiameterM: 0,
    prefersAisle: true,
    torsoProxyHeightM: 0.83,
    torsoProxyWidthM: 0.48,
    torsoProxyDepthM: 0.34,
  },
};
