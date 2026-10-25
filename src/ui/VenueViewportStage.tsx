import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  INSPECTION_CAMERA,
  getAttendeeCameraPose,
  type Evaluation,
  type SceneSnapshot,
} from '../shared/index.js';
import {
  disposeVenueScene,
  getUploadedGlbBytesForScene,
  type VenueViewportProps,
} from '../scene/index.js';
import { populateThreeSceneFromSnapshot } from './evidenceCaptureBridge.js';
import { computeAttendeeSampleVisibilityMask } from './localEvaluatorFallback.js';

export interface InteractiveViewportStageProps extends VenueViewportProps {
  evaluation: Evaluation;
  showSightlineOverlays: boolean;
  onToggleViewMode: (mode: 'overview' | 'attendee_pov') => void;
  onToggleSightlineOverlays: () => void;
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
}: InteractiveViewportStageProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const renderFrameRef = useRef<(() => void) | null>(null);

  const [orbitAngles, setOrbitAngles] = useState<{
    azimuthRad: number;
    polarRad: number;
    distanceM: number;
  }>(() => ({
    azimuthRad: 0.38,
    polarRad: 0.92,
    distanceM: snapshot.places.length > 8 ? 11.5 : 7.4,
  }));

  const orbitAnglesRef = useRef(orbitAngles);
  orbitAnglesRef.current = orbitAngles;

  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  useEffect(() => {
    setOrbitAngles({
      azimuthRad: 0.38,
      polarRad: 0.92,
      distanceM: snapshot.places.length > 8 ? 11.5 : 7.4,
    });
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

  // 1. Mount / Unmount Effect: Create a single persistent WebGLRenderer (prevents WebGL context exhaustion on drag!)
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

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
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

  // 2. Scene Rebuild Effect: Only rebuilds scene geometry when snapshot, selection, viewMode, or overlays change
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    disposeVenueScene(scene);

    populateThreeSceneFromSnapshot(scene, snapshot, {
      hideAttendeeId:
        viewMode === 'attendee_pov' ? selectedAttendeeId : undefined,
      forBlindEvidenceCapture: false,
    });

    // If this snapshot came from an uploaded .glb building (e.g. room.glb),
    // parse and render its actual 3D architectural shell meshes in the scene!
    let cancelled = false;
    const rawGlbBytes = getUploadedGlbBytesForScene(snapshot.sceneId);
    if (rawGlbBytes && rawGlbBytes.byteLength > 20_000) {
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
          // Align +X stage orientation (like room.glb) to VenuePilot's -Z stage axis
          archGroup.rotation.y = Math.PI / 2;
          archGroup.scale.set(0.68, 0.68, 0.68);
          archGroup.position.set(0.0, 0.02, 0.8);

          archGroup.traverse((child) => {
            const mesh = child as THREE.Mesh;
            if (mesh.isMesh && mesh.material) {
              // Make the baked static seat cluster translucent so our 24 interactive
              // color-coded chairs, wheelchair bays, and props remain 100% legible
              if (
                child.name.includes('1275667551') ||
                mesh.name.includes('1275667551')
              ) {
                mesh.material = new THREE.MeshStandardMaterial({
                  color: 0x991b1b,
                  transparent: true,
                  opacity: 0.22,
                  roughness: 0.7,
                });
              }
            }
          });

          scene.add(archGroup);
          renderFrameRef.current?.();
        },
        () => {
          // Ignore GLTFLoader parse error and keep procedural proxy scene
        },
      );
    }

    if (viewMode === 'overview') {
      for (const route of snapshot.routes) {
        if (route.waypoints.length >= 2) {
          const pts = route.waypoints.map(
            ([x, z]) => new THREE.Vector3(x, 0.03, z),
          );
          const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
          const lineMat = new THREE.LineBasicMaterial({ color: 0x38bdf8 });
          scene.add(new THREE.Line(lineGeo, lineMat));
        }
      }

      for (const member of snapshot.roster) {
        const place = snapshot.places.find(
          (p) => p.id === member.assignedPlaceId,
        );
        const obj = snapshot.objects.find((o) => o.id === place?.objectId);
        if (!place || !obj) continue;

        const isSelected = member.attendeeId === selectedAttendeeId;
        const attEval = evaluation.attendees[member.attendeeId];
        const ringColor = !attEval
          ? 0x94a3b8
          : attEval.clearAndUsable
            ? 0x10b981
            : 0xef4444;

        const ringGeo = new THREE.RingGeometry(
          isSelected ? 0.42 : 0.36,
          isSelected ? 0.52 : 0.43,
          28,
        );
        const ringMat = new THREE.MeshBasicMaterial({
          color: isSelected ? 0x60a5fa : ringColor,
          side: THREE.DoubleSide,
        });
        const ringMesh = new THREE.Mesh(ringGeo, ringMat);
        ringMesh.rotation.x = -Math.PI / 2;
        ringMesh.position.set(
          obj.transform.position[0],
          0.02,
          obj.transform.position[2],
        );
        ringMesh.userData = { attendeeId: member.attendeeId };
        scene.add(ringMesh);

        if (place.turningPadCenter && place.turningPadDiameterM) {
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

        const approachPts = [
          new THREE.Vector3(
            place.routeAnchorPoint[0],
            0.025,
            place.routeAnchorPoint[1],
          ),
          new THREE.Vector3(
            obj.transform.position[0],
            0.025,
            obj.transform.position[2],
          ),
        ];
        const appGeo = new THREE.BufferGeometry().setFromPoints(approachPts);
        const appMat = new THREE.LineBasicMaterial({
          color: attEval?.routeStatus === 'blocked' ? 0xef4444 : 0x22c55e,
        });
        scene.add(new THREE.Line(appGeo, appMat));
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

    if (showSightlineOverlays && selectedAttendeeId) {
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
          viewMode === 'overview' &&
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
    viewMode,
    evaluation,
    showSightlineOverlays,
  ]);

  // 3. Camera & Render Effect: Runs at 60fps during orbit/zoom without recreating WebGLRenderer or Scene!
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

      if (viewMode === 'attendee_pov' && selectedAttendeeId) {
        try {
          const pose = getAttendeeCameraPose(snapshot, selectedAttendeeId);
          camera.fov = INSPECTION_CAMERA.fovDeg;
          camera.aspect = INSPECTION_CAMERA.aspect;
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
      } else {
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, width, height);
        camera.fov = 52;
        camera.aspect = width / height;
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
    viewMode,
    evaluation,
    showSightlineOverlays,
    orbitAngles,
  ]);

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
            onClick={() => onToggleViewMode('overview')}
          >
            Room Overview (3D Orbit)
          </button>
          <button
            type="button"
            className={`vp-btn ${viewMode === 'attendee_pov' ? 'vp-btn-primary' : ''}`}
            onClick={() => onToggleViewMode('attendee_pov')}
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

      {/* Interactive 3D Canvas Container */}
      <div
        ref={containerRef}
        onMouseDown={(e) => {
          if (viewMode !== 'overview') return;
          dragStateRef.current = {
            dragging: true,
            startX: e.clientX,
            startY: e.clientY,
            lastX: e.clientX,
            lastY: e.clientY,
          };
        }}
        onMouseMove={(e) => {
          if (!dragStateRef.current.dragging || viewMode !== 'overview') return;
          const dx = e.clientX - dragStateRef.current.lastX;
          const dy = e.clientY - dragStateRef.current.lastY;
          dragStateRef.current.lastX = e.clientX;
          dragStateRef.current.lastY = e.clientY;
          setOrbitAngles((prev) => ({
            ...prev,
            azimuthRad: prev.azimuthRad - dx * 0.007,
            polarRad: Math.max(
              0.22,
              Math.min(1.45, prev.polarRad - dy * 0.007),
            ),
          }));
        }}
        onMouseUp={(e) => {
          const wasDragging = dragStateRef.current.dragging;
          dragStateRef.current.dragging = false;
          if (!wasDragging || viewMode !== 'overview' || !onSelectAttendee) {
            return;
          }
          const dist = Math.hypot(
            e.clientX - dragStateRef.current.startX,
            e.clientY - dragStateRef.current.startY,
          );
          if (dist < 6 && containerRef.current && sceneRef.current && cameraRef.current) {
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
                    onSelectAttendee(cur.userData.attendeeId);
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
          if (viewMode !== 'overview') return;
          setOrbitAngles((prev) => ({
            ...prev,
            distanceM: Math.max(
              3.2,
              Math.min(24.0, prev.distanceM + e.deltaY * 0.006),
            ),
          }));
        }}
        style={{
          flex: 1,
          width: '100%',
          height: '100%',
          cursor: viewMode === 'overview' ? 'grab' : 'crosshair',
        }}
      />

      {/* Quick Seat/Bay Switcher Pill Bar & Selected Attendee HUD */}
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
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
              Active Camera / Place
            </div>
            <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>
              {selectedAttendee
                ? `${selectedAttendee.label} · ${selectedAttendee.assignedPlaceId}`
                : 'Select an attendee'}
            </div>
          </div>

          {selectedEval && (
            <>
              <div>
                <div
                  style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}
                >
                  Sampled Visibility (15×9)
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="mono" style={{ fontWeight: 700, fontSize: '0.88rem' }}>
                    {selectedEval.visibleSamples}/{selectedEval.totalSamples} (
                    {Math.round(selectedEval.sampledVisibility * 100)}%)
                  </span>
                  <span
                    className={`vp-badge ${
                      selectedEval.isViewClear ? 'vp-badge-pass' : 'vp-badge-fail'
                    }`}
                  >
                    {selectedEval.isViewClear ? 'Clear >=122' : 'Obstructed'}
                  </span>
                </div>
              </div>

              <div>
                <div
                  style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}
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
        </div>

        {/* Fast camera jump pills (scrollable so 24 seats never obscure the 3D scene) */}
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
            const active = m.attendeeId === selectedAttendeeId;
            const ev = evaluation.attendees[m.attendeeId];
            return (
              <button
                key={m.attendeeId}
                type="button"
                className={`vp-btn ${active ? 'vp-btn-primary' : ''}`}
                style={{ padding: '4px 8px', fontSize: '0.73rem' }}
                onClick={() => onSelectAttendee?.(m.attendeeId)}
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
