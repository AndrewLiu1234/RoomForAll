/**
 * Stream A — Camera System & Deterministic Tour Keyframe Scheduler (`src/scene/cameraSystem.ts`)
 * Exclusive ownership: Workstream A.
 *
 * Ensures 100% mathematical alignment with Stream B's evaluator by deriving
 * every attendee POV camera directly from `getAttendeeCameraPose(snapshot, attendeeId)`
 * in `src/shared/geometry.ts` (90° H/V FOV, 1:1 square aspect, exact eyePositionWorld).
 */
import * as THREE from 'three';
import {
  INSPECTION_CAMERA,
  getAttendeeCameraPose,
  type AttendeeCameraPose,
  type CaptureKeyframe,
  type ProfileId,
  type SceneSnapshot,
  type Vec3,
} from '../shared/index.js';

export type OverviewCameraPreset = 'front_high' | 'top_down' | 'stage_oblique';

export interface OverviewCameraPose {
  preset: OverviewCameraPreset;
  position: Vec3;
  lookAt: Vec3;
  up: Vec3;
  fovDeg: number;
  nearM: number;
  farM: number;
}

/**
 * Computes a clean architectural overview camera pose for `snapshot`.
 */
export function getOverviewCameraPose(
  snapshot: SceneSnapshot,
  preset: OverviewCameraPreset = 'front_high',
): OverviewCameraPose {
  const minX = snapshot.roomBounds.min[0];
  const maxX = snapshot.roomBounds.max[0];
  const minZ = snapshot.roomBounds.min[2];
  const maxZ = snapshot.roomBounds.max[2];
  const maxY = snapshot.roomBounds.max[1];

  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const span = Math.max(maxX - minX, maxZ - minZ);

  if (preset === 'top_down') {
    return {
      preset,
      position: [centerX, Math.max(maxY * 2.5, span * 0.88), centerZ + 0.01],
      lookAt: [centerX, 0.4, centerZ],
      up: [0, 0, -1],
      fovDeg: 50,
      nearM: 0.1,
      farM: 80.0,
    };
  }

  if (preset === 'stage_oblique') {
    return {
      preset,
      position: [minX * 0.78, Math.max(2.9, maxY * 0.82), minZ * 0.55],
      lookAt: [centerX + 0.3, 0.85, centerZ + 0.8],
      up: [0, 1, 0],
      fovDeg: 54,
      nearM: 0.1,
      farM: 80.0,
    };
  }

  // Default 'front_high': rear-west elevated three-quarter perspective overlooking audience toward stage
  return {
    preset: 'front_high',
    position: [centerX - span * 0.24, Math.max(3.3, maxY * 0.86), maxZ * 0.92],
    lookAt: [centerX, 0.95, centerZ - span * 0.14],
    up: [0, 1, 0],
    fovDeg: 52,
    nearM: 0.1,
    farM: 80.0,
  };
}

/**
 * Configures a Three.js `PerspectiveCamera` to match the overview pose.
 */
export function applyOverviewCameraPose(
  camera: THREE.PerspectiveCamera,
  snapshot: SceneSnapshot,
  aspect: number,
  preset: OverviewCameraPreset = 'front_high',
): OverviewCameraPose {
  const pose = getOverviewCameraPose(snapshot, preset);
  camera.fov = pose.fovDeg;
  camera.aspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1.0;
  camera.near = pose.nearM;
  camera.far = pose.farM;
  camera.up.set(pose.up[0], pose.up[1], pose.up[2]);
  camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
  camera.lookAt(pose.lookAt[0], pose.lookAt[1], pose.lookAt[2]);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return pose;
}

/**
 * Configures a Three.js `PerspectiveCamera` to match an attendee's scored POV
 * (`90°` H/V FOV, `1:1` square aspect ratio, exact `eyePositionWorld` and `lookAtWorld`).
 */
export function applyAttendeeCameraPose(
  camera: THREE.PerspectiveCamera,
  snapshot: SceneSnapshot,
  attendeeId: string,
): AttendeeCameraPose {
  const pose = getAttendeeCameraPose(snapshot, attendeeId);
  camera.fov = pose.fovDeg;
  camera.aspect = pose.aspect; // Always 1.0 (square 90° x 90° frustum per PRD §6)
  camera.near = pose.nearM;
  camera.far = pose.farM;
  camera.up.set(0, 1, 0);
  camera.position.set(
    pose.eyePositionWorld[0],
    pose.eyePositionWorld[1],
    pose.eyePositionWorld[2],
  );
  camera.lookAt(
    pose.lookAtWorld[0],
    pose.lookAtWorld[1],
    pose.lookAtWorld[2],
  );
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return pose;
}

/**
 * Applies any `CaptureKeyframe` (overview or attendee_pov) to a Three.js `PerspectiveCamera`.
 */
export function applyKeyframeToCamera(
  camera: THREE.PerspectiveCamera,
  keyframe: CaptureKeyframe,
): void {
  camera.fov = keyframe.fovDeg;
  camera.aspect = keyframe.aspect;
  camera.near = INSPECTION_CAMERA.nearM;
  camera.far = Math.max(INSPECTION_CAMERA.farM, 80.0);
  camera.up.set(0, 1, 0);
  camera.position.set(
    keyframe.cameraPosition[0],
    keyframe.cameraPosition[1],
    keyframe.cameraPosition[2],
  );
  camera.lookAt(
    keyframe.cameraLookAt[0],
    keyframe.cameraLookAt[1],
    keyframe.cameraLookAt[2],
  );
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

/**
 * Deterministically synthesizes a complete `CaptureKeyframe[]` tour schedule
 * when `tourSpec.keyframes` is empty or omitted (e.g., from `POST /api/runs`).
 *
 * Includes:
 * 1. An architectural `overview` keyframe showing the room, stage, props, and seating.
 * 2. Representative `attendee_pov` stops across the 4 profiles in priority order:
 *    - `shorter_seated` (tests low-eye-height sightline past welcome sign / chair backs)
 *    - `extra_legroom` (tests front legroom / table proximity)
 *    - `wheelchair_user` (tests bay view and approach/turning area)
 *    - `reference_adult` (baseline adult comparison view)
 */
export function buildDefaultCaptureKeyframes(
  snapshot: SceneSnapshot,
  totalDurationSec = 10,
): CaptureKeyframe[] {
  const duration = Math.max(1.0, totalDurationSec);
  const overviewPose = getOverviewCameraPose(snapshot, 'front_high');

  // Pick one representative attendee per profile in priority order, sorting by attendeeId
  // so primary test/audit attendees (*_01) are deterministically selected first.
  const priorityProfiles: ProfileId[] = [
    'shorter_seated',
    'extra_legroom',
    'wheelchair_user',
    'reference_adult',
  ];

  const sortedRoster = [...snapshot.roster].sort((a, b) =>
    a.attendeeId.localeCompare(b.attendeeId),
  );

  const selectedAttendeeIds: string[] = [];
  for (const profileId of priorityProfiles) {
    const match = sortedRoster.find(
      (a) =>
        a.profileId === profileId &&
        !selectedAttendeeIds.includes(a.attendeeId),
    );
    if (match) {
      selectedAttendeeIds.push(match.attendeeId);
    }
  }

  // If roster had fewer than 4 distinct profiles, fill with remaining roster members up to 4 POV stops
  for (const member of sortedRoster) {
    if (selectedAttendeeIds.length >= 4) break;
    if (!selectedAttendeeIds.includes(member.attendeeId)) {
      selectedAttendeeIds.push(member.attendeeId);
    }
  }

  const totalStops = 1 + selectedAttendeeIds.length;
  const slotDuration = Number((duration / totalStops).toFixed(3));
  const keyframes: CaptureKeyframe[] = [];

  // Stop 0: Overview
  keyframes.push({
    viewId: 'view_overview_room',
    label: 'Venue Overview (Rear-West Elevated)',
    kind: 'overview',
    cameraPosition: overviewPose.position,
    cameraLookAt: overviewPose.lookAt,
    fovDeg: overviewPose.fovDeg,
    aspect: 1.0,
    startSec: 0,
    endSec: totalStops === 1 ? duration : slotDuration,
  });

  // Stops 1..N: Attendee POVs
  selectedAttendeeIds.forEach((attendeeId, idx) => {
    const member = snapshot.roster.find((a) => a.attendeeId === attendeeId)!;
    const pose = getAttendeeCameraPose(snapshot, attendeeId);
    const stopIndex = idx + 1;
    const startSec = Number((stopIndex * slotDuration).toFixed(3));
    const endSec =
      stopIndex === totalStops - 1
        ? duration
        : Number(((stopIndex + 1) * slotDuration).toFixed(3));

    keyframes.push({
      viewId: `view_pov_${attendeeId}`,
      label: `${member.label} (${member.profileId} @ ${pose.placeId})`,
      kind: 'attendee_pov',
      attendeeId: member.attendeeId,
      placeId: pose.placeId,
      cameraPosition: pose.eyePositionWorld,
      cameraLookAt: pose.lookAtWorld,
      fovDeg: pose.fovDeg,
      aspect: pose.aspect,
      startSec,
      endSec,
    });
  });

  return keyframes;
}

/**
 * Resolves which keyframe in `keyframes` is active at `elapsedSec`.
 */
export function getActiveKeyframeAtTime(
  keyframes: CaptureKeyframe[],
  elapsedSec: number,
): CaptureKeyframe | undefined {
  if (keyframes.length === 0) return undefined;
  const clamped = Math.max(0, elapsedSec);
  for (const kf of keyframes) {
    if (clamped >= kf.startSec && clamped < kf.endSec) {
      return kf;
    }
  }
  return keyframes[keyframes.length - 1];
}
