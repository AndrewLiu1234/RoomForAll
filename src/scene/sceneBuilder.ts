/**
 * Stream A — Three.js Scene Builder & Self-Occlusion Visibility Controller (`src/scene/sceneBuilder.ts`)
 * Exclusive ownership: Workstream A.
 *
 * Guarantees:
 * 1. Exact world-space alignment with `SceneSnapshot`, `ProxyPrimitive`, and `getAttendeeTorsoProxyWorldBox`.
 * 2. Self-occlusion exclusion (PRD §6 & ARGON_MVP_PROMPT §5): when rendering from an attendee's POV,
 *    the viewer's own chair/bay (`place.objectId`) and own seated torso/head proxy
 *    (`proxy_attendee_torso_${attendeeId}`) are hidden while all other occupied places remain visible.
 * 3. Clean evidence capture mode (`cleanForEvidenceCapture: true`): strips all diagnostic overlays,
 *    selection rings, route debug lines, and pass/fail indicators so Argon inspects genuine visual geometry.
 * 4. Complete GPU resource disposal (`disposeVenueScene`) to prevent WebGL context/memory leaks.
 */
import * as THREE from 'three';
import {
  DEG_TO_RAD,
  getAttendeeTorsoProxyWorldBox,
  getTargetSamplePointsWorld,
  yawDegToForwardVector,
  yawDegToRightVector,
  type EvacuationSimResult,
  type ProfileId,
  type ProxyPrimitive,
  type SceneObject,
  type SceneSnapshot,
  type Vec3,
} from '../shared/index.js';
import {
  buildVenueExitPortalNodes,
  createArticulatedAvatarMesh,
  updateAvatarAnimationPose,
} from './avatarBuilder.js';

export interface BuildVenueSceneOptions {
  /**
   * When true, omits all interactive overlays (selection rings, route polylines,
   * turning pad guides, target sample dots) so recorded video contains zero
   * answer-revealing heatmaps or labels (PRD §7).
   */
  cleanForEvidenceCapture?: boolean;
  /** Currently selected attendee ID for interactive highlight in overview mode */
  selectedAttendeeId?: string;
  /** Current camera mode ('overview' shows all proxies; 'attendee_pov' hides active viewer's own proxy/chair) */
  viewMode?: 'overview' | 'attendee_pov';
  /** Show route corridors and wheelchair turning pads in interactive overview */
  showRoutes?: boolean;
  /** Show 15x9 target sample grid points in interactive overview */
  showTargetGrid?: boolean;
  /** Optional object IDs to highlight (e.g. modified objects in a patch comparison) */
  highlightedObjectIds?: string[];
}

export interface BuiltVenueScene {
  scene: THREE.Scene;
  objectNodesById: Map<string, THREE.Object3D>;
  attendeeProxyNodesById: Map<string, THREE.Object3D>;
  pickableMeshes: THREE.Object3D[];
}

const PROFILE_TORSO_COLORS: Record<ProfileId, number> = {
  reference_adult: 0x64748b,
  shorter_seated: 0x38bdf8,
  wheelchair_user: 0xa78bfa,
  extra_legroom: 0xfbbf24,
};

/**
 * Computes the world-space center and yaw (in degrees) of a `ProxyPrimitive`
 * attached to a `SceneObject`, using the right-handed +Y rotation convention.
 */
export function getProxyWorldTransform(
  obj: SceneObject,
  proxy: ProxyPrimitive,
): { centerWorld: Vec3; yawDeg: number } {
  const right = yawDegToRightVector(obj.transform.yawDeg);
  const forward = yawDegToForwardVector(obj.transform.yawDeg);
  const [lx, ly, lz] = proxy.localPosition;

  // Local +X is `right`, Local -Z is `forward` (so Local +Z is `-forward`):
  // At yawDeg = 90° (facing -X), forward = [-1, 0, 0], so a chair back at lz = +0.22
  // sits at wx = ox + 0.22 (+X, directly behind the viewer).
  const wx = obj.transform.position[0] + lx * right[0] - lz * forward[0];
  const wy = obj.transform.position[1] + ly;
  const wz = obj.transform.position[2] + lx * right[2] - lz * forward[2];

  return {
    centerWorld: [wx, wy, wz],
    yawDeg: obj.transform.yawDeg + proxy.localYawDeg,
  };
}

/**
 * Builds a complete Three.js `Scene` from `snapshot`.
 */
export function buildVenueThreeScene(
  snapshot: SceneSnapshot,
  options: BuildVenueSceneOptions = {},
): BuiltVenueScene {
  const clean = options.cleanForEvidenceCapture ?? false;
  const viewMode = options.viewMode ?? 'overview';
  const selectedAttendeeId = options.selectedAttendeeId;
  const showRoutes = clean ? false : (options.showRoutes ?? true);
  const showTargetGrid = clean ? false : (options.showTargetGrid ?? false);
  const highlightedSet = new Set(clean ? [] : (options.highlightedObjectIds ?? []));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a);

  const objectNodesById = new Map<string, THREE.Object3D>();
  const attendeeProxyNodesById = new Map<string, THREE.Object3D>();
  const pickableMeshes: THREE.Object3D[] = [];

  // Map objectId -> attendeeId for click picking and metadata
  const objectToAttendeeMap = new Map<string, string>();
  const placeByObjectId = new Map(snapshot.places.map((p) => [p.objectId, p]));
  for (const member of snapshot.roster) {
    const place = snapshot.places.find((p) => p.id === member.assignedPlaceId);
    if (place) {
      objectToAttendeeMap.set(place.objectId, member.attendeeId);
    }
  }

  // 1. Fixed Lighting Condition (PRD §8: one fixed lighting condition in P0)
  const ambientLight = new THREE.AmbientLight(0xdbeafe, 0.85);
  scene.add(ambientLight);

  const hemiLight = new THREE.HemisphereLight(0xf8fafc, 0x1e293b, 0.65);
  hemiLight.position.set(0, snapshot.roomBounds.max[1], 0);
  scene.add(hemiLight);

  const mainDirLight = new THREE.DirectionalLight(0xfffbeb, 1.05);
  mainDirLight.position.set(3.5, snapshot.roomBounds.max[1] * 1.4, 4.5);
  scene.add(mainDirLight);

  const fillDirLight = new THREE.DirectionalLight(0x93c5fd, 0.45);
  fillDirLight.position.set(-4.0, snapshot.roomBounds.max[1] * 1.1, -3.5);
  scene.add(fillDirLight);

  // 2. Room Floor, Walls & Reserved Circulation Markings
  const minX = snapshot.roomBounds.min[0];
  const maxX = snapshot.roomBounds.max[0];
  const minZ = snapshot.roomBounds.min[2];
  const maxZ = snapshot.roomBounds.max[2];
  const maxY = snapshot.roomBounds.max[1];
  const roomW = maxX - minX;
  const roomD = maxZ - minZ;
  const roomCenterX = (minX + maxX) / 2;
  const roomCenterZ = (minZ + maxZ) / 2;

  const floorGeo = new THREE.BoxGeometry(roomW, 0.08, roomD);
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.88,
    metalness: 0.08,
  });
  const floorMesh = new THREE.Mesh(floorGeo, floorMat);
  floorMesh.position.set(roomCenterX, -0.04, roomCenterZ);
  floorMesh.name = 'venue_floor';
  scene.add(floorMesh);

  // Subtle architectural 1m floor grid at Y=0.003m for spatial scale & depth perception
  const gridSpan = Math.max(roomW, roomD);
  const floorGrid = new THREE.GridHelper(
    gridSpan,
    Math.round(gridSpan),
    0x334155,
    0x1e293b,
  );
  floorGrid.position.set(roomCenterX, 0.003, roomCenterZ);
  floorGrid.name = 'venue_floor_grid';
  scene.add(floorGrid);

  // Physical floor accessibility markings for wheelchair bay turning circles (on floor at Y=0.006m)
  for (const place of snapshot.places) {
    if (place.turningPadCenter && place.turningPadDiameterM) {
      const radius = place.turningPadDiameterM / 2;
      const padRingGeo = new THREE.RingGeometry(radius - 0.035, radius, 40);
      const padRingMat = new THREE.MeshBasicMaterial({
        color: 0x60a5fa,
        side: THREE.DoubleSide,
      });
      const padRingMesh = new THREE.Mesh(padRingGeo, padRingMat);
      padRingMesh.rotation.x = -Math.PI / 2;
      padRingMesh.position.set(
        place.turningPadCenter[0],
        0.006,
        place.turningPadCenter[1],
      );
      padRingMesh.name = `floor_marking_turning_pad_${place.id}`;
      scene.add(padRingMesh);
    }
  }

  // Low subtle perimeter baseboard / stage back wall so viewer has spatial depth cues
  const backWallGeo = new THREE.BoxGeometry(roomW, maxY, 0.12);
  const backWallMat = new THREE.MeshStandardMaterial({
    color: 0x172033,
    roughness: 0.92,
  });
  const backWallMesh = new THREE.Mesh(backWallGeo, backWallMat);
  backWallMesh.position.set(roomCenterX, maxY / 2, minZ - 0.06);
  backWallMesh.name = 'venue_stage_back_wall';
  scene.add(backWallMesh);

  // Side perimeter wainscoting rails (0.9m high) so overview cameras aren't blocked by tall walls
  const sideRailHeight = 0.9;
  const sideWallGeo = new THREE.BoxGeometry(0.1, sideRailHeight, roomD);
  const sideWallMat = new THREE.MeshStandardMaterial({
    color: 0x243047,
    roughness: 0.85,
  });
  const westWall = new THREE.Mesh(sideWallGeo, sideWallMat);
  westWall.position.set(minX - 0.05, sideRailHeight / 2, roomCenterZ);
  scene.add(westWall);

  const eastWall = new THREE.Mesh(sideWallGeo, sideWallMat);
  eastWall.position.set(maxX + 0.05, sideRailHeight / 2, roomCenterZ);
  scene.add(eastWall);

  // 3. Visible Presentation Target Panel (PRD §6: must match scored target region)
  const targetGroup = new THREE.Group();
  targetGroup.name = snapshot.target.id;
  targetGroup.position.set(
    snapshot.target.center[0],
    snapshot.target.center[1],
    snapshot.target.center[2],
  );
  // Target yawDeg = 180 faces +Z; in Three.js BoxGeometry is symmetric
  targetGroup.rotation.y = (snapshot.target.yawDeg - 180) * DEG_TO_RAD;

  // Outer bezel
  const bezelGeo = new THREE.BoxGeometry(
    snapshot.target.widthM + 0.14,
    snapshot.target.heightM + 0.14,
    0.05,
  );
  const bezelMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    roughness: 0.5,
    metalness: 0.3,
  });
  const bezelMesh = new THREE.Mesh(bezelGeo, bezelMat);
  bezelMesh.position.set(0, 0, -0.03);
  targetGroup.add(bezelMesh);

  // Illuminated presentation surface (exact widthM x heightM)
  const screenGeo = new THREE.BoxGeometry(
    snapshot.target.widthM,
    snapshot.target.heightM,
    0.02,
  );
  const screenMat = new THREE.MeshStandardMaterial({
    color: 0xe0f2fe,
    emissive: 0xbae6fd,
    emissiveIntensity: 0.55,
    roughness: 0.25,
  });
  const screenMesh = new THREE.Mesh(screenGeo, screenMat);
  targetGroup.add(screenMesh);

  // High-contrast slide visual bands on the screen so Argon clearly recognizes screen content vs occluders
  const headerBandGeo = new THREE.BoxGeometry(
    snapshot.target.widthM * 0.88,
    snapshot.target.heightM * 0.18,
    0.026,
  );
  const headerBandMat = new THREE.MeshStandardMaterial({
    color: 0x0284c7,
    emissive: 0x0369a1,
    emissiveIntensity: 0.4,
  });
  const headerBand = new THREE.Mesh(headerBandGeo, headerBandMat);
  headerBand.position.set(0, snapshot.target.heightM * 0.3, 0.004);
  targetGroup.add(headerBand);

  const centerCrossGeo = new THREE.BoxGeometry(
    snapshot.target.widthM * 0.78,
    snapshot.target.heightM * 0.42,
    0.024,
  );
  const centerCrossMat = new THREE.MeshStandardMaterial({
    color: 0x1e3a8a,
    emissive: 0x1d4ed8,
    emissiveIntensity: 0.25,
  });
  const centerCross = new THREE.Mesh(centerCrossGeo, centerCrossMat);
  centerCross.position.set(0, -snapshot.target.heightM * 0.08, 0.003);
  targetGroup.add(centerCross);

  scene.add(targetGroup);

  // Optional 15x9 sample dots (only in interactive overview when toggled, never in clean capture)
  if (showTargetGrid && !clean) {
    const samplePoints = getTargetSamplePointsWorld(snapshot.target);
    const dotGeo = new THREE.SphereGeometry(0.025, 8, 8);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee });
    const sampleGroup = new THREE.Group();
    sampleGroup.name = 'debug_target_samples_135';
    for (const pt of samplePoints) {
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.set(pt[0], pt[1], pt[2] + 0.02);
      sampleGroup.add(dot);
    }
    scene.add(sampleGroup);
  }

  // 4. SceneObjects & Simplified Blocking Proxies (PRD §4: show the same simplified geometry in the scored scene)
  for (const obj of snapshot.objects) {
    const objGroup = new THREE.Group();
    objGroup.name = obj.id;
    const attendeeId = objectToAttendeeMap.get(obj.id);
    const place = placeByObjectId.get(obj.id);
    const isHighlighted = highlightedSet.has(obj.id);

    objGroup.userData = {
      ownerObjectId: obj.id,
      ownerAttendeeId: attendeeId,
      placeId: place?.id,
      category: obj.category,
      editable: obj.editable,
    };

    // Render each authoritative ProxyPrimitive in world space
    for (const proxy of obj.proxies) {
      const worldTf = getProxyWorldTransform(obj, proxy);
      let geo: THREE.BufferGeometry;
      if (proxy.kind === 'cylinder') {
        const r = proxy.radiusM ?? 0.25;
        const h = proxy.heightM ?? 1.0;
        geo = new THREE.CylinderGeometry(r, r, h, 24);
      } else {
        const [sx, sy, sz] = proxy.size ?? [0.5, 0.5, 0.5];
        geo = new THREE.BoxGeometry(sx, sy, sz);
      }

      const color = getObjectMaterialColor(obj, isHighlighted);
      const mat = new THREE.MeshStandardMaterial({
        color,
        roughness: obj.category === 'movable_prop' ? 0.45 : 0.72,
        metalness: obj.category === 'fixed_structure' ? 0.25 : 0.1,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = proxy.id;
      mesh.position.set(
        worldTf.centerWorld[0],
        worldTf.centerWorld[1],
        worldTf.centerWorld[2],
      );
      mesh.rotation.y = worldTf.yawDeg * DEG_TO_RAD;
      mesh.userData = {
        ownerObjectId: obj.id,
        ownerAttendeeId: attendeeId,
        placeId: place?.id,
        proxyId: proxy.id,
      };
      objGroup.add(mesh);
      if (attendeeId) {
        pickableMeshes.push(mesh);
      }
    }

    // For movable chairs: add the horizontal seat cushion and 4 legs below `place.seatHeightM`
    // (purely within the chair footprint below the top of the chair back proxy, never adding extra occlusion)
    if (obj.category === 'movable_chair') {
      const seatH = place?.seatHeightM ?? 0.45;
      const seatW = Math.min(place?.widthM ?? 0.54, 0.54);
      const seatD = 0.46;
      const cushionGeo = new THREE.BoxGeometry(seatW, 0.05, seatD);
      const cushionMat = new THREE.MeshStandardMaterial({
        color: isHighlighted ? 0x38bdf8 : 0x475569,
        roughness: 0.65,
      });
      const cushionMesh = new THREE.Mesh(cushionGeo, cushionMat);
      cushionMesh.position.set(
        obj.transform.position[0],
        obj.transform.position[1] + seatH - 0.025,
        obj.transform.position[2],
      );
      cushionMesh.rotation.y = obj.transform.yawDeg * DEG_TO_RAD;
      cushionMesh.userData = {
        ownerObjectId: obj.id,
        ownerAttendeeId: attendeeId,
        placeId: place?.id,
      };
      objGroup.add(cushionMesh);
      if (attendeeId) {
        pickableMeshes.push(cushionMesh);
      }
    }

    // For wheelchair bays: render floor-level accessible bay pad (0.015m flat mat on floor)
    if (obj.category === 'wheelchair_bay_frame' && place) {
      const bayGeo = new THREE.BoxGeometry(place.widthM, 0.016, place.depthM);
      const bayMat = new THREE.MeshStandardMaterial({
        color: 0x2563eb,
        roughness: 0.6,
      });
      const bayMesh = new THREE.Mesh(bayGeo, bayMat);
      bayMesh.position.set(
        obj.transform.position[0],
        obj.transform.position[1] + 0.008,
        obj.transform.position[2],
      );
      bayMesh.rotation.y = obj.transform.yawDeg * DEG_TO_RAD;
      bayMesh.userData = {
        ownerObjectId: obj.id,
        ownerAttendeeId: attendeeId,
        placeId: place.id,
      };
      objGroup.add(bayMesh);
      if (attendeeId) {
        pickableMeshes.push(bayMesh);
      }
    }

    scene.add(objGroup);
    objectNodesById.set(obj.id, objGroup);
  }

  // 4b. Architectural Exit Door Portals & Illuminated EXIT Signs
  scene.add(buildVenueExitPortalNodes(snapshot));

  // 5. Finite-Height Seated Attendee Articulated Avatars (PRD §4, §6: other occupied places are occluders)
  for (const member of snapshot.roster) {
    const torsoBox = getAttendeeTorsoProxyWorldBox(snapshot, member.attendeeId);
    const proxyGroup = new THREE.Group();
    proxyGroup.name = torsoBox.id;
    proxyGroup.userData = {
      ownerAttendeeId: member.attendeeId,
      ownerObjectId: torsoBox.ownerObjectId,
      placeId: member.assignedPlaceId,
      profileId: member.profileId,
    };

    const baseColor = clean
      ? 0x64748b
      : (PROFILE_TORSO_COLORS[member.profileId] ?? 0x64748b);
    const { rootMesh: torsoMesh } = createArticulatedAvatarMesh({
      attendeeId: member.attendeeId,
      profileId: member.profileId,
      placeId: member.assignedPlaceId,
      torsoBox,
      baseColorHex: baseColor,
      cleanForEvidenceCapture: clean,
    });
    proxyGroup.add(torsoMesh);
    pickableMeshes.push(torsoMesh);

    // Interactive selection ring on floor in overview mode (omitted in clean evidence capture)
    if (!clean && selectedAttendeeId === member.attendeeId) {
      const ringGeo = new THREE.RingGeometry(0.36, 0.44, 32);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        side: THREE.DoubleSide,
      });
      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      ringMesh.rotation.x = -Math.PI / 2;
      ringMesh.position.set(
        torsoBox.centerWorld[0],
        0.022,
        torsoBox.centerWorld[2],
      );
      proxyGroup.add(ringMesh);
    }

    scene.add(proxyGroup);
    attendeeProxyNodesById.set(member.attendeeId, proxyGroup);
  }

  // 6. Optional Route Corridors & Turning Circles in Interactive Overview (never in clean capture)
  if (showRoutes && !clean) {
    const routeGroup = new THREE.Group();
    routeGroup.name = 'interactive_route_guides';

    for (const route of snapshot.routes) {
      if (route.waypoints.length < 2) continue;
      const points = route.waypoints.map(
        ([wx, wz]) => new THREE.Vector3(wx, 0.025, wz),
      );
      const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
      const lineMat = new THREE.LineBasicMaterial({ color: 0x34d399 });
      const line = new THREE.Line(lineGeo, lineMat);
      routeGroup.add(line);
    }

    for (const place of snapshot.places) {
      if (place.turningPadCenter && place.turningPadDiameterM) {
        const radius = place.turningPadDiameterM / 2;
        const padGeo = new THREE.RingGeometry(radius - 0.03, radius, 40);
        const padMat = new THREE.MeshBasicMaterial({
          color: 0xa78bfa,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.55,
        });
        const padMesh = new THREE.Mesh(padGeo, padMat);
        padMesh.rotation.x = -Math.PI / 2;
        padMesh.position.set(
          place.turningPadCenter[0],
          0.018,
          place.turningPadCenter[1],
        );
        routeGroup.add(padMesh);
      }
    }

    scene.add(routeGroup);
  }

  // 7. Apply self-occlusion visibility rule for initial viewMode / selectedAttendeeId
  applyActiveViewerVisibility(
    scene,
    snapshot,
    viewMode,
    selectedAttendeeId,
    objectNodesById,
    attendeeProxyNodesById,
  );

  return {
    scene,
    objectNodesById,
    attendeeProxyNodesById,
    pickableMeshes,
  };
}

function getObjectMaterialColor(
  obj: SceneObject,
  isHighlighted: boolean,
): number {
  if (isHighlighted) return 0x22d3ee;
  switch (obj.category) {
    case 'stage':
      return 0x334155;
    case 'fixed_structure':
      return 0x64748b;
    case 'movable_prop':
      // High-contrast warm amber/terracotta for movable props (welcome sign, catering table, AV cart)
      // so Argon and human reviewers can immediately distinguish movable obstructions from chairs/pillars
      return 0xd97706;
    case 'wheelchair_bay_frame':
      return 0x2563eb;
    case 'movable_chair':
    default:
      return 0x475569;
  }
}

/**
 * Enforces the PRD §6 & ARGON_MVP_PROMPT §5 self-occlusion rule:
 * "Include finite-height blockers, chair backs, and simple other-attendee proxies;
 *  exclude the viewer's own proxy and chair."
 */
export function applyActiveViewerVisibility(
  scene: THREE.Scene,
  snapshot: SceneSnapshot,
  viewMode: 'overview' | 'attendee_pov',
  activeAttendeeId?: string,
  objectNodesById?: Map<string, THREE.Object3D>,
  attendeeProxyNodesById?: Map<string, THREE.Object3D>,
): { hiddenObjectId?: string; hiddenAttendeeProxyId?: string } {
  // First restore visibility on all tracked nodes
  if (objectNodesById) {
    for (const node of objectNodesById.values()) {
      node.visible = true;
    }
  } else {
    scene.traverse((child) => {
      if (child.userData?.ownerObjectId || child.userData?.ownerAttendeeId) {
        child.visible = true;
      }
    });
  }

  if (attendeeProxyNodesById) {
    for (const node of attendeeProxyNodesById.values()) {
      node.visible = true;
    }
  }

  if (viewMode !== 'attendee_pov' || !activeAttendeeId) {
    return {};
  }

  const member = snapshot.roster.find((a) => a.attendeeId === activeAttendeeId);
  if (!member) {
    return {};
  }

  const place = snapshot.places.find((p) => p.id === member.assignedPlaceId);
  const ownObjectId = place?.objectId;

  // Hide viewer's own chair/bay SceneObject
  if (ownObjectId) {
    const objNode = objectNodesById?.get(ownObjectId);
    if (objNode) {
      objNode.visible = false;
    } else {
      scene.traverse((child) => {
        if (child.userData?.ownerObjectId === ownObjectId) {
          child.visible = false;
        }
      });
    }
  }

  // Hide viewer's own torso/head proxy
  const proxyNode = attendeeProxyNodesById?.get(activeAttendeeId);
  if (proxyNode) {
    proxyNode.visible = false;
  } else {
    scene.traverse((child) => {
      if (child.userData?.ownerAttendeeId === activeAttendeeId) {
        child.visible = false;
      }
    });
  }

  return {
    hiddenObjectId: ownObjectId,
    hiddenAttendeeProxyId: `proxy_attendee_torso_${activeAttendeeId}`,
  };
}

/**
 * Updates all articulated attendee avatars in `attendeeProxyNodesById` for a given `elapsedSec`
 * within `simResult` (interpolating smoothly between 0.2s simulation frames).
 * When `simResult` is null/undefined, resets all avatars to their seated poses.
 */
export function updateSceneEvacuationStep(
  attendeeProxyNodesById: Map<string, THREE.Object3D>,
  simResult: EvacuationSimResult | null | undefined,
  elapsedSec: number,
): {
  exitedCount: number;
  queuingCount: number;
  activeCount: number;
} {
  if (!simResult || simResult.frames.length === 0) {
    for (const node of attendeeProxyNodesById.values()) {
      updateAvatarAnimationPose(node as THREE.Group, undefined, 0);
    }
    return {
      exitedCount: 0,
      queuingCount: 0,
      activeCount: attendeeProxyNodesById.size,
    };
  }

  const clampedTime = Math.max(
    0,
    Math.min(simResult.durationSec, elapsedSec),
  );

  // Locate surrounding frames for smooth linear interpolation
  let f0 = simResult.frames[0]!;
  let f1 = simResult.frames[simResult.frames.length - 1]!;
  for (let i = 0; i < simResult.frames.length - 1; i++) {
    const curr = simResult.frames[i]!;
    const next = simResult.frames[i + 1]!;
    if (clampedTime >= curr.timeSec && clampedTime <= next.timeSec) {
      f0 = curr;
      f1 = next;
      break;
    }
  }

  const span = Math.max(1e-4, f1.timeSec - f0.timeSec);
  const alpha = Math.max(0, Math.min(1, (clampedTime - f0.timeSec) / span));

  let exitedCount = 0;
  let queuingCount = 0;
  let activeCount = 0;

  for (const [attendeeId, node] of attendeeProxyNodesById.entries()) {
    const s0 = f0.agents[attendeeId];
    const s1 = f1.agents[attendeeId] ?? s0;
    if (!s0) continue;

    const interpX = s0.position[0] + (s1!.position[0] - s0.position[0]) * alpha;
    const interpZ = s0.position[1] + (s1!.position[1] - s0.position[1]) * alpha;

    // Shortest-angle yaw interpolation
    let dYaw = ((s1!.yawDeg - s0.yawDeg + 540) % 360) - 180;
    const interpYaw = s0.yawDeg + dYaw * alpha;
    const interpSpeed = s0.speedMps + (s1!.speedMps - s0.speedMps) * alpha;
    const state = alpha < 0.5 ? s0.state : s1!.state;

    if (state === 'exited') {
      exitedCount += 1;
    } else {
      activeCount += 1;
      if (state === 'queuing' || state === 'extricating') {
        queuingCount += 1;
      }
    }

    updateAvatarAnimationPose(
      node as THREE.Group,
      {
        position: [interpX, interpZ],
        yawDeg: interpYaw,
        speedMps: interpSpeed,
        state,
        targetExitId: s0.targetExitId,
      },
      clampedTime,
    );
  }

  return { exitedCount, queuingCount, activeCount };
}

/**
 * Deterministically disposes all geometries, materials, and textures in `scene`
 * to prevent WebGL memory leaks across re-renders and capture passes.
 */
export function disposeVenueScene(scene: THREE.Scene): void {
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    if (mesh.material) {
      const materials = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      for (const mat of materials) {
        for (const value of Object.values(mat)) {
          if (value && typeof value === 'object' && 'isTexture' in value) {
            (value as THREE.Texture).dispose();
          }
        }
        mat.dispose();
      }
    }
  });
  scene.clear();
}
