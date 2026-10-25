import {
  INSPECTION_CAMERA,
  PATCH_CONSTRAINTS,
  VISIBILITY_GRID_COLS,
  VISIBILITY_GRID_ROWS,
  yawDegToForwardVector,
  yawDegToRightVector,
} from './constants.js';
import type {
  AttendeeAssignment,
  BlindCritiquePayload,
  EvidenceManifest,
  PresentationTarget,
  SceneSnapshot,
  Transform3D,
  Vec3,
} from './types.js';

export interface AttendeeCameraPose {
  attendeeId: string;
  placeId: string;
  eyePositionWorld: Vec3;
  lookDirectionWorld: Vec3;
  lookAtWorld: Vec3;
  fovDeg: number;
  aspect: number;
  nearM: number;
  farM: number;
}

export interface WorldBoxProxy {
  id: string;
  ownerAttendeeId?: string;
  ownerObjectId?: string;
  centerWorld: Vec3;
  size: Vec3;
  yawDeg: number;
}

/**
 * Computes the canonical camera pose for an attendee in `snapshot`.
 * Shared between Stream A (Three.js camera rendering) and Stream B (15x9 visibility frustum)
 * so rendered inspection clips and evaluator raycasts match identically (PRD §6).
 *
 * Camera points along the seat/bay horizontal forward vector (`yawDegToForwardVector(yawDeg)`),
 * matching a level seated viewer looking straight ahead from their seat orientation.
 */
export function getAttendeeCameraPose(
  snapshot: SceneSnapshot,
  attendeeId: string,
): AttendeeCameraPose {
  const member: AttendeeAssignment | undefined = snapshot.roster.find(
    (a) => a.attendeeId === attendeeId,
  );
  if (!member) {
    throw new Error(`Attendee ${attendeeId} not found in snapshot roster.`);
  }

  const profile = snapshot.profiles[member.profileId];
  const place = snapshot.places.find((p) => p.id === member.assignedPlaceId);
  if (!place) {
    throw new Error(
      `Assigned place ${member.assignedPlaceId} for attendee ${attendeeId} not found.`,
    );
  }

  const obj = snapshot.objects.find((o) => o.id === place.objectId);
  if (!obj) {
    throw new Error(
      `SceneObject ${place.objectId} for place ${place.id} not found.`,
    );
  }

  const [ox, oy, oz] = obj.transform.position;
  const yawDeg = obj.transform.yawDeg;

  const eyeY =
    profile.eyeHeightMode === 'independent'
      ? (profile.independentEyeHeightM ?? 1.18)
      : place.seatHeightM + (profile.eyeOffsetAboveSeatM ?? 0.75);

  const eyePositionWorld: Vec3 = [ox, oy + eyeY, oz];
  const forward = yawDegToForwardVector(yawDeg);
  const lookAtWorld: Vec3 = [
    eyePositionWorld[0] + forward[0] * 5.0,
    eyePositionWorld[1] + forward[1] * 5.0,
    eyePositionWorld[2] + forward[2] * 5.0,
  ];

  return {
    attendeeId: member.attendeeId,
    placeId: place.id,
    eyePositionWorld,
    lookDirectionWorld: forward,
    lookAtWorld,
    fovDeg: INSPECTION_CAMERA.fovDeg,
    aspect: INSPECTION_CAMERA.aspect,
    nearM: INSPECTION_CAMERA.nearM,
    farM: INSPECTION_CAMERA.farM,
  };
}

/**
 * Computes the world-space 3D geometric center box for an occupied attendee's
 * finite-height seated torso/head occlusion proxy (PRD §4, §6).
 * Shared between Stream A (rendered proxy mesh) and Stream B (raycast occlusion).
 */
export function getAttendeeTorsoProxyWorldBox(
  snapshot: SceneSnapshot,
  attendeeId: string,
): WorldBoxProxy {
  const member = snapshot.roster.find((a) => a.attendeeId === attendeeId);
  if (!member) {
    throw new Error(`Attendee ${attendeeId} not found in snapshot roster.`);
  }
  const profile = snapshot.profiles[member.profileId];
  const place = snapshot.places.find((p) => p.id === member.assignedPlaceId);
  if (!place) {
    throw new Error(`Place ${member.assignedPlaceId} not found.`);
  }
  const obj = snapshot.objects.find((o) => o.id === place.objectId);
  if (!obj) {
    throw new Error(`SceneObject ${place.objectId} not found.`);
  }

  const [ox, oy, oz] = obj.transform.position;
  const baseHeight = place.kind === 'wheelchair_bay' ? 0 : place.seatHeightM;
  const centerY = oy + baseHeight + profile.torsoProxyHeightM / 2;

  return {
    id: `proxy_attendee_torso_${attendeeId}`,
    ownerAttendeeId: attendeeId,
    ownerObjectId: obj.id,
    centerWorld: [ox, centerY, oz],
    size: [
      profile.torsoProxyWidthM,
      profile.torsoProxyHeightM,
      profile.torsoProxyDepthM,
    ],
    yawDeg: obj.transform.yawDeg,
  };
}

/**
 * Generates the deterministic 15 x 9 = 135 world-space sample points across
 * the presentation target panel (PRD §6).
 */
export function getTargetSamplePointsWorld(target: PresentationTarget): Vec3[] {
  const right = yawDegToRightVector(target.yawDeg);
  const [cx, cy, cz] = target.center;
  const points: Vec3[] = [];

  for (let row = 0; row < VISIBILITY_GRID_ROWS; row++) {
    const v = (row + 0.5) / VISIBILITY_GRID_ROWS - 0.5; // -0.5 .. +0.5
    const y = cy + v * target.heightM;
    for (let col = 0; col < VISIBILITY_GRID_COLS; col++) {
      const u = (col + 0.5) / VISIBILITY_GRID_COLS - 0.5; // -0.5 .. +0.5
      const x = cx + right[0] * (u * target.widthM);
      const z = cz + right[2] * (u * target.widthM);
      points.push([x, y, z]);
    }
  }
  return points;
}

/**
 * Applies a group delta transform (`deltaPositionM`, `deltaYawDeg`) to a member
 * `SceneObject`'s world-space transform, rotating horizontally around `groupOriginPosition`.
 */
export function applyGroupDeltaToMemberTransform(
  memberTransform: Transform3D,
  groupOriginPosition: Vec3,
  deltaPositionM: [number, number, number],
  deltaYawDeg: number,
): Transform3D {
  const rad = (deltaYawDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const relX = memberTransform.position[0] - groupOriginPosition[0];
  const relZ = memberTransform.position[2] - groupOriginPosition[2];

  // Right-handed rotation about +Y: x' = x*cos - z*sin, z' = x*sin + z*cos
  const rotX = relX * cos - relZ * sin;
  const rotZ = relX * sin + relZ * cos;

  return {
    position: [
      groupOriginPosition[0] + rotX + deltaPositionM[0],
      memberTransform.position[1] + (deltaPositionM[1] ?? 0),
      groupOriginPosition[2] + rotZ + deltaPositionM[2],
    ],
    yawDeg: memberTransform.yawDeg + deltaYawDeg,
  };
}

/**
 * Builds the sanitized first-call payload for Argon visual critique (PRD §7).
 * Explicitly omits any `Evaluation`, pass/fail flags, sampled visibility scores,
 * or `primaryBlockerIds` so Argon performs a genuine visual critique from the clip.
 */
export function createBlindCritiquePayload(
  snapshot: SceneSnapshot,
  evidenceManifest: EvidenceManifest,
): BlindCritiquePayload {
  return {
    contractVersion: snapshot.contractVersion,
    sceneHash: snapshot.sceneHash,
    evidenceManifest,
    profiles: structuredClone(snapshot.profiles),
    roster: structuredClone(snapshot.roster),
    editableObjects: snapshot.objects
      .filter((o) => o.editable)
      .map((o) => ({
        id: o.id,
        label: o.label,
        category: o.category,
        groupId: o.groupId,
        transform: structuredClone(o.transform),
        baselineTransform: structuredClone(o.baselineTransform),
        allowedBounds: o.allowedBounds
          ? structuredClone(o.allowedBounds)
          : undefined,
      })),
    chairGroups: structuredClone(snapshot.chairGroups),
    places: structuredClone(snapshot.places),
    routes: structuredClone(snapshot.routes),
    target: structuredClone(snapshot.target),
    roomBounds: structuredClone(snapshot.roomBounds),
    patchConstraints: PATCH_CONSTRAINTS,
  };
}
