import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  INSPECTION_CAMERA,
  getAttendeeCameraPose,
  type Evaluation,
  type ProfileId,
  type SceneSnapshot,
} from '../shared/index.js';
import {
  STANDALONE_GLB_ALIGNMENT,
  disposeVenueScene,
  getUploadedGlbBytesForScene,
  getUploadedGlbGroupForScene,
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

  const [orbitAngles, setOrbitAngles] = useState<{
    azimuthRad: number;
    polarRad: number;
    distanceM: number;
  }>(() => ({
    azimuthRad: 0.38,
    polarRad: 0.92,
    distanceM: snapshot.places.length > 8 ? 11.5 : 7.4,
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
      distanceM: snapshot.places.length > 8 ? 11.5 : 7.4,
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
  const selectedEmptyPlace = selectedEmptyPlaceId
    ? snapshot.places.find((p) => p.id === selectedEmptyPlaceId)
    : undefined;

  // 1. Mount / Unmount Effect: Single persistent WebGLRenderer + WASD/E/C/Shift Flythrough loop
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

      // If user presses W/A/S/D/E/C while in overview mode, smoothly initialize flythrough from current camera pose!
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
        // Forward vector on horizontal XZ plane (0 yaw faces -Z: [-sin(yaw), 0, -cos(yaw)])
        const fwdX = -Math.sin(yaw);
        const fwdZ = -Math.cos(yaw);
        // Right vector on horizontal XZ plane ([cos(yaw), 0, -sin(yaw)])
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

  // 2. Scene Rebuild Effect: Rebuilds scene geometry when snapshot, selection, viewMode, or overlays change
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    disposeVenueScene(scene);

    populateThreeSceneFromSnapshot(scene, snapshot, {
      hideAttendeeId:
        viewMode === 'attendee_pov' ? selectedAttendeeId : undefined,
      forBlindEvidenceCapture: false,
    });

    // If uploaded .glb bytes exist but pre-parsed group wasn't cached yet, parse asynchronously once
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
          const archGroup = gltf.scene;
          archGroup.name = 'uploaded_glb_architectural_shell';
          archGroup.rotation.y = STANDALONE_GLB_ALIGNMENT.rotationYRad;
          archGroup.scale.set(
            STANDALONE_GLB_ALIGNMENT.scale,
            STANDALONE_GLB_ALIGNMENT.scale,
            STANDALONE_GLB_ALIGNMENT.scale,
          );
          archGroup.position.set(
            STANDALONE_GLB_ALIGNMENT.position[0],
            STANDALONE_GLB_ALIGNMENT.position[1],
            STANDALONE_GLB_ALIGNMENT.position[2],
          );
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
      // Render interactive seat/bay markers for ALL parsed places (occupied AND empty!)
      for (const place of snapshot.places) {
        const obj = snapshot.objects.find((o) => o.id === place.objectId);
        if (!obj) continue;

        const occupant = occupantByPlaceId.get(place.id);
        const isSelectedOccupant =
          occupant && occupant.attendeeId === selectedAttendeeId;
        const isSelectedEmpty =
          !occupant && place.id === selectedEmptyPlaceId;
        const attEval = occupant
          ? evaluation.attendees[occupant.attendeeId]
          : undefined;

        const ringColor = isSelectedOccupant || isSelectedEmpty
          ? 0x38bdf8
          : occupant
            ? !attEval
              ? 0x94a3b8
              : attEval.clearAndUsable
                ? 0x10b981
                : 0xef4444
            : 0x64748b;

        const ringGeo = new THREE.RingGeometry(
          isSelectedOccupant || isSelectedEmpty ? 0.34 : 0.27,
          isSelectedOccupant || isSelectedEmpty ? 0.44 : 0.34,
          28,
        );
        const ringMat = new THREE.MeshBasicMaterial({
          color: ringColor,
          side: THREE.DoubleSide,
          transparent: !occupant && !isSelectedEmpty,
          opacity: !occupant && !isSelectedEmpty ? 0.55 : 0.95,
        });
        const ringMesh = new THREE.Mesh(ringGeo, ringMat);
        ringMesh.rotation.x = -Math.PI / 2;
        ringMesh.position.set(
          obj.transform.position[0],
          obj.transform.position[1] + 0.03,
          obj.transform.position[2],
        );
        ringMesh.userData = {
          placeId: place.id,
          attendeeId: occupant?.attendeeId,
        };
        scene.add(ringMesh);

        // Add an invisible/subtle pickable hit disc over every seat so clicking empty seats in 3D is effortless
        const hitGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.5, 16);
        const hitMat = new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          transparent: true,
          opacity: isSelectedEmpty ? 0.24 : 0.0,
          depthWrite: false,
        });
        const hitMesh = new THREE.Mesh(hitGeo, hitMat);
        hitMesh.position.set(
          obj.transform.position[0],
          obj.transform.position[1] + 0.25,
          obj.transform.position[2],
        );
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
            0.035,
            obj.baselineTransform.position[2],
          );
          scene.add(ghostMesh);

          const dir = new THREE.Vector3(dx, 0, dz).normalize();
          const origin = new THREE.Vector3(
            obj.baselineTransform.position[0],
            0.12,
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

      const dotGeo = new THREE.SphereGeometry(0.032, 8, 8);
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
            opacity: isClear ? 0.35 : 0.65,
          });
          scene.add(new THREE.Line(rayGeo, rayMat));
        }
      });
    }

    return () => {
      cancelled = true;
    };
  }, [
    snapshot,
    selectedAttendeeId,
    selectedAttendee,
    selectedEmptyPlaceId,
    viewMode,
    evaluation,
    showSightlineOverlays,
  ]);

  // 3. Camera & Render Effect: Runs at 60fps during orbit/zoom/flythrough without recreating WebGLRenderer!
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

        const targetPivot = new THREE.Vector3(0, 0.7, -0.5);
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

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: '480px',
        background: '#090c12',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Top Viewport Overlay Controls */}
      <div
        style={{
          position: 'absolute',
          top: '14px',
          left: '14px',
          right: '14px',
          zIndex: 10,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'var(--bg-glass)',
            backdropFilter: 'blur(8px)',
            padding: '5px',
            borderRadius: 'var(--radius-card)',
            border: '1px solid var(--border-subtle)',
            pointerEvents: 'auto',
          }}
        >
          <button
            type="button"
            className={`vp-btn ${viewMode === 'overview' ? 'vp-btn-primary' : ''}`}
            onClick={() => handleSwitchMode('overview')}
          >
            Room Overview (3D Orbit)
          </button>
          <button
            type="button"
            className={`vp-btn ${viewMode === 'flythrough' ? 'vp-btn-primary' : ''}`}
            onClick={() => handleSwitchMode('flythrough')}
            title="Fly freely through the 3D venue using WASD (lateral), E/C (up/down), Shift (speed boost), and mouse drag to look"
          >
            POV Flythrough (WASD + E/C)
          </button>
          <button
            type="button"
            className={`vp-btn ${viewMode === 'attendee_pov' ? 'vp-btn-primary' : ''}`}
            disabled={!selectedAttendee}
            onClick={() => handleSwitchMode('attendee_pov')}
          >
            Attendee POV (90°×90° Square)
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            background: 'var(--bg-glass)',
            backdropFilter: 'blur(8px)',
            padding: '5px 10px',
            borderRadius: 'var(--radius-card)',
            border: '1px solid var(--border-subtle)',
            pointerEvents: 'auto',
          }}
        >
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '0.78rem',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={showSightlineOverlays}
              onChange={onToggleSightlineOverlays}
            />
            Show 15×9 Target Grid &amp; Rays
          </label>
        </div>
      </div>

      {/* Flythrough Controls Banner when in Flythrough mode */}
      {viewMode === 'flythrough' && (
        <div
          style={{
            position: 'absolute',
            top: '62px',
            left: '14px',
            zIndex: 10,
            padding: '7px 12px',
            borderRadius: 'var(--radius-card)',
            background: 'rgba(15, 23, 42, 0.88)',
            border: '1px solid rgba(56, 189, 248, 0.45)',
            color: '#e0f2fe',
            fontSize: '0.75rem',
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <span>
            <strong>Flythrough Controls:</strong> <code>W A S D</code> Move ·{' '}
            <code>E / C</code> Up / Down · <code>Shift</code> 3× Speed ·{' '}
            <code>Drag Mouse</code> Look Around
          </span>
          <span className="mono" style={{ color: '#38bdf8' }}>
            Pos: [{flyHudReadout.pos.map((v) => v.toFixed(1)).join(', ')}]m{' '}
            {flyHudReadout.turbo ? '⚡3×' : ''}
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
          if (!wasDragging || viewMode === 'attendee_pov') {
            return;
          }
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
          cursor: viewMode === 'attendee_pov' ? 'crosshair' : 'grab',
        }}
      />

      {/* Quick Seat/Bay Switcher Pill Bar & Selected Seat / Attendee HUD */}
      <div
        style={{
          position: 'absolute',
          bottom: '14px',
          left: '14px',
          right: '14px',
          zIndex: 10,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            background: 'var(--bg-glass)',
            backdropFilter: 'blur(8px)',
            padding: '10px 14px',
            borderRadius: 'var(--radius-card)',
            border: '1px solid var(--border-subtle)',
            pointerEvents: 'auto',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '14px',
          }}
        >
          {selectedEmptyPlace ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div>
                <div
                  style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}
                >
                  Selected Empty Parsed Seat
                </div>
                <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>
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
            </div>
          ) : (
            <>
              <div>
                <div
                  style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}
                >
                  Active Camera / Place ({snapshot.roster.length} of{' '}
                  {snapshot.places.length} seats occupied)
                </div>
                <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>
                  {selectedAttendee
                    ? `${selectedAttendee.label} · ${selectedAttendee.assignedPlaceId}`
                    : 'Click any seat ring in 3D or add a person'}
                </div>
              </div>

              {selectedEval && (
                <>
                  <div>
                    <div
                      style={{
                        fontSize: '0.72rem',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      Sampled Visibility (15×9)
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                    >
                      <span
                        className="mono"
                        style={{ fontWeight: 700, fontSize: '0.88rem' }}
                      >
                        {selectedEval.visibleSamples}/{selectedEval.totalSamples}{' '}
                        ({Math.round(selectedEval.sampledVisibility * 100)}%)
                      </span>
                      <span
                        className={`vp-badge ${
                          selectedEval.isViewClear
                            ? 'vp-badge-pass'
                            : 'vp-badge-fail'
                        }`}
                      >
                        {selectedEval.isViewClear ? 'Clear >=122' : 'Obstructed'}
                      </span>
                    </div>
                  </div>

                  <div>
                    <div
                      style={{
                        fontSize: '0.72rem',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      Eye World Pos [X, Y, Z]
                    </div>
                    <div className="mono" style={{ fontSize: '0.8rem' }}>
                      [
                      {selectedEval.eyePositionWorld
                        .map((v) => `${v.toFixed(2)}m`)
                        .join(', ')}
                      ]
                    </div>
                  </div>
                </>
              )}

              {selectedAttendee && onRemoveAttendee && (
                <button
                  type="button"
                  className="vp-btn"
                  style={{
                    padding: '4px 9px',
                    fontSize: '0.73rem',
                    borderColor: 'rgba(239, 68, 68, 0.45)',
                    color: '#fca5a5',
                  }}
                  onClick={() => onRemoveAttendee(selectedAttendee.attendeeId)}
                >
                  Remove from Seat
                </button>
              )}
            </>
          )}
        </div>

        {/* Fast camera jump pills */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '5px',
            maxWidth: '520px',
            maxHeight: '72px',
            overflowY: 'auto',
            background: 'var(--bg-glass)',
            backdropFilter: 'blur(8px)',
            padding: '6px',
            borderRadius: 'var(--radius-card)',
            border: '1px solid var(--border-subtle)',
            pointerEvents: 'auto',
          }}
        >
          {snapshot.roster.map((m) => {
            const active =
              !selectedEmptyPlaceId && m.attendeeId === selectedAttendeeId;
            const ev = evaluation.attendees[m.attendeeId];
            return (
              <button
                key={m.attendeeId}
                type="button"
                className={`vp-btn ${active ? 'vp-btn-primary' : ''}`}
                style={{ padding: '4px 8px', fontSize: '0.73rem' }}
                onClick={() => {
                  setSelectedEmptyPlaceId(null);
                  onSelectAttendee?.(m.attendeeId);
                }}
              >
                <span>{m.assignedPlaceId.replace('place_', '')}</span>
                {ev && (
                  <span
                    style={{
                      width: '7px',
                      height: '7px',
                      borderRadius: '50%',
                      background: ev.clearAndUsable ? '#34d399' : '#f87171',
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
