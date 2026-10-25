/**
 * Stream A — Interactive 3D Venue & Attendee POV Viewport (`src/scene/VenueViewport.tsx`)
 * Exclusive ownership: Workstream A.
 *
 * Implements PRD §6, §9, §10 Step 2:
 * - Renders `SceneSnapshot` in Three.js with interactive overview orbit/zoom and raycast seat selection.
 * - Supports `attendee_pov` mode using a 1:1 square letterboxed viewport with `90°` H/V FOV
 *   positioned at `getAttendeeCameraPose(snapshot, selectedAttendeeId)` and excluding the
 *   active viewer's own chair and torso proxy so the visual view matches Stream B's evaluator.
 * - Gracefully degrades in headless/non-WebGL test environments and cleans up WebGL contexts on unmount.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  getAttendeeCameraPose,
  type SceneSnapshot,
} from '../shared/index.js';
import {
  applyAttendeeCameraPose,
  applyOverviewCameraPose,
  getOverviewCameraPose,
  type OverviewCameraPreset,
} from './cameraSystem.js';
import {
  applyActiveViewerVisibility,
  buildVenueThreeScene,
  disposeVenueScene,
} from './sceneBuilder.js';

export interface VenueViewportProps {
  snapshot: SceneSnapshot;
  selectedAttendeeId?: string;
  viewMode: 'overview' | 'attendee_pov';
  onSelectAttendee?: (attendeeId: string) => void;
  showRoutes?: boolean;
  showTargetGrid?: boolean;
  highlightedObjectIds?: string[];
  overviewPreset?: OverviewCameraPreset;
  className?: string;
  style?: React.CSSProperties;
}

interface OrbitAngles {
  azimuthRad: number;
  polarRad: number;
  distanceM: number;
  target: [number, number, number];
}

function computeInitialOrbit(
  snapshot: SceneSnapshot,
  preset: OverviewCameraPreset,
): OrbitAngles {
  const pose = getOverviewCameraPose(snapshot, preset);
  const dx = pose.position[0] - pose.lookAt[0];
  const dy = pose.position[1] - pose.lookAt[1];
  const dz = pose.position[2] - pose.lookAt[2];
  const dist = Math.max(2.0, Math.hypot(dx, dy, dz));
  const polarRad = Math.acos(Math.max(-0.99, Math.min(0.99, dy / dist)));
  const azimuthRad = Math.atan2(dx, dz);
  return {
    azimuthRad,
    polarRad,
    distanceM: dist,
    target: [...pose.lookAt],
  };
}

export function VenueViewport({
  snapshot,
  selectedAttendeeId,
  viewMode,
  onSelectAttendee,
  showRoutes = true,
  showTargetGrid = false,
  highlightedObjectIds,
  overviewPreset = 'front_high',
  className,
  style,
}: VenueViewportProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [activePreset, setActivePreset] =
    useState<OverviewCameraPreset>(overviewPreset);
  const [webglAvailable, setWebglAvailable] = useState<boolean>(true);
  const [hoveredAttendeeId, setHoveredAttendeeId] = useState<string | null>(
    null,
  );

  const selectedAttendee = useMemo(
    () =>
      snapshot.roster.find((a) => a.attendeeId === selectedAttendeeId) ??
      snapshot.roster[0],
    [snapshot.roster, selectedAttendeeId],
  );

  const activeAttendeePose = useMemo(() => {
    if (!selectedAttendee) return null;
    try {
      return getAttendeeCameraPose(snapshot, selectedAttendee.attendeeId);
    } catch {
      return null;
    }
  }, [snapshot, selectedAttendee]);

  useEffect(() => {
    setActivePreset(overviewPreset);
  }, [overviewPreset]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        powerPreference: 'high-performance',
      });
    } catch {
      setWebglAvailable(false);
      return;
    }

    setWebglAvailable(true);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const built = buildVenueThreeScene(snapshot, {
      cleanForEvidenceCapture: false,
      selectedAttendeeId: selectedAttendee?.attendeeId,
      viewMode,
      showRoutes,
      showTargetGrid,
      highlightedObjectIds,
    });

    const camera = new THREE.PerspectiveCamera(52, 1.0, 0.05, 80.0);
    const orbit = computeInitialOrbit(snapshot, activePreset);

    const updateViewportAndRender = () => {
      if (!renderer || !container) return;
      const rect = container.getBoundingClientRect();
      const rawW = Math.max(240, Math.floor(rect.width || 640));
      const rawH = Math.max(240, Math.floor(rect.height || 480));

      if (viewMode === 'attendee_pov' && selectedAttendee) {
        // PRD §6 & §8.8: 1:1 square viewport letterboxed inside wider container
        const squareSize = Math.max(200, Math.min(rawW, rawH) - 16);
        canvas.style.width = `${squareSize}px`;
        canvas.style.height = `${squareSize}px`;
        renderer.setSize(squareSize, squareSize, false);

        applyActiveViewerVisibility(
          built.scene,
          snapshot,
          'attendee_pov',
          selectedAttendee.attendeeId,
          built.objectNodesById,
          built.attendeeProxyNodesById,
        );
        applyAttendeeCameraPose(
          camera,
          snapshot,
          selectedAttendee.attendeeId,
        );
      } else {
        canvas.style.width = `${rawW}px`;
        canvas.style.height = `${rawH}px`;
        renderer.setSize(rawW, rawH, false);

        applyActiveViewerVisibility(
          built.scene,
          snapshot,
          'overview',
          selectedAttendee?.attendeeId,
          built.objectNodesById,
          built.attendeeProxyNodesById,
        );
        applyOverviewCameraPose(
          camera,
          snapshot,
          rawW / rawH,
          activePreset,
        );

        // Apply interactive orbit spherical coordinates
        const sinP = Math.sin(orbit.polarRad);
        const cosP = Math.cos(orbit.polarRad);
        const cx =
          orbit.target[0] + orbit.distanceM * sinP * Math.sin(orbit.azimuthRad);
        const cy = orbit.target[1] + orbit.distanceM * cosP;
        const cz =
          orbit.target[2] + orbit.distanceM * sinP * Math.cos(orbit.azimuthRad);
        camera.position.set(cx, cy, cz);
        camera.lookAt(orbit.target[0], orbit.target[1], orbit.target[2]);
        camera.updateMatrixWorld(true);
      }

      renderer.render(built.scene, camera);
    };

    updateViewportAndRender();

    // Interactive pointer orbit + click-to-select attendee in overview mode
    let isDragging = false;
    let pointerDownPos: [number, number] = [0, 0];
    let lastPos: [number, number] = [0, 0];
    const raycaster = new THREE.Raycaster();
    const ndcPointer = new THREE.Vector2();

    const resolvePickedAttendee = (clientX: number, clientY: number): string | null => {
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return null;
      ndcPointer.x = ((clientX - bounds.left) / bounds.width) * 2 - 1;
      ndcPointer.y = -((clientY - bounds.top) / bounds.height) * 2 + 1;
      raycaster.setFromCamera(ndcPointer, camera);
      const hits = raycaster.intersectObjects(built.pickableMeshes, true);
      for (const hit of hits) {
        let cur: THREE.Object3D | null = hit.object;
        while (cur) {
          if (typeof cur.userData?.ownerAttendeeId === 'string') {
            return cur.userData.ownerAttendeeId;
          }
          cur = cur.parent;
        }
      }
      return null;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (viewMode !== 'overview') return;
      isDragging = true;
      pointerDownPos = [e.clientX, e.clientY];
      lastPos = [e.clientX, e.clientY];
    };

    const onPointerMove = (e: PointerEvent) => {
      if (viewMode !== 'overview') return;
      if (!isDragging) {
        const picked = resolvePickedAttendee(e.clientX, e.clientY);
        setHoveredAttendeeId(picked);
        return;
      }
      const dx = e.clientX - lastPos[0];
      const dy = e.clientY - lastPos[1];
      lastPos = [e.clientX, e.clientY];
      orbit.azimuthRad -= dx * 0.0075;
      orbit.polarRad = Math.max(
        0.18,
        Math.min(Math.PI * 0.46, orbit.polarRad - dy * 0.0065),
      );
      updateViewportAndRender();
    };

    const onPointerUp = (e: PointerEvent) => {
      if (viewMode !== 'overview') return;
      const moveDist = Math.hypot(
        e.clientX - pointerDownPos[0],
        e.clientY - pointerDownPos[1],
      );
      isDragging = false;
      if (moveDist < 6 && onSelectAttendee) {
        const picked = resolvePickedAttendee(e.clientX, e.clientY);
        if (picked) {
          onSelectAttendee(picked);
        }
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (viewMode !== 'overview') return;
      e.preventDefault();
      orbit.distanceM = Math.max(
        3.5,
        Math.min(26.0, orbit.distanceM + e.deltaY * 0.01),
      );
      updateViewportAndRender();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', updateViewportAndRender);

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', updateViewportAndRender);
      disposeVenueScene(built.scene);
      if (renderer) {
        renderer.dispose();
        try {
          renderer.forceContextLoss();
        } catch {
          // Ignore if context loss extension unavailable
        }
      }
    };
  }, [
    snapshot,
    selectedAttendee?.attendeeId,
    viewMode,
    showRoutes,
    showTargetGrid,
    highlightedObjectIds,
    activePreset,
    onSelectAttendee,
  ]);

  return (
    <div
      ref={containerRef}
      className={className}
      data-testid="venue-viewport"
      data-view-mode={viewMode}
      data-scene-hash={snapshot.sceneHash}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: '420px',
        background: '#090d16',
        borderRadius: '10px',
        border: '1px solid #1e293b',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...style,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: webglAvailable ? 'block' : 'none',
          cursor:
            viewMode === 'overview'
              ? hoveredAttendeeId
                ? 'pointer'
                : 'grab'
              : 'default',
          borderRadius: viewMode === 'attendee_pov' ? '8px' : '0px',
          boxShadow:
            viewMode === 'attendee_pov'
              ? '0 0 0 2px rgba(56, 189, 248, 0.45)'
              : 'none',
        }}
      />

      {!webglAvailable && (
        <div
          style={{
            padding: '20px',
            color: '#cbd5e1',
            fontSize: '0.88rem',
            textAlign: 'center',
          }}
        >
          <div>
            <strong>3D Venue Viewport ({snapshot.sceneId})</strong>
          </div>
          <div>
            Mode: <code>{viewMode}</code> · Places: {snapshot.places.length} ·
            Selected: <code>{selectedAttendee?.label ?? 'none'}</code>
          </div>
        </div>
      )}

      {/* Top-Left HUD Badge */}
      <div
        style={{
          position: 'absolute',
          top: '12px',
          left: '12px',
          padding: '8px 12px',
          borderRadius: '8px',
          background: 'rgba(15, 23, 42, 0.86)',
          border: '1px solid rgba(148, 163, 184, 0.22)',
          color: '#f8fafc',
          fontSize: '0.78rem',
          pointerEvents: 'none',
          lineHeight: 1.4,
        }}
      >
        {viewMode === 'attendee_pov' && selectedAttendee && activeAttendeePose ? (
          <>
            <div style={{ fontWeight: 600, color: '#38bdf8' }}>
              Attendee POV (90° × 90° Square 1:1)
            </div>
            <div>
              {selectedAttendee.label} · Place{' '}
              <code>{activeAttendeePose.placeId}</code>
            </div>
            <div style={{ color: '#94a3b8' }}>
              Eye World:{' '}
              <code>
                [
                {activeAttendeePose.eyePositionWorld
                  .map((v) => v.toFixed(2))
                  .join(', ')}
                ] m
              </code>{' '}
              (own chair &amp; proxy excluded)
            </div>
          </>
        ) : (
          <>
            <div style={{ fontWeight: 600, color: '#e2e8f0' }}>
              Interactive Room Overview ({snapshot.places.length} places)
            </div>
            <div style={{ color: '#94a3b8' }}>
              Drag to orbit · Scroll to zoom · Click any seat to select attendee
            </div>
          </>
        )}
      </div>

      {/* Top-Right Overview Camera Preset Pills */}
      {viewMode === 'overview' && (
        <div
          style={{
            position: 'absolute',
            top: '12px',
            right: '12px',
            display: 'flex',
            gap: '6px',
          }}
        >
          {(
            [
              { id: 'front_high', label: '3/4 Rear' },
              { id: 'top_down', label: 'Top Plan' },
              { id: 'stage_oblique', label: 'Stage Side' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActivePreset(item.id)}
              style={{
                padding: '5px 10px',
                fontSize: '0.74rem',
                borderRadius: '6px',
                border:
                  activePreset === item.id
                    ? '1px solid #38bdf8'
                    : '1px solid #334155',
                background:
                  activePreset === item.id
                    ? 'rgba(30, 58, 138, 0.85)'
                    : 'rgba(15, 23, 42, 0.82)',
                color: '#f1f5f9',
                cursor: 'pointer',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
export default VenueViewport;
