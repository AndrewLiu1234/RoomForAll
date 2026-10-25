import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  INSPECTION_CAMERA,
  getAttendeeCameraPose,
  withUpdatedSceneHash,
  type Evaluation,
  type EvacuationMode,
  type ProfileId,
} from '../shared/index.js';
import { getVenueExitPortals, simulateEvacuation } from '../evaluation/index.js';
import {
  disposeVenueScene,
  getGlbAlignmentForScene,
  getUploadedGlbBytesForScene,
  getUploadedGlbGroupForScene,
  updateSceneEvacuationStep,
  type VenueViewportProps,
} from '../scene/index.js';
import { populateThreeSceneFromSnapshot } from './evidenceCaptureBridge.js';
import { computeAttendeeSampleVisibilityMask } from './localEvaluatorFallback.js';

export type ViewportCameraMode = 'overview' | 'attendee_pov' | 'flythrough';

export interface InteractiveViewportStageProps
  extends Omit<VenueViewportProps, 'viewMode'> {
  viewMode: ViewportCameraMode;
  evaluation: Evaluation;
  showSightlineOverlays: boolean;
  onToggleViewMode: (mode: ViewportCameraMode) => void;
  onToggleSightlineOverlays: () => void;
  onAddAttendeeAtPlace?: (placeId: string, profileId?: ProfileId) => void;
  onRemoveAttendee?: (attendeeId: string) => void;
}

function formatShortSeat(placeId: string, fallbackLabel?: string): string {
  if (fallbackLabel) {
    const match = fallbackLabel.match(/\b(R\d+-C\d+|R\d+-\d+|W-?\d+|Bay\s*\d+)\b/i);
    if (match?.[1]) return match[1].toUpperCase();
  }
  return placeId
    .replace(/^place_/, '')
    .replace(/_/g, '-')
    .toUpperCase();
}

function cleanGuestName(rawLabel: string): string {
  const idx = rawLabel.indexOf('(');
  return idx > 0 ? rawLabel.slice(0, idx).trim() : rawLabel.trim();
}

export function VenueViewportStage({
  snapshot,
  selectedAttendeeId,
  viewMode,
  onSelectAttendee,
  evaluation,
  showSightlineOverlays,
  onToggleViewMode,
  onToggleSightlineOverlays,
  onAddAttendeeAtPlace,
  onRemoveAttendee,
}: InteractiveViewportStageProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const renderFrameRef = useRef<(() => void) | null>(null);
  const attendeeProxyNodesRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const defaultDistance = snapshot.places.length > 8 ? 10.6 : 7.2;

  const [selectedEmptyPlaceId, setSelectedEmptyPlaceId] = useState<
    string | null
  >(null);
  const [flyHudReadout, setFlyHudReadout] = useState<{
    pos: [number, number, number];
    turbo: boolean;
  }>({
    pos: [0, 1.75, 4.2],
    turbo: false,
  });

  const [evacMode, setEvacMode] = useState<EvacuationMode>('none');
  const [evacTimeSec, setEvacTimeSec] = useState<number>(0);
  const [isPlayingEvac, setIsPlayingEvac] = useState<boolean>(false);
  const [exitOverrides, setExitOverrides] = useState<
    Record<string, { x?: number; z?: number }>
  >({});
  const [showExitOptimizer, setShowExitOptimizer] = useState<boolean>(false);
  const [evacCounts, setEvacCounts] = useState<{
    exitedCount: number;
    queuingCount: number;
    activeCount: number;
  }>({ exitedCount: 0, queuingCount: 0, activeCount: snapshot.roster.length });

  const effectiveSnapshot = useMemo(() => {
    if (Object.keys(exitOverrides).length === 0) return snapshot;
    const cloned = structuredClone(snapshot);
    if (!cloned.exits) {
      cloned.exits = structuredClone(getVenueExitPortals(cloned));
    }
    for (const [id, override] of Object.entries(exitOverrides)) {
      const exit = cloned.exits.find((e) => e.id === id);
      if (exit) {
        if (typeof override.x === 'number') exit.position[0] = override.x;
        if (typeof override.z === 'number') exit.position[1] = override.z;
      }
    }
    return withUpdatedSceneHash(cloned);
  }, [snapshot, exitOverrides]);

  const rawPortals = useMemo(
    () => getVenueExitPortals(effectiveSnapshot),
    [effectiveSnapshot],
  );
  const westExitZ =
    exitOverrides.exit_main_west?.z ??
    rawPortals.find((p) => p.id === 'exit_main_west')?.position[1] ??
    -1.8;
  const eastExitZ =
    exitOverrides.exit_emergency_east?.z ??
    rawPortals.find((p) => p.id === 'exit_emergency_east')?.position[1] ??
    1.2;
  const terraceExitX =
    exitOverrides.exit_wheelchair_terrace?.x ??
    rawPortals.find((p) => p.id === 'exit_wheelchair_terrace')?.position[0] ??
    0.0;

  const evacSimResult = useMemo(() => {
    if (evacMode === 'none') return null;
    return simulateEvacuation(effectiveSnapshot, evacMode);
  }, [effectiveSnapshot, evacMode]);

  const [orbitAngles, setOrbitAngles] = useState<{
    azimuthRad: number;
    polarRad: number;
    distanceM: number;
  }>(() => ({
    azimuthRad: 0.38,
    polarRad: 0.92,
    distanceM: defaultDistance,
  }));

  const flyPoseRef = useRef<{
    position: [number, number, number];
    yawRad: number;
    pitchRad: number;
  }>({
    position: [0.0, 1.75, 4.2],
    yawRad: 0.0,
    pitchRad: -0.12,
  });

  const pressedKeysRef = useRef<Set<string>>(new Set());
  const viewModeRef = useRef<ViewportCameraMode>(viewMode);
  viewModeRef.current = viewMode;
  const onToggleViewModeRef = useRef(onToggleViewMode);
  onToggleViewModeRef.current = onToggleViewMode;

  useEffect(() => {
    setOrbitAngles({
      azimuthRad: 0.38,
      polarRad: 0.92,
      distanceM: snapshot.places.length > 8 ? 10.6 : 7.2,
    });
    setSelectedEmptyPlaceId(null);
    flyPoseRef.current = {
      position: [0.0, 1.85, 4.4],
      yawRad: 0.0,
      pitchRad: -0.14,
    };
  }, [snapshot.sceneId]);

  const dragStateRef = useRef<{
    dragging: boolean;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
  }>({
    dragging: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
  });

  const selectedAttendee = snapshot.roster.find(
    (a) => a.attendeeId === selectedAttendeeId,
  );
  const selectedEval = selectedAttendeeId
    ? evaluation.attendees[selectedAttendeeId]
    : undefined;
  const selectedProfile = selectedAttendee
    ? snapshot.profiles[selectedAttendee.profileId]
    : undefined;
  const selectedPlace = selectedAttendee
    ? snapshot.places.find((p) => p.id === selectedAttendee.assignedPlaceId)
    : undefined;
  const selectedEmptyPlace = selectedEmptyPlaceId
    ? snapshot.places.find((p) => p.id === selectedEmptyPlaceId)
    : undefined;

  const obstructedAttendees = useMemo(
    () =>
      snapshot.roster.filter(
        (m) => evaluation.attendees[m.attendeeId]?.clearAndUsable === false,
      ),
    [snapshot.roster, evaluation.attendees],
  );

  const stepAttendee = (delta: number): void => {
    if (!onSelectAttendee || snapshot.roster.length === 0) return;
    const currentIdx = snapshot.roster.findIndex(
      (a) => a.attendeeId === selectedAttendeeId,
    );
    const nextIdx =
      (Math.max(0, currentIdx) + delta + snapshot.roster.length) %
      snapshot.roster.length;
    const nextMember = snapshot.roster[nextIdx];
    if (nextMember) {
      setSelectedEmptyPlaceId(null);
      onSelectAttendee(nextMember.attendeeId);
    }
  };

  const jumpToNextIssue = (): void => {
    if (!onSelectAttendee || obstructedAttendees.length === 0) return;
    const idx = obstructedAttendees.findIndex(
      (a) => a.attendeeId === selectedAttendeeId,
    );
    const nextIssue =
      obstructedAttendees[(idx + 1) % obstructedAttendees.length];
    if (nextIssue) {
      setSelectedEmptyPlaceId(null);
      onSelectAttendee(nextIssue.attendeeId);
    }
  };

  // 1. Mount / Unmount Effect: Persistent WebGLRenderer + WASD/E/C/Shift Flythrough loop
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof document === 'undefined') return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance',
      });
    } catch {
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const width = Math.max(320, container.clientWidth);
    const height = Math.max(320, container.clientHeight);
    renderer.setSize(width, height);
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    rendererRef.current = renderer;
    sceneRef.current = new THREE.Scene();
    cameraRef.current = new THREE.PerspectiveCamera(
      52,
      width / height,
      INSPECTION_CAMERA.nearM,
      INSPECTION_CAMERA.farM,
    );

    const handleResize = (): void => {
      renderFrameRef.current?.();
    };

    const isFormInputFocused = (target: EventTarget | null): boolean => {
      const el = (target ?? document.activeElement) as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName?.toUpperCase();
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        el.isContentEditable
      );
    };

    const FLY_KEYS = new Set(['w', 'a', 's', 'd', 'e', 'c', 'shift']);

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isFormInputFocused(e.target)) return;
      const key = e.key.toLowerCase();
      if (!FLY_KEYS.has(key)) return;

      if (viewModeRef.current !== 'flythrough' && key !== 'shift') {
        const cam = cameraRef.current;
        if (cam) {
          const dir = new THREE.Vector3();
          cam.getWorldDirection(dir);
          const yaw = Math.atan2(-dir.x, -dir.z);
          const pitch = Math.asin(Math.max(-0.95, Math.min(0.95, dir.y)));
          flyPoseRef.current = {
            position: [cam.position.x, cam.position.y, cam.position.z],
            yawRad: yaw,
            pitchRad: pitch,
          };
        }
        onToggleViewModeRef.current('flythrough');
      }

      pressedKeysRef.current.add(key);
    };

    const handleKeyUp = (e: KeyboardEvent): void => {
      const key = e.key.toLowerCase();
      pressedKeysRef.current.delete(key);
    };

    const clearKeys = (): void => {
      pressedKeysRef.current.clear();
    };

    let rafId: number | null = null;
    let lastTimeMs = performance.now();
    let hudTickCounter = 0;

    const stepFlythroughFrame = (nowMs: number): void => {
      const dtSec = Math.min(0.1, Math.max(0.001, (nowMs - lastTimeMs) / 1000));
      lastTimeMs = nowMs;

      if (
        viewModeRef.current === 'flythrough' &&
        pressedKeysRef.current.size > 0
      ) {
        const keys = pressedKeysRef.current;
        const isTurbo = keys.has('shift');
        const speedMps = isTurbo ? 10.5 : 3.6;
        const stepM = speedMps * dtSec;

        const yaw = flyPoseRef.current.yawRad;
        const fwdX = -Math.sin(yaw);
        const fwdZ = -Math.cos(yaw);
        const rightX = Math.cos(yaw);
        const rightZ = -Math.sin(yaw);

        let moveX = 0;
        let moveY = 0;
        let moveZ = 0;

        if (keys.has('w')) {
          moveX += fwdX;
          moveZ += fwdZ;
        }
        if (keys.has('s')) {
          moveX -= fwdX;
          moveZ -= fwdZ;
        }
        if (keys.has('d')) {
          moveX += rightX;
          moveZ += rightZ;
        }
        if (keys.has('a')) {
          moveX -= rightX;
          moveZ -= rightZ;
        }
        if (keys.has('e')) {
          moveY += 1;
        }
        if (keys.has('c')) {
          moveY -= 1;
        }

        const horizMag = Math.hypot(moveX, moveZ);
        if (horizMag > 1e-5) {
          flyPoseRef.current.position[0] += (moveX / horizMag) * stepM;
          flyPoseRef.current.position[2] += (moveZ / horizMag) * stepM;
        }
        if (moveY !== 0) {
          flyPoseRef.current.position[1] = Math.max(
            0.25,
            Math.min(12.0, flyPoseRef.current.position[1] + moveY * stepM),
          );
        }

        if (horizMag > 1e-5 || moveY !== 0) {
          renderFrameRef.current?.();
          hudTickCounter += 1;
          if (hudTickCounter % 4 === 0) {
            setFlyHudReadout({
              pos: [...flyPoseRef.current.position],
              turbo: isTurbo,
            });
          }
        }
      }

      rafId = window.requestAnimationFrame(stepFlythroughFrame);
    };

    rafId = window.requestAnimationFrame(stepFlythroughFrame);

    window.addEventListener('resize', handleResize);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', clearKeys);
    document.addEventListener('visibilitychange', clearKeys);

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', clearKeys);
      document.removeEventListener('visibilitychange', clearKeys);
      if (sceneRef.current) {
        disposeVenueScene(sceneRef.current);
        sceneRef.current = null;
      }
      if (rendererRef.current) {
        rendererRef.current.dispose();
        try {
          rendererRef.current.forceContextLoss();
        } catch {
          // Ignore if extension unavailable
        }
        rendererRef.current = null;
      }
      cameraRef.current = null;
      container.innerHTML = '';
    };
  }, []);

  // 2. Scene Rebuild Effect
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    disposeVenueScene(scene);

    populateThreeSceneFromSnapshot(scene, effectiveSnapshot, {
      hideAttendeeId:
        viewMode === 'attendee_pov' ? selectedAttendeeId : undefined,
      forBlindEvidenceCapture: false,
    });

    const proxyMap = new Map<string, THREE.Object3D>();
    scene.traverse((child) => {
      if (
        child.name.startsWith('proxy_attendee_torso_') &&
        child.userData?.ownerAttendeeId
      ) {
        proxyMap.set(child.userData.ownerAttendeeId as string, child);
      }
    });
    attendeeProxyNodesRef.current = proxyMap;

    let cancelled = false;
    const cachedGroup = getUploadedGlbGroupForScene(snapshot.sceneId);
    const rawGlbBytes = getUploadedGlbBytesForScene(snapshot.sceneId);
    if (!cachedGroup && rawGlbBytes && rawGlbBytes.byteLength > 20_000) {
      const loader = new GLTFLoader();
      const sliceBuffer = rawGlbBytes.buffer.slice(
        rawGlbBytes.byteOffset,
        rawGlbBytes.byteOffset + rawGlbBytes.byteLength,
      ) as ArrayBuffer;
      loader.parse(
        sliceBuffer,
        '',
        (gltf) => {
          if (cancelled || sceneRef.current !== scene) return;
          const align = getGlbAlignmentForScene(snapshot.sceneId);
          const archGroup = gltf.scene;
          archGroup.name = 'uploaded_glb_architectural_shell';
          archGroup.rotation.y = align.rotationYRad;
          archGroup.scale.set(align.scale, align.scale, align.scale);
          archGroup.position.set(
            align.position[0],
            align.position[1],
            align.position[2],
          );
          for (const obj of snapshot.objects) {
            const dx =
              obj.transform.position[0] - obj.baselineTransform.position[0];
            const dy =
              obj.transform.position[1] - obj.baselineTransform.position[1];
            const dz =
              obj.transform.position[2] - obj.baselineTransform.position[2];
            const dYaw = obj.transform.yawDeg - obj.baselineTransform.yawDeg;
            if (
              Math.abs(dx) > 1e-4 ||
              Math.abs(dy) > 1e-4 ||
              Math.abs(dz) > 1e-4 ||
              Math.abs(dYaw) > 1e-4
            ) {
              const targetNode = archGroup.getObjectByName(obj.id);
              if (targetNode) {
                targetNode.position.x += dx;
                targetNode.position.y += dy;
                targetNode.position.z += dz;
                targetNode.rotation.y += (dYaw * Math.PI) / 180;
              }
            }
          }
          scene.add(archGroup);
          renderFrameRef.current?.();
        },
        () => {
          // Ignore parse error
        },
      );
    }

    const occupantByPlaceId = new Map(
      snapshot.roster.map((m) => [m.assignedPlaceId, m]),
    );

    if (viewMode !== 'attendee_pov') {
      const seatBeaconGeo = new THREE.SphereGeometry(0.095, 16, 16);
      const seatStemGeo = new THREE.CylinderGeometry(0.016, 0.016, 0.24, 8);

      // Render 3D Seat Indicators for ALL parsed places at their true 3D [x, y, z] elevation
      for (const place of snapshot.places) {
        const obj = snapshot.objects.find((o) => o.id === place.objectId);
        if (!obj) continue;

        const baseX = obj.transform.position[0];
        const baseY = obj.transform.position[1];
        const baseZ = obj.transform.position[2];
        const seatPanY =
          baseY + (place.kind === 'chair' ? place.seatHeightM : 0.04);

        const occupant = occupantByPlaceId.get(place.id);
        const isSelectedOccupant =
          occupant && occupant.attendeeId === selectedAttendeeId;
        const isSelectedEmpty =
          !occupant && place.id === selectedEmptyPlaceId;
        const attEval = occupant
          ? evaluation.attendees[occupant.attendeeId]
          : undefined;

        const indicatorColor = isSelectedOccupant || isSelectedEmpty
          ? 0x38bdf8
          : occupant
            ? !attEval
              ? 0x94a3b8
              : attEval.clearAndUsable
                ? 0x10b981
                : 0xef4444
            : 0x0ea5e9;

        const chairElevation = Math.max(0.04, obj.transform.position[1]);
        const ringGeo = new THREE.RingGeometry(
          isSelectedOccupant || isSelectedEmpty ? 0.22 : 0.17,
          isSelectedOccupant || isSelectedEmpty ? 0.30 : 0.24,
          28,
        );
        const ringMat = new THREE.MeshBasicMaterial({
          color: indicatorColor,
          side: THREE.DoubleSide,
          transparent: !occupant && !isSelectedEmpty,
          opacity: !occupant && !isSelectedEmpty ? 0.82 : 0.98,
        });
        const ringMesh = new THREE.Mesh(ringGeo, ringMat);
        ringMesh.rotation.x = -Math.PI / 2;
        ringMesh.position.set(baseX, seatPanY + 0.02, baseZ);
        ringMesh.userData = {
          placeId: place.id,
          attendeeId: occupant?.attendeeId,
        };
        scene.add(ringMesh);

        // Final approach segment from routeAnchorPoint to seat
        if (occupant) {
          const approachPts = [
            new THREE.Vector3(
              place.routeAnchorPoint[0],
              chairElevation + 0.01,
              place.routeAnchorPoint[1],
            ),
            new THREE.Vector3(
              obj.transform.position[0],
              chairElevation + 0.01,
              obj.transform.position[2],
            ),
          ];
          const appGeo = new THREE.BufferGeometry().setFromPoints(approachPts);
          const appMat = new THREE.LineBasicMaterial({
            color: attEval?.routeStatus === 'blocked' ? 0xef4444 : 0x22c55e,
          });
          scene.add(new THREE.Line(appGeo, appMat));
        }

        if (!occupant || isSelectedOccupant) {
          const beaconMat = new THREE.MeshBasicMaterial({
            color: isSelectedEmpty ? 0xfacc15 : indicatorColor,
          });
          const beaconMesh = new THREE.Mesh(seatBeaconGeo, beaconMat);
          beaconMesh.position.set(baseX, seatPanY + 0.26, baseZ);
          beaconMesh.userData = {
            placeId: place.id,
            attendeeId: occupant?.attendeeId,
          };
          scene.add(beaconMesh);

          const stemMat = new THREE.MeshBasicMaterial({
            color: indicatorColor,
            transparent: true,
            opacity: 0.7,
          });
          const stemMesh = new THREE.Mesh(seatStemGeo, stemMat);
          stemMesh.position.set(baseX, seatPanY + 0.14, baseZ);
          stemMesh.userData = {
            placeId: place.id,
            attendeeId: occupant?.attendeeId,
          };
          scene.add(stemMesh);
        }

        const hitGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.65, 16);
        const hitMat = new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          transparent: true,
          opacity: isSelectedEmpty ? 0.26 : 0.0,
          depthWrite: false,
        });
        const hitMesh = new THREE.Mesh(hitGeo, hitMat);
        hitMesh.position.set(baseX, seatPanY + 0.22, baseZ);
        hitMesh.userData = {
          placeId: place.id,
          attendeeId: occupant?.attendeeId,
        };
        scene.add(hitMesh);

        if (occupant && place.turningPadCenter && place.turningPadDiameterM) {
          const padR = place.turningPadDiameterM * 0.5;
          const padGeo = new THREE.RingGeometry(padR - 0.035, padR, 36);
          const padMat = new THREE.MeshBasicMaterial({
            color: attEval?.turningSpacePass === false ? 0xef4444 : 0xa78bfa,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.65,
          });
          const padMesh = new THREE.Mesh(padGeo, padMat);
          padMesh.rotation.x = -Math.PI / 2;
          padMesh.position.set(
            place.turningPadCenter[0],
            0.018,
            place.turningPadCenter[1],
          );
          scene.add(padMesh);
        }
      }

      for (const obj of snapshot.objects) {
        const dx = obj.transform.position[0] - obj.baselineTransform.position[0];
        const dz = obj.transform.position[2] - obj.baselineTransform.position[2];
        const dist = Math.hypot(dx, dz);
        if (dist > 0.01) {
          const ghostGeo = new THREE.RingGeometry(0.18, 0.25, 24);
          const ghostMat = new THREE.MeshBasicMaterial({
            color: 0xfbbf24,
            side: THREE.DoubleSide,
          });
          const ghostMesh = new THREE.Mesh(ghostGeo, ghostMat);
          ghostMesh.rotation.x = -Math.PI / 2;
          ghostMesh.position.set(
            obj.baselineTransform.position[0],
            obj.baselineTransform.position[1] + 0.035,
            obj.baselineTransform.position[2],
          );
          scene.add(ghostMesh);

          const dir = new THREE.Vector3(dx, 0, dz).normalize();
          const origin = new THREE.Vector3(
            obj.baselineTransform.position[0],
            obj.baselineTransform.position[1] + 0.12,
            obj.baselineTransform.position[2],
          );
          const arrow = new THREE.ArrowHelper(
            dir,
            origin,
            dist,
            0x34d399,
            Math.min(0.22, dist * 0.4),
            0.14,
          );
          scene.add(arrow);
        }
      }
    }

    if (showSightlineOverlays && selectedAttendeeId && selectedAttendee) {
      const { samplePoints, visibleMask } = computeAttendeeSampleVisibilityMask(
        snapshot,
        selectedAttendeeId,
      );
      const pose = getAttendeeCameraPose(snapshot, selectedAttendeeId);

      const dotGeo = new THREE.SphereGeometry(0.03, 8, 8);
      const clearMat = new THREE.MeshBasicMaterial({ color: 0x10b981 });
      const blockedMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });

      samplePoints.forEach((pt, idx) => {
        const isClear = visibleMask[idx];
        const dot = new THREE.Mesh(dotGeo, isClear ? clearMat : blockedMat);
        dot.position.set(pt[0], pt[1], pt[2] + 0.02);
        scene.add(dot);

        if (
          viewMode !== 'attendee_pov' &&
          (idx === 0 ||
            idx === 14 ||
            idx === 67 ||
            idx === 120 ||
            idx === 134 ||
            !isClear)
        ) {
          if (!isClear && idx % 6 !== 0) return;
          const rayPts = [
            new THREE.Vector3(
              pose.eyePositionWorld[0],
              pose.eyePositionWorld[1],
              pose.eyePositionWorld[2],
            ),
            new THREE.Vector3(pt[0], pt[1], pt[2]),
          ];
          const rayGeo = new THREE.BufferGeometry().setFromPoints(rayPts);
          const rayMat = new THREE.LineBasicMaterial({
            color: isClear ? 0x10b981 : 0xef4444,
            transparent: true,
            opacity: isClear ? 0.32 : 0.65,
          });
          scene.add(new THREE.Line(rayGeo, rayMat));
        }
      });
    }

    return () => {
      cancelled = true;
    };
  }, [
    effectiveSnapshot,
    selectedAttendeeId,
    selectedAttendee,
    selectedEmptyPlaceId,
    viewMode,
    evaluation,
    showSightlineOverlays,
  ]);

  // 3. Camera & Render Effect
  useEffect(() => {
    const renderCurrentFrame = (): void => {
      const container = containerRef.current;
      const renderer = rendererRef.current;
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      if (!container || !renderer || !scene || !camera) return;

      const width = Math.max(320, container.clientWidth);
      const height = Math.max(320, container.clientHeight);
      renderer.setSize(width, height, false);

      if (viewMode === 'attendee_pov' && selectedAttendeeId && selectedAttendee) {
        try {
          const pose = getAttendeeCameraPose(snapshot, selectedAttendeeId);
          camera.fov = INSPECTION_CAMERA.fovDeg;
          camera.aspect = INSPECTION_CAMERA.aspect;
          camera.up.set(0, 1, 0);
          camera.updateProjectionMatrix();
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
          const side = Math.min(width, height);
          const offsetX = Math.floor((width - side) * 0.5);
          const offsetY = Math.floor((height - side) * 0.5);
          renderer.setScissorTest(true);
          renderer.setViewport(offsetX, offsetY, side, side);
          renderer.setScissor(offsetX, offsetY, side, side);
        } catch {
          // Fallback if attendee missing
        }
      } else if (viewMode === 'flythrough') {
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, width, height);
        camera.fov = 62;
        camera.aspect = width / height;
        camera.up.set(0, 1, 0);
        camera.updateProjectionMatrix();

        const [px, py, pz] = flyPoseRef.current.position;
        const yaw = flyPoseRef.current.yawRad;
        const pitch = flyPoseRef.current.pitchRad;
        const cosPitch = Math.cos(pitch);
        const lookX = px - Math.sin(yaw) * cosPitch;
        const lookY = py + Math.sin(pitch);
        const lookZ = pz - Math.cos(yaw) * cosPitch;

        camera.position.set(px, py, pz);
        camera.lookAt(lookX, lookY, lookZ);
      } else {
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, width, height);
        camera.fov = 52;
        camera.aspect = width / height;
        camera.up.set(0, 1, 0);
        camera.updateProjectionMatrix();

        const targetPivot = new THREE.Vector3(0, 0.7, -1.6);
        const cx =
          targetPivot.x +
          orbitAngles.distanceM *
            Math.sin(orbitAngles.polarRad) *
            Math.sin(orbitAngles.azimuthRad);
        const cy =
          targetPivot.y +
          orbitAngles.distanceM * Math.cos(orbitAngles.polarRad);
        const cz =
          targetPivot.z +
          orbitAngles.distanceM *
            Math.sin(orbitAngles.polarRad) *
            Math.cos(orbitAngles.azimuthRad);
        camera.position.set(cx, cy, cz);
        camera.lookAt(targetPivot);
      }

      renderer.render(scene, camera);
    };

    renderFrameRef.current = renderCurrentFrame;
    renderCurrentFrame();
  }, [
    snapshot,
    selectedAttendeeId,
    selectedAttendee,
    selectedEmptyPlaceId,
    viewMode,
    evaluation,
    showSightlineOverlays,
    orbitAngles,
  ]);

  // Apply evacuation step whenever evacTimeSec or evacSimResult changes
  useEffect(() => {
    const counts = updateSceneEvacuationStep(
      attendeeProxyNodesRef.current,
      evacSimResult,
      evacTimeSec,
    );
    setEvacCounts(counts);
    renderFrameRef.current?.();
  }, [evacSimResult, evacTimeSec, snapshot]);

  // RequestAnimationFrame playback loop for evacuation simulation
  useEffect(() => {
    if (!isPlayingEvac || !evacSimResult) return;
    let rafId = 0;
    let lastTs = performance.now();

    const tick = (now: number) => {
      const dtSec = Math.min(0.1, (now - lastTs) / 1000);
      lastTs = now;

      setEvacTimeSec((prev) => {
        const next = prev + dtSec;
        if (next >= evacSimResult.totalEvacuationTimeSec + 0.4) {
          setIsPlayingEvac(false);
          return evacSimResult.totalEvacuationTimeSec;
        }
        return next;
      });
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlayingEvac, evacSimResult]);

  const handleSelectEvacMode = (nextMode: EvacuationMode): void => {
    if (nextMode !== 'none' && viewMode === 'attendee_pov') {
      onToggleViewMode('overview');
    }
    setEvacMode(nextMode);
    setEvacTimeSec(0);
    setIsPlayingEvac(nextMode !== 'none');
  };

  const handleSwitchMode = (nextMode: ViewportCameraMode): void => {
    if (nextMode === 'flythrough' && viewMode !== 'flythrough') {
      const cam = cameraRef.current;
      if (cam) {
        const dir = new THREE.Vector3();
        cam.getWorldDirection(dir);
        const yaw = Math.atan2(-dir.x, -dir.z);
        const pitch = Math.asin(Math.max(-0.95, Math.min(0.95, dir.y)));
        flyPoseRef.current = {
          position: [cam.position.x, cam.position.y, cam.position.z],
          yawRad: yaw,
          pitchRad: pitch,
        };
        setFlyHudReadout({
          pos: [cam.position.x, cam.position.y, cam.position.z],
          turbo: false,
        });
      }
    }
    onToggleViewMode(nextMode);
  };

  const visPct = selectedEval
    ? Math.round(selectedEval.sampledVisibility * 100)
    : 100;
  const seatBadge = selectedAttendee
    ? formatShortSeat(selectedAttendee.assignedPlaceId, selectedPlace?.label)
    : '';

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: '500px',
        background: 'var(--bg-canvas)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Top Floating Viewport Bar */}
      <div
        style={{
          position: 'absolute',
          top: '14px',
          left: '16px',
          right: '16px',
          zIndex: 10,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
          pointerEvents: 'none',
        }}
      >
        {/* Left: Camera Mode Switcher + Ray Overlay Toggle + Evacuation Switcher */}
        <div
          className="vp-hud-bar"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px',
          }}
        >
          <div className="vp-segmented" style={{ border: 'none', background: 'transparent', padding: 0 }}>
            <button
              type="button"
              className={`vp-segment-btn vp-focusable ${
                viewMode === 'overview' ? 'vp-segment-btn-active' : ''
              }`}
              onClick={() => handleSwitchMode('overview')}
            >
              <span>Room Orbit</span>
            </button>

            <button
              type="button"
              className={`vp-segment-btn vp-focusable ${
                viewMode === 'flythrough' ? 'vp-segment-btn-active' : ''
              }`}
              onClick={() => handleSwitchMode('flythrough')}
              title="POV Flythrough: WASD lateral movement, E/C up & down, Shift 3x speed boost, mouse drag to look"
            >
              <span>POV Flythrough (WASD+E/C)</span>
            </button>

            <button
              type="button"
              className={`vp-segment-btn vp-focusable ${
                viewMode === 'attendee_pov' ? 'vp-segment-btn-active' : ''
              }`}
              disabled={!selectedAttendee}
              onClick={() => handleSwitchMode('attendee_pov')}
            >
              <span>Seat POV</span>
            </button>
          </div>

          <div className="vp-divider-v" />

          <button
            type="button"
            aria-pressed={showSightlineOverlays}
            className="vp-segment-btn vp-focusable"
            style={{
              color: showSightlineOverlays
                ? 'var(--text-primary)'
                : 'var(--text-secondary)',
            }}
            onClick={onToggleSightlineOverlays}
          >
            <span
              className="vp-status-dot"
              style={{
                background: showSightlineOverlays
                  ? 'var(--status-pass)'
                  : 'var(--text-muted)',
              }}
            />
            <span>Sightline Rays</span>
          </button>

          <div className="vp-divider-v" />

          {/* Egress & Emergency Evacuation Simulation Switcher */}
          <div
            className="vp-segmented"
            style={{ border: 'none', background: 'transparent', padding: 0 }}
            role="group"
            aria-label="Evacuation simulation mode"
          >
            <button
              type="button"
              className={`vp-segment-btn vp-focusable ${
                evacMode === 'none' ? 'vp-segment-btn-active' : ''
              }`}
              onClick={() => handleSelectEvacMode('none')}
            >
              Seated
            </button>
            <button
              type="button"
              className={`vp-segment-btn vp-focusable ${
                evacMode === 'normal_egress' ? 'vp-segment-btn-active' : ''
              }`}
              onClick={() => handleSelectEvacMode('normal_egress')}
            >
              Normal Exit
            </button>
            <button
              type="button"
              className={`vp-segment-btn vp-focusable ${
                evacMode === 'emergency_evacuation'
                  ? 'vp-segment-btn-active'
                  : ''
              }`}
              style={
                evacMode === 'emergency_evacuation'
                  ? {
                      color: 'var(--status-warn-text)',
                      background: 'var(--status-warn-bg)',
                    }
                  : undefined
              }
              onClick={() => handleSelectEvacMode('emergency_evacuation')}
            >
              Emergency Evac
            </button>
          </div>
        </div>

        {/* Right: Quick Camera Presets / Next Issue Jump */}
        <div
          className="vp-hud-bar"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '4px',
          }}
        >
          {viewMode === 'overview' && (
            <>
              <button
                type="button"
                className="vp-segment-btn vp-focusable"
                onClick={() =>
                  setOrbitAngles({
                    azimuthRad: 0.38,
                    polarRad: 0.92,
                    distanceM: defaultDistance,
                  })
                }
              >
                Stage Oblique
              </button>
              <button
                type="button"
                className="vp-segment-btn vp-focusable"
                onClick={() =>
                  setOrbitAngles({
                    azimuthRad: 0,
                    polarRad: 0.28,
                    distanceM: defaultDistance * 1.05,
                  })
                }
              >
                Top Plan
              </button>
            </>
          )}

          {obstructedAttendees.length > 0 && (
            <button
              type="button"
              className="vp-segment-btn vp-focusable"
              style={{
                color: 'var(--status-fail-text)',
                background: 'var(--status-fail-bg)',
              }}
              onClick={jumpToNextIssue}
            >
              <span className="vp-status-dot vp-status-dot-fail" />
              <span>Next Issue ({obstructedAttendees.length})</span>
            </button>
          )}
        </div>
      </div>

      {/* Flythrough Controls Banner when in Flythrough mode */}
      {viewMode === 'flythrough' && (
        <div
          style={{
            position: 'absolute',
            top: '60px',
            left: '16px',
            zIndex: 10,
            padding: '6px 12px',
            borderRadius: 'var(--radius-card)',
            background: 'rgba(15, 23, 42, 0.88)',
            border: '1px solid rgba(56, 189, 248, 0.45)',
            color: '#e0f2fe',
            fontSize: '0.74rem',
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <span>
            <strong>Flythrough:</strong> <code>W A S D</code> Move ·{' '}
            <code>E / C</code> Up / Down · <code>Shift</code> 3× Speed ·{' '}
            <code>Drag Mouse</code> Look
          </span>
          <span className="mono" style={{ color: '#38bdf8' }}>
            [{flyHudReadout.pos.map((v) => v.toFixed(1)).join(', ')}]m{' '}
            {flyHudReadout.turbo ? '⚡3×' : ''}
          </span>
        </div>
      )}

      {/* Live Egress / Emergency Evacuation Telemetry HUD Banner */}
      {evacMode !== 'none' && evacSimResult && (
        <div
          style={{
            position: 'absolute',
            top: viewMode === 'flythrough' ? '100px' : '60px',
            left: '16px',
            right: '16px',
            zIndex: 9,
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div
            className="vp-hud-bar"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '6px 14px',
              pointerEvents: 'auto',
              borderColor:
                evacMode === 'emergency_evacuation'
                  ? evacSimResult.evacuationPass
                    ? 'var(--status-pass-border)'
                    : 'var(--status-fail-border)'
                  : 'var(--border-subtle)',
            }}
          >
            <button
              type="button"
              className="vp-btn"
              style={{ padding: '4px 10px', fontSize: '0.74rem' }}
              onClick={() => {
                if (
                  !isPlayingEvac &&
                  evacTimeSec >= evacSimResult.totalEvacuationTimeSec - 0.1
                ) {
                  setEvacTimeSec(0);
                  setIsPlayingEvac(true);
                } else {
                  setIsPlayingEvac((p) => !p);
                }
              }}
            >
              {isPlayingEvac
                ? 'Pause'
                : evacTimeSec >= evacSimResult.totalEvacuationTimeSec - 0.1
                  ? 'Replay'
                  : 'Play'}
            </button>

            <input
              type="range"
              aria-label="Evacuation simulation timeline"
              min={0}
              max={evacSimResult.totalEvacuationTimeSec}
              step={0.1}
              value={Math.min(
                evacTimeSec,
                evacSimResult.totalEvacuationTimeSec,
              )}
              onChange={(e) => {
                setIsPlayingEvac(false);
                setEvacTimeSec(Number(e.target.value));
              }}
              style={{ width: '120px', accentColor: 'var(--accent-primary)' }}
            />

            <span className="mono" style={{ fontSize: '0.76rem' }}>
              t={evacTimeSec.toFixed(1)}s /{' '}
              {evacSimResult.totalEvacuationTimeSec.toFixed(1)}s
            </span>

            <div className="vp-divider-v" />

            <span className="mono" style={{ fontSize: '0.75rem' }}>
              Escaped: {evacCounts.exitedCount}/{snapshot.roster.length}
            </span>

            {evacCounts.queuingCount > 0 && (
              <span className="vp-badge vp-badge-warn" style={{ fontSize: '0.72rem' }}>
                Queueing: {evacCounts.queuingCount}
              </span>
            )}

            <span
              className={`vp-badge ${
                evacSimResult.evacuationPass ? 'vp-badge-pass' : 'vp-badge-fail'
              }`}
              style={{ fontSize: '0.72rem' }}
            >
              Exits Open: {evacSimResult.activeExitCount}/
              {evacSimResult.totalExitCount} · T_evac{' '}
              {evacSimResult.totalEvacuationTimeSec.toFixed(1)}s
            </span>

            <div className="vp-divider-v" />

            <button
              type="button"
              className="vp-btn"
              style={{
                fontSize: '0.72rem',
                padding: '3px 8px',
                background: showExitOptimizer ? 'var(--accent-primary)' : undefined,
                color: showExitOptimizer ? '#fff' : undefined,
              }}
              onClick={() => setShowExitOptimizer((p) => !p)}
            >
              🚪 {showExitOptimizer ? 'Close Optimizer' : 'Optimize Exits'}
            </button>
          </div>

          {/* Interactive Exit Position Optimizer Drawer */}
          {showExitOptimizer && (
            <div
              className="glass"
              style={{
                marginTop: '8px',
                background: 'rgba(15, 23, 42, 0.94)',
                backdropFilter: 'blur(12px)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '12px 18px',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                minWidth: '380px',
                pointerEvents: 'auto',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span
                  style={{
                    fontWeight: 600,
                    fontSize: '0.82rem',
                    letterSpacing: '0.02em',
                  }}
                >
                  🚪 Exit Position Optimizer
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: '0.74rem',
                    color: 'var(--accent-primary)',
                    fontWeight: 600,
                  }}
                >
                  T_evac: {evacSimResult.totalEvacuationTimeSec.toFixed(1)}s
                </span>
              </div>

              {/* West Low-Level Exit (Door Z along West Wall) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '0.72rem',
                  }}
                >
                  <span>West Low-Level Exit (Door Z)</span>
                  <span className="mono">{westExitZ.toFixed(2)}m</span>
                </div>
                <input
                  type="range"
                  min={-3.5}
                  max={1.5}
                  step={0.1}
                  value={westExitZ}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setExitOverrides((prev) => ({
                      ...prev,
                      exit_main_west: { ...(prev.exit_main_west ?? {}), z: val },
                    }));
                  }}
                  style={{ width: '100%', accentColor: 'var(--accent-primary)' }}
                />
              </div>

              {/* East Low-Level Exit (Door Z along East Wall) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '0.72rem',
                  }}
                >
                  <span>East Low-Level Exit (Door Z)</span>
                  <span className="mono">{eastExitZ.toFixed(2)}m</span>
                </div>
                <input
                  type="range"
                  min={-1.5}
                  max={3.5}
                  step={0.1}
                  value={eastExitZ}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setExitOverrides((prev) => ({
                      ...prev,
                      exit_emergency_east: {
                        ...(prev.exit_emergency_east ?? {}),
                        z: val,
                      },
                    }));
                  }}
                  style={{ width: '100%', accentColor: 'var(--accent-primary)' }}
                />
              </div>

              {/* Rear Wheelchair Terrace Exit (Door X along Terrace) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '0.72rem',
                  }}
                >
                  <span>Wheelchair Terrace Exit (Door X)</span>
                  <span className="mono">{terraceExitX.toFixed(2)}m</span>
                </div>
                <input
                  type="range"
                  min={-3.0}
                  max={3.0}
                  step={0.1}
                  value={terraceExitX}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setExitOverrides((prev) => ({
                      ...prev,
                      exit_wheelchair_terrace: {
                        ...(prev.exit_wheelchair_terrace ?? {}),
                        x: val,
                      },
                    }));
                  }}
                  style={{ width: '100%', accentColor: 'var(--accent-primary)' }}
                />
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: '8px',
                  marginTop: '4px',
                }}
              >
                <button
                  type="button"
                  className="vp-btn"
                  style={{ fontSize: '0.70rem', padding: '3px 8px' }}
                  onClick={() => setExitOverrides({})}
                >
                  Reset Default
                </button>
                <button
                  type="button"
                  className="vp-btn"
                  style={{
                    fontSize: '0.70rem',
                    padding: '3px 8px',
                    background: 'var(--accent-primary)',
                    color: '#fff',
                  }}
                  onClick={() => {
                    setExitOverrides({
                      exit_main_west: { z: -2.2 },
                      exit_emergency_east: { z: 0.8 },
                      exit_wheelchair_terrace: { x: 0.0 },
                    });
                  }}
                >
                  ⚡ Auto-Optimize
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 1:1 Optical Viewfinder Badge when in Seat POV */}
      {viewMode === 'attendee_pov' && (
        <div
          style={{
            position: 'absolute',
            top: '64px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 8,
            pointerEvents: 'none',
          }}
        >
          <span
            className="vp-badge vp-badge-neutral mono"
            style={{
              background: 'rgba(12, 15, 23, 0.78)',
              borderColor: 'var(--border-subtle)',
              padding: '3px 10px',
            }}
          >
            90°×90° Optical Frame · 15×9 Target Grid
          </span>
        </div>
      )}

      {/* Interactive 3D Canvas Container */}
      <div
        ref={containerRef}
        onMouseDown={(e) => {
          if (viewMode === 'attendee_pov') return;
          dragStateRef.current = {
            dragging: true,
            startX: e.clientX,
            startY: e.clientY,
            lastX: e.clientX,
            lastY: e.clientY,
          };
        }}
        onMouseMove={(e) => {
          if (!dragStateRef.current.dragging || viewMode === 'attendee_pov') {
            return;
          }
          const dx = e.clientX - dragStateRef.current.lastX;
          const dy = e.clientY - dragStateRef.current.lastY;
          dragStateRef.current.lastX = e.clientX;
          dragStateRef.current.lastY = e.clientY;

          if (viewMode === 'flythrough') {
            flyPoseRef.current.yawRad -= dx * 0.0055;
            flyPoseRef.current.pitchRad = Math.max(
              -1.42,
              Math.min(1.42, flyPoseRef.current.pitchRad - dy * 0.0055),
            );
            renderFrameRef.current?.();
          } else {
            setOrbitAngles((prev) => ({
              ...prev,
              azimuthRad: prev.azimuthRad - dx * 0.007,
              polarRad: Math.max(
                0.22,
                Math.min(1.45, prev.polarRad - dy * 0.007),
              ),
            }));
          }
        }}
        onMouseUp={(e) => {
          const wasDragging = dragStateRef.current.dragging;
          dragStateRef.current.dragging = false;
          if (!wasDragging || viewMode === 'attendee_pov') return;

          const dist = Math.hypot(
            e.clientX - dragStateRef.current.startX,
            e.clientY - dragStateRef.current.startY,
          );
          if (
            dist < 6 &&
            containerRef.current &&
            sceneRef.current &&
            cameraRef.current
          ) {
            const rect = containerRef.current.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              const ndc = new THREE.Vector2(
                ((e.clientX - rect.left) / rect.width) * 2 - 1,
                -((e.clientY - rect.top) / rect.height) * 2 + 1,
              );
              const raycaster = new THREE.Raycaster();
              raycaster.setFromCamera(ndc, cameraRef.current);
              const hits = raycaster.intersectObjects(
                sceneRef.current.children,
                true,
              );
              for (const hit of hits) {
                let cur: THREE.Object3D | null = hit.object;
                while (cur) {
                  if (typeof cur.userData?.attendeeId === 'string') {
                    setSelectedEmptyPlaceId(null);
                    onSelectAttendee?.(cur.userData.attendeeId);
                    return;
                  }
                  if (typeof cur.userData?.placeId === 'string') {
                    setSelectedEmptyPlaceId(cur.userData.placeId);
                    return;
                  }
                  cur = cur.parent;
                }
              }
            }
          }
        }}
        onMouseLeave={() => {
          dragStateRef.current.dragging = false;
        }}
        onWheel={(e) => {
          if (viewMode === 'overview') {
            setOrbitAngles((prev) => ({
              ...prev,
              distanceM: Math.max(
                3.2,
                Math.min(24.0, prev.distanceM + e.deltaY * 0.006),
              ),
            }));
          } else if (viewMode === 'flythrough') {
            const yaw = flyPoseRef.current.yawRad;
            const step = -e.deltaY * 0.004;
            flyPoseRef.current.position[0] += -Math.sin(yaw) * step;
            flyPoseRef.current.position[2] += -Math.cos(yaw) * step;
            renderFrameRef.current?.();
          }
        }}
        style={{
          flex: 1,
          width: '100%',
          height: '100%',
          cursor: viewMode === 'attendee_pov' ? 'default' : 'grab',
        }}
      />

      {/* Sleek Bottom-Center Floating Guest / Empty-Seat Dock */}
      {(selectedEmptyPlace || (selectedAttendee && selectedEval)) && (
        <div
          style={{
            position: 'absolute',
            bottom: '16px',
            left: '16px',
            right: '16px',
            zIndex: 10,
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div
            className="vp-hud-bar"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '8px 12px',
              maxWidth: '740px',
            }}
          >
            {selectedEmptyPlace ? (
              <>
                <div>
                  <div
                    style={{
                      fontSize: '0.71rem',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    Selected Empty 3D Seat
                  </div>
                  <div style={{ fontWeight: 600, fontSize: '0.84rem' }}>
                    {selectedEmptyPlace.label} ({selectedEmptyPlace.id})
                  </div>
                </div>
                {onAddAttendeeAtPlace && (
                  <button
                    type="button"
                    className="vp-btn vp-btn-primary"
                    style={{ padding: '5px 10px', fontSize: '0.75rem' }}
                    onClick={() => {
                      onAddAttendeeAtPlace(selectedEmptyPlace.id);
                      setSelectedEmptyPlaceId(null);
                    }}
                  >
                    + Add Person to {selectedEmptyPlace.label}
                  </button>
                )}
              </>
            ) : (
              selectedAttendee &&
              selectedEval && (
                <>
                  {/* Prev / Next Guest Stepper */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                    }}
                  >
                    <button
                      type="button"
                      aria-label="Previous guest"
                      className="vp-btn"
                      style={{ padding: '5px 8px' }}
                      onClick={() => stepAttendee(-1)}
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      aria-label="Next guest"
                      className="vp-btn"
                      style={{ padding: '5px 8px' }}
                      onClick={() => stepAttendee(1)}
                    >
                      ›
                    </button>
                  </div>

                  <div className="vp-divider-v" />

                  {/* Selected Guest Identity */}
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '7px',
                        fontWeight: 600,
                        fontSize: '0.83rem',
                      }}
                    >
                      <span>{cleanGuestName(selectedAttendee.label)}</span>
                      <span
                        className="mono"
                        style={{
                          fontSize: '0.71rem',
                          padding: '1px 6px',
                          borderRadius: '4px',
                          background: 'var(--bg-elevated)',
                          border: '1px solid var(--border-subtle)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {seatBadge}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: '0.72rem',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {selectedProfile?.label ?? selectedAttendee.profileId}
                    </div>
                  </div>

                  <div className="vp-divider-v" />

                  {/* Sightline Status Pill */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <span
                      className={`vp-badge ${
                        selectedEval.clearAndUsable
                          ? 'vp-badge-pass'
                          : 'vp-badge-fail'
                      }`}
                    >
                      <span
                        className={`vp-status-dot ${
                          selectedEval.clearAndUsable
                            ? 'vp-status-dot-pass'
                            : 'vp-status-dot-fail'
                        }`}
                      />
                      <span>
                        {visPct}% Sightline ({selectedEval.visibleSamples}/
                        {selectedEval.totalSamples})
                      </span>
                    </span>
                  </div>

                  <div className="vp-divider-v" />

                  {/* 1-Click Toggle between Seat POV and Room Orbit */}
                  <button
                    type="button"
                    className={`vp-btn ${
                      viewMode === 'attendee_pov' ? 'vp-btn-primary' : ''
                    }`}
                    style={{ padding: '5px 10px', fontSize: '0.75rem' }}
                    onClick={() =>
                      handleSwitchMode(
                        viewMode === 'attendee_pov'
                          ? 'overview'
                          : 'attendee_pov',
                      )
                    }
                  >
                    {viewMode === 'attendee_pov'
                      ? 'Back to Orbit'
                      : 'Inspect POV'}
                  </button>

                  {onRemoveAttendee && (
                    <button
                      type="button"
                      className="vp-btn"
                      style={{
                        padding: '5px 9px',
                        fontSize: '0.73rem',
                        color: 'var(--status-fail-text)',
                      }}
                      onClick={() =>
                        onRemoveAttendee(selectedAttendee.attendeeId)
                      }
                    >
                      Remove
                    </button>
                  )}
                </>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
