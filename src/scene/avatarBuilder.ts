/**
 * Stream A — Articulated Stylized Humanoid Avatar & Exit Portal Builder (`src/scene/avatarBuilder.ts`)
 *
 * Replaces raw cylinder/box blocks with procedural articulated stylized humanoids:
 * - Head with directional visor/hairline cue so viewing yaw is immediately clear
 * - Rounded shoulders/chest torso core (`children[0]` of `proxyGroup` positioned at `torsoBox.centerWorld`
 *   so all Stream A / Stream B raycasting and coordinate assertions remain 100% identical)
 * - Articulated left/right upper & lower arms (`leftArmPivot`, `rightArmPivot`)
 * - Articulated left/right upper & lower legs (`leftLegPivot`, `rightLegPivot`) in seated or walking pose
 * - Detailed spoked wheelchair (`leftWheelPivot`, `rightWheelPivot`, push-rims, armrests, footrests) for `wheelchair_user`
 * - Dynamic pose animation (`updateAvatarAnimationPose`) for `seated`, `extricating`, `walking`, `queuing`, and `exited` states
 */
import * as THREE from 'three';
import {
  DEG_TO_RAD,
  type EvacuationAgentFrameState,
  type ProfileId,
  type SceneSnapshot,
  type WorldBoxProxy,
} from '../shared/index.js';
import { getVenueExitPortals } from '../evaluation/evacuation.js';

export interface CreateArticulatedAvatarOptions {
  attendeeId: string;
  profileId: ProfileId;
  placeId: string;
  torsoBox: WorldBoxProxy;
  baseColorHex: number;
  cleanForEvidenceCapture?: boolean;
}

const SKIN_TONE_PALETTE = [
  0xf1c27d,
  0xe0ac69,
  0xc68642,
  0x8d5524,
  0xffdbac,
];

function pickSkinColor(attendeeId: string): number {
  let hash = 0;
  for (let i = 0; i < attendeeId.length; i++) {
    hash = (hash * 31 + attendeeId.charCodeAt(i)) >>> 0;
  }
  return SKIN_TONE_PALETTE[hash % SKIN_TONE_PALETTE.length]!;
}

/**
 * Creates a stylized articulated humanoid mesh hierarchy anchored inside `torsoMesh` (`children[0]`),
 * preserving `torsoMesh.position === torsoBox.centerWorld` for exact contract compatibility.
 */
export function createArticulatedAvatarMesh(
  options: CreateArticulatedAvatarOptions,
): {
  rootMesh: THREE.Mesh;
  pickables: THREE.Object3D[];
} {
  const {
    attendeeId,
    profileId,
    placeId,
    torsoBox,
    baseColorHex,
    cleanForEvidenceCapture = false,
  } = options;

  const [wx, hy, dz] = torsoBox.size;
  const skinColor = cleanForEvidenceCapture ? 0xcbd5e1 : pickSkinColor(attendeeId);

  // Core torso chest mesh (serves as rootMesh / children[0] at torsoBox.centerWorld)
  const chestWidth = Math.max(0.26, wx * 0.72);
  const chestHeight = Math.max(0.32, hy * 0.48);
  const chestDepth = Math.max(0.18, dz * 0.62);

  const torsoGeo = new THREE.BoxGeometry(chestWidth, chestHeight, chestDepth);
  const clothMat = new THREE.MeshStandardMaterial({
    color: baseColorHex,
    roughness: 0.65,
    metalness: 0.08,
  });

  const rootMesh = new THREE.Mesh(torsoGeo, clothMat);
  rootMesh.position.set(
    torsoBox.centerWorld[0],
    torsoBox.centerWorld[1],
    torsoBox.centerWorld[2],
  );
  rootMesh.rotation.y = torsoBox.yawDeg * DEG_TO_RAD;
  rootMesh.userData = {
    ownerAttendeeId: attendeeId,
    ownerObjectId: torsoBox.ownerObjectId,
    placeId,
    profileId,
    baseCenterWorld: [...torsoBox.centerWorld],
    baseYawDeg: torsoBox.yawDeg,
    baseColorHex,
  };

  const skinMat = new THREE.MeshStandardMaterial({
    color: skinColor,
    roughness: 0.55,
    metalness: 0.04,
  });

  const darkSlacksMat = new THREE.MeshStandardMaterial({
    color: cleanForEvidenceCapture ? 0x475569 : 0x1e293b,
    roughness: 0.78,
    metalness: 0.05,
  });

  const accentMat = new THREE.MeshStandardMaterial({
    color: cleanForEvidenceCapture ? 0x334155 : 0x0f172a,
    roughness: 0.5,
    metalness: 0.15,
  });

  // 1. Rounded Shoulders Collar Bar
  const shoulderGeo = new THREE.CylinderGeometry(
    chestDepth * 0.46,
    chestDepth * 0.46,
    chestWidth * 1.08,
    12,
  );
  shoulderGeo.rotateZ(Math.PI / 2);
  const shoulderMesh = new THREE.Mesh(shoulderGeo, clothMat);
  shoulderMesh.position.set(0, chestHeight * 0.42, 0);
  rootMesh.add(shoulderMesh);

  // 2. Neck + Head + Hair/Visor Cue (facing -Z in local space)
  const headPivot = new THREE.Group();
  headPivot.name = 'avatar_head_pivot';
  headPivot.position.set(0, chestHeight * 0.52, 0);

  const neckGeo = new THREE.CylinderGeometry(0.045, 0.052, 0.08, 10);
  const neckMesh = new THREE.Mesh(neckGeo, skinMat);
  neckMesh.position.set(0, 0.03, 0);
  headPivot.add(neckMesh);

  const headRadius = Math.min(0.115, wx * 0.24);
  const headGeo = new THREE.SphereGeometry(headRadius, 16, 14);
  const headMesh = new THREE.Mesh(headGeo, skinMat);
  headMesh.position.set(0, 0.06 + headRadius * 0.88, 0);
  headPivot.add(headMesh);

  // Hair cap + directional glasses/visor band on -Z face so gaze direction is unmistakable
  const hairGeo = new THREE.SphereGeometry(
    headRadius * 1.03,
    14,
    10,
    0,
    Math.PI * 2,
    0,
    Math.PI * 0.55,
  );
  const hairMesh = new THREE.Mesh(hairGeo, accentMat);
  hairMesh.position.copy(headMesh.position);
  hairMesh.rotation.x = 0.18;
  headPivot.add(hairMesh);

  const visorGeo = new THREE.BoxGeometry(headRadius * 1.35, 0.032, 0.04);
  const visorMesh = new THREE.Mesh(visorGeo, accentMat);
  visorMesh.position.set(
    0,
    headMesh.position.y + 0.01,
    -headRadius * 0.88,
  );
  headPivot.add(visorMesh);
  rootMesh.add(headPivot);

  // 3. Articulated Left & Right Arms
  const armLength = chestHeight * 0.88;
  const armRadius = 0.038;
  const createArmPivot = (side: 'left' | 'right'): THREE.Group => {
    const sign = side === 'left' ? -1 : 1;
    const pivot = new THREE.Group();
    pivot.name = `avatar_arm_${side}`;
    pivot.position.set(sign * (chestWidth * 0.5 + armRadius * 0.85), chestHeight * 0.38, 0);

    const upperArmGeo = new THREE.CylinderGeometry(
      armRadius,
      armRadius * 0.88,
      armLength * 0.55,
      10,
    );
    const upperArm = new THREE.Mesh(upperArmGeo, clothMat);
    upperArm.position.set(0, -armLength * 0.26, 0);
    pivot.add(upperArm);

    const forearmPivot = new THREE.Group();
    forearmPivot.name = `avatar_forearm_${side}`;
    forearmPivot.position.set(0, -armLength * 0.5, 0);
    // Seated default: forearms bent forward (-Z)
    forearmPivot.rotation.x = 1.05;

    const forearmGeo = new THREE.CylinderGeometry(
      armRadius * 0.82,
      armRadius * 0.72,
      armLength * 0.48,
      10,
    );
    const forearm = new THREE.Mesh(forearmGeo, skinMat);
    forearm.position.set(0, -armLength * 0.22, 0);
    forearmPivot.add(forearm);

    pivot.add(forearmPivot);
    return pivot;
  };

  rootMesh.add(createArmPivot('left'));
  rootMesh.add(createArmPivot('right'));

  // 4. Pelvis + Articulated Legs (Seated pose by default; transitions to standing/walking during egress)
  const pelvisGeo = new THREE.BoxGeometry(
    chestWidth * 0.94,
    0.11,
    chestDepth * 0.95,
  );
  const pelvisMesh = new THREE.Mesh(pelvisGeo, darkSlacksMat);
  pelvisMesh.position.set(0, -chestHeight * 0.5 - 0.04, 0);
  rootMesh.add(pelvisMesh);

  const thighLen = profileId === 'extra_legroom' ? 0.36 : 0.31;
  const calfLen = profileId === 'extra_legroom' ? 0.36 : 0.31;
  const legRadius = 0.048;

  const createLegPivot = (side: 'left' | 'right'): THREE.Group => {
    const sign = side === 'left' ? -1 : 1;
    const hipPivot = new THREE.Group();
    hipPivot.name = `avatar_leg_${side}`;
    hipPivot.position.set(
      sign * (chestWidth * 0.27),
      -chestHeight * 0.5 - 0.06,
      0,
    );
    // Seated default: thigh extends forward along -Z (rotation.x = +Math.PI/2)
    hipPivot.rotation.x = Math.PI * 0.48;

    const thighGeo = new THREE.CylinderGeometry(
      legRadius,
      legRadius * 0.88,
      thighLen,
      10,
    );
    const thighMesh = new THREE.Mesh(thighGeo, darkSlacksMat);
    thighMesh.position.set(0, -thighLen * 0.5, 0);
    hipPivot.add(thighMesh);

    const kneePivot = new THREE.Group();
    kneePivot.name = `avatar_knee_${side}`;
    kneePivot.position.set(0, -thighLen, 0);
    // Seated default: lower leg bends straight down toward floor (rotation.x = -Math.PI/2)
    kneePivot.rotation.x = -Math.PI * 0.48;

    const calfGeo = new THREE.CylinderGeometry(
      legRadius * 0.85,
      legRadius * 0.72,
      calfLen,
      10,
    );
    const calfMesh = new THREE.Mesh(calfGeo, darkSlacksMat);
    calfMesh.position.set(0, -calfLen * 0.5, 0);
    kneePivot.add(calfMesh);

    const shoeGeo = new THREE.BoxGeometry(0.09, 0.055, 0.18);
    const shoeMesh = new THREE.Mesh(shoeGeo, accentMat);
    shoeMesh.position.set(0, -calfLen - 0.02, -0.035);
    kneePivot.add(shoeMesh);

    hipPivot.add(kneePivot);
    return hipPivot;
  };

  rootMesh.add(createLegPivot('left'));
  rootMesh.add(createLegPivot('right'));

  // 5. Detailed Spoked Wheelchair Assembly for `wheelchair_user`
  if (profileId === 'wheelchair_user') {
    const wcGroup = new THREE.Group();
    wcGroup.name = 'avatar_wheelchair_assembly';
    // Position relative to torsoBox.centerWorld so wheels rest on the floor (y = -torsoBox.centerWorld[1])
    const floorOffsetY = -torsoBox.centerWorld[1];

    const frameMat = new THREE.MeshStandardMaterial({
      color: cleanForEvidenceCapture ? 0x475569 : 0x1e293b,
      roughness: 0.35,
      metalness: 0.65,
    });
    const rimMat = new THREE.MeshStandardMaterial({
      color: cleanForEvidenceCapture ? 0x94a3b8 : 0x38bdf8,
      roughness: 0.3,
      metalness: 0.5,
    });

    // Seat pan & backrest frame
    const seatPanGeo = new THREE.BoxGeometry(0.48, 0.04, 0.44);
    const seatPan = new THREE.Mesh(seatPanGeo, frameMat);
    seatPan.position.set(0, floorOffsetY + 0.46, 0.02);
    wcGroup.add(seatPan);

    const backFrameGeo = new THREE.BoxGeometry(0.46, 0.42, 0.04);
    const backFrame = new THREE.Mesh(backFrameGeo, frameMat);
    backFrame.position.set(0, floorOffsetY + 0.68, 0.22);
    wcGroup.add(backFrame);

    // Armrests
    for (const sign of [-1, 1]) {
      const armRestGeo = new THREE.BoxGeometry(0.04, 0.03, 0.36);
      const armRest = new THREE.Mesh(armRestGeo, frameMat);
      armRest.position.set(sign * 0.25, floorOffsetY + 0.64, 0.02);
      wcGroup.add(armRest);
    }

    // Footrest plate in front (-Z)
    const footPlateGeo = new THREE.BoxGeometry(0.36, 0.025, 0.16);
    const footPlate = new THREE.Mesh(footPlateGeo, frameMat);
    footPlate.position.set(0, floorOffsetY + 0.11, -0.32);
    wcGroup.add(footPlate);

    // Large spoked rear wheels (`avatar_wheel_left`, `avatar_wheel_right`)
    const wheelRadius = 0.29;
    for (const side of ['left', 'right'] as const) {
      const sign = side === 'left' ? -1 : 1;
      const wheelPivot = new THREE.Group();
      wheelPivot.name = `avatar_wheel_${side}`;
      wheelPivot.position.set(sign * 0.28, floorOffsetY + wheelRadius, 0.08);

      const tireGeo = new THREE.TorusGeometry(wheelRadius, 0.022, 10, 24);
      tireGeo.rotateY(Math.PI / 2);
      const tireMesh = new THREE.Mesh(tireGeo, frameMat);
      wheelPivot.add(tireMesh);

      const pushRimGeo = new THREE.TorusGeometry(wheelRadius * 0.84, 0.012, 8, 20);
      pushRimGeo.rotateY(Math.PI / 2);
      const pushRimMesh = new THREE.Mesh(pushRimGeo, rimMat);
      pushRimMesh.position.set(sign * 0.018, 0, 0);
      wheelPivot.add(pushRimMesh);

      // Cross spokes so wheel rotation is clearly visible when rolling
      for (let s = 0; s < 4; s++) {
        const spokeGeo = new THREE.CylinderGeometry(
          0.006,
          0.006,
          wheelRadius * 1.9,
          6,
        );
        const spoke = new THREE.Mesh(spokeGeo, rimMat);
        spoke.rotation.x = (s * Math.PI) / 4;
        wheelPivot.add(spoke);
      }

      wcGroup.add(wheelPivot);
    }

    // Front caster wheels
    const casterRadius = 0.085;
    for (const sign of [-1, 1]) {
      const casterGeo = new THREE.CylinderGeometry(
        casterRadius,
        casterRadius,
        0.028,
        14,
      );
      casterGeo.rotateZ(Math.PI / 2);
      const caster = new THREE.Mesh(casterGeo, frameMat);
      caster.position.set(sign * 0.21, floorOffsetY + casterRadius, -0.24);
      wcGroup.add(caster);
    }

    rootMesh.add(wcGroup);
  }

  return {
    rootMesh,
    pickables: [rootMesh],
  };
}

/**
 * Updates an articulated attendee avatar's world position, yaw, and limb/wheel animation cycle
 * for a given `EvacuationAgentFrameState` (or resets to seated pose when `agentState` is undefined).
 */
export function updateAvatarAnimationPose(
  proxyGroup: THREE.Group,
  agentState: EvacuationAgentFrameState | undefined,
  elapsedSec: number,
): void {
  const rootMesh = proxyGroup.children[0] as THREE.Mesh | undefined;
  if (!rootMesh) return;

  const baseCenterWorld = (rootMesh.userData.baseCenterWorld as [
    number,
    number,
    number,
  ]) ?? [rootMesh.position.x, rootMesh.position.y, rootMesh.position.z];
  const baseYawDeg = (rootMesh.userData.baseYawDeg as number) ?? 0;
  const profileId = (rootMesh.userData.profileId as ProfileId) ?? 'reference_adult';

  const leftArm = rootMesh.getObjectByName('avatar_arm_left');
  const rightArm = rootMesh.getObjectByName('avatar_arm_right');
  const leftForearm = rootMesh.getObjectByName('avatar_forearm_left');
  const rightForearm = rootMesh.getObjectByName('avatar_forearm_right');
  const leftLeg = rootMesh.getObjectByName('avatar_leg_left');
  const rightLeg = rootMesh.getObjectByName('avatar_leg_right');
  const leftKnee = rootMesh.getObjectByName('avatar_knee_left');
  const rightKnee = rootMesh.getObjectByName('avatar_knee_right');
  const leftWheel = rootMesh.getObjectByName('avatar_wheel_left');
  const rightWheel = rootMesh.getObjectByName('avatar_wheel_right');

  // Remove or update congestion ring
  let statusRing = proxyGroup.getObjectByName(
    'evacuation_status_ring',
  ) as THREE.Mesh | undefined;

  if (!agentState || agentState.state === 'seated') {
    proxyGroup.visible = true;
    rootMesh.position.set(
      baseCenterWorld[0],
      baseCenterWorld[1],
      baseCenterWorld[2],
    );
    rootMesh.rotation.y = baseYawDeg * DEG_TO_RAD;

    if (leftArm) leftArm.rotation.x = 0;
    if (rightArm) rightArm.rotation.x = 0;
    if (leftForearm) leftForearm.rotation.x = 1.05;
    if (rightForearm) rightForearm.rotation.x = 1.05;
    if (leftLeg) leftLeg.rotation.x = Math.PI * 0.48;
    if (rightLeg) rightLeg.rotation.x = Math.PI * 0.48;
    if (leftKnee) leftKnee.rotation.x = -Math.PI * 0.48;
    if (rightKnee) rightKnee.rotation.x = -Math.PI * 0.48;
    if (statusRing) statusRing.visible = false;
    return;
  }

  if (agentState.state === 'exited') {
    proxyGroup.visible = false;
    return;
  }

  proxyGroup.visible = true;
  const isWheelchair = profileId === 'wheelchair_user';
  // Standing height lift (+0.18m above seated torso center) for walking profiles
  const standingLiftM = isWheelchair ? 0 : 0.18;
  const strideFreq = Math.max(2.5, agentState.speedMps * 4.8);
  const phase = elapsedSec * strideFreq;
  const bobM = isWheelchair
    ? 0
    : Math.abs(Math.sin(phase)) * Math.min(0.035, agentState.speedMps * 0.022);

  rootMesh.position.set(
    agentState.position[0],
    baseCenterWorld[1] + standingLiftM + bobM,
    agentState.position[1],
  );
  rootMesh.rotation.y = agentState.yawDeg * DEG_TO_RAD;

  if (isWheelchair) {
    // Wheelchair rolling cycle: arms push rims & spoked wheels rotate
    const pushSwing = Math.sin(phase) * 0.45;
    if (leftArm) leftArm.rotation.x = 0.35 + pushSwing;
    if (rightArm) rightArm.rotation.x = 0.35 + pushSwing;
    if (leftForearm) leftForearm.rotation.x = 0.85;
    if (rightForearm) rightForearm.rotation.x = 0.85;
    if (leftWheel) leftWheel.rotation.x = -elapsedSec * agentState.speedMps * 3.2;
    if (rightWheel) rightWheel.rotation.x = -elapsedSec * agentState.speedMps * 3.2;
  } else {
    // Bipedal walking / extricating stride cycle
    const swingAmp = Math.min(0.62, 0.18 + agentState.speedMps * 0.28);
    const legSwing = Math.sin(phase) * swingAmp;
    const armSwing = -Math.sin(phase) * (swingAmp * 0.75);

    if (leftLeg) leftLeg.rotation.x = legSwing;
    if (rightLeg) rightLeg.rotation.x = -legSwing;
    if (leftKnee) leftKnee.rotation.x = -Math.max(0, Math.cos(phase) * 0.38);
    if (rightKnee) rightKnee.rotation.x = -Math.max(0, -Math.cos(phase) * 0.38);

    if (leftArm) leftArm.rotation.x = armSwing;
    if (rightArm) rightArm.rotation.x = -armSwing;
    if (leftForearm) leftForearm.rotation.x = 0.45;
    if (rightForearm) rightForearm.rotation.x = 0.45;
  }

  // Highlight queuing / extricating bottleneck state with a floor ring
  if (agentState.state === 'queuing' || agentState.state === 'extricating') {
    if (!statusRing) {
      const ringGeo = new THREE.RingGeometry(0.32, 0.42, 24);
      const ringMat = new THREE.MeshBasicMaterial({
        color: agentState.state === 'queuing' ? 0xef4444 : 0xf59e0b,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.78,
      });
      statusRing = new THREE.Mesh(ringGeo, ringMat);
      statusRing.name = 'evacuation_status_ring';
      statusRing.rotation.x = -Math.PI / 2;
      proxyGroup.add(statusRing);
    }
    statusRing.visible = true;
    statusRing.position.set(agentState.position[0], 0.026, agentState.position[1]);
    const mat = statusRing.material as THREE.MeshBasicMaterial;
    mat.color.setHex(agentState.state === 'queuing' ? 0xef4444 : 0xf59e0b);
  } else if (statusRing) {
    statusRing.visible = false;
  }
}

/**
 * Adds architectural Exit Door frames and illuminated EXIT sign portals to a Three.js scene
 * so both users and Argon 4 can visually inspect primary and secondary emergency exits.
 */
export function buildVenueExitPortalNodes(snapshot: SceneSnapshot): THREE.Group {
  const portalsGroup = new THREE.Group();
  portalsGroup.name = 'venue_exit_portals';

  const isStandaloneGlb = snapshot.sceneId.startsWith('glb_standalone_');
  const portals = getVenueExitPortals(snapshot);
  for (const portal of portals) {
    const group = new THREE.Group();
    group.name = `portal_${portal.id}`;
    group.position.set(portal.position[0], 0, portal.position[1]);
    group.rotation.y = portal.yawDeg * DEG_TO_RAD;

    const doorW = portal.widthM;
    const doorH = 2.15;

    if (!isStandaloneGlb) {
      // Door frame posts & header for procedural venues
      const frameMat = new THREE.MeshStandardMaterial({
        color: portal.isEmergencyExit ? 0x059669 : 0x0284c7,
        roughness: 0.4,
        metalness: 0.3,
      });

      const postGeo = new THREE.BoxGeometry(0.08, doorH, 0.12);
      const leftPost = new THREE.Mesh(postGeo, frameMat);
      leftPost.position.set(-doorW * 0.5, doorH * 0.5, 0);
      group.add(leftPost);

      const rightPost = new THREE.Mesh(postGeo, frameMat);
      rightPost.position.set(doorW * 0.5, doorH * 0.5, 0);
      group.add(rightPost);

      const headerGeo = new THREE.BoxGeometry(doorW + 0.12, 0.1, 0.14);
      const header = new THREE.Mesh(headerGeo, frameMat);
      header.position.set(0, doorH + 0.05, 0);
      group.add(header);

      // Illuminated Overhead EXIT Sign Box
      const signBoxGeo = new THREE.BoxGeometry(0.56, 0.22, 0.08);
      const signBoxMat = new THREE.MeshStandardMaterial({
        color: 0x10b981,
        emissive: 0x059669,
        emissiveIntensity: 0.75,
        roughness: 0.25,
      });
      const signBox = new THREE.Mesh(signBoxGeo, signBoxMat);
      signBox.position.set(0, doorH + 0.22, 0);
      group.add(signBox);
    }

    // Floor egress mat at exact exit portal coordinate
    const matGeo = new THREE.PlaneGeometry(doorW, 0.55);
    const matMesh = new THREE.Mesh(
      matGeo,
      new THREE.MeshBasicMaterial({
        color: portal.isEmergencyExit ? 0x10b981 : 0x38bdf8,
        transparent: true,
        opacity: 0.28,
        side: THREE.DoubleSide,
      }),
    );
    matMesh.rotation.x = -Math.PI / 2;
    matMesh.position.set(0, 0.014, 0);
    group.add(matMesh);

    portalsGroup.add(group);
  }

  return portalsGroup;
}
