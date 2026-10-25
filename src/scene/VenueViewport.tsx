/**
 * Stream A — Interactive 3D Venue & Attendee POV Viewport (`src/scene/VenueViewport.tsx`)
 * Exclusive ownership: Workstream A.
 *
 * Implements PRD §6, §9, §10 Step 2 + `better-ui` & `animate` design-engineering standards:
 * - Concentric border radii (outer container 12px, HUD cards 8px, inner controls 5px)
 * - Layered surface elevation shadows + subtle structural alpha borders
 * - Tactile press scale (`scale(0.97)`), double-ring focus-visible outlines, and reduced-motion support
 * - Persistent WebGLRenderer across prop updates (so selecting seats or switching `overview` <-> `attendee_pov`
 *   never recreates/loses the WebGL context or resets the user's orbit angle)
 * - StrictMode-safe dedicated canvas element per renderer lifecycle with deterministic cleanup on unmount
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  getAttendeeCameraPose,
  type ProfileId,
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
  type BuiltVenueScene,
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

const PROFILE_BADGE_META: Record<
  ProfileId,
  { label: string; color: string; bg: string }
> = {
  reference_adult: {
    label: 'Reference Adult',
    color: '#cbd5e1',
    bg: 'rgba(100, 116, 139, 0.25)',
  },
  shorter_seated: {
    label: 'Shorter Viewer',
    color: '#7dd3fc',
    bg: 'rgba(56, 189, 248, 0.22)',
  },
  wheelchair_user: {
    label: 'Wheelchair User',
    color: '#c4b5fd',
    bg: 'rgba(167, 139, 250, 0.24)',
  },
  extra_legroom: {
    label: 'Extra-Legroom',
    color: '#fde68a',
    bg: 'rgba(251, 191, 36, 0.22)',
  },
};

const VIEWPORT_INLINE_CSS = `
  .vp-preset-btn {
    padding: 5px 10px;
    font-size: 0.74rem;
    font-weight: 500;
    border-radius: 5px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(15, 23, 42, 0.75);
    color: #cbd5e1;
    cursor: pointer;
    transition: transform 120ms cubic-bezier(0.16, 1, 0.3, 1), opacity 120ms cubic-bezier(0.16, 1, 0.3, 1), background-color 120ms ease, border-color 120ms ease;
  }
  .vp-preset-btn[data-active="true"] {
    border-color: rgba(56, 189, 248, 0.75);
    background: rgba(30, 58, 138, 0.82);
    color: #f8fafc;
  }
  .vp-preset-btn:active {
    transform: scale(0.97);
  }
  .vp-preset-btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px #0f172a, 0 0 0 4px #38bdf8;
  }
  @media (hover: hover) and (pointer: fine) {
    .vp-preset-btn:hover {
      border-color: rgba(148, 163, 184, 0.45);
      color: #f8fafc;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .vp-preset-btn {
      transition-duration: 0.01ms !important;
    }
  }
`;

export function computeInitialOrbit(
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
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const builtSceneRef = useRef<BuiltVenueScene | null>(null);
  const orbitRef = useRef<OrbitAngles>(
    computeInitialOrbit(snapshot, overviewPreset),
  );
  const renderFnRef = useRef<(() => void) | null>(null);
  const onSelectAttendeeRef = useRef(onSelectAttendee);
  onSelectAttendeeRef.current = onSelectAttendee;

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

  const hoveredAttendee = useMemo(
    () =>
      hoveredAttendeeId
        ? snapshot.roster.find((a) => a.attendeeId === hoveredAttendeeId) ??
          null
        : null,
    [snapshot.roster, hoveredAttendeeId],
  );

  const activeAttendeePose = useMemo(() => {
    if (!selectedAttendee) return null;
    try {
      return getAttendeeCameraPose(snapshot, selectedAttendee.attendeeId);
    } catch {
      return null;
    }
  }, [snapshot, selectedAttendee]);

  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  useEffect(() => {
    setActivePreset(overviewPreset);
    orbitRef.current = computeInitialOrbit(snapshot, overviewPreset);
  }, [overviewPreset, snapshot.sceneId]);

  // 1. Mount/Unmount Effect: Create one dedicated canvas + WebGLRenderer per mount lifecycle
  useEffect(() => {
    const host = canvasHostRef.current;
    const container = containerRef.current;
    if (!host || !container || typeof document === 'undefined') return;

    const canvas = document.createElement('canvas');
    host.innerHTML = '';
    host.appendChild(canvas);

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
    renderer.setPixelRatio(
      typeof window !== 'undefined'
        ? Math.min(window.devicePixelRatio || 1, 2)
        : 1,
    );
    rendererRef.current = renderer;
    cameraRef.current = new THREE.PerspectiveCamera(52, 1.0, 0.05, 80.0);

    let isDragging = false;
    let pointerDownPos: [number, number] = [0, 0];
    let lastPos: [number, number] = [0, 0];
    const raycaster = new THREE.Raycaster();
    const ndcPointer = new THREE.Vector2();

    const resolvePickedAttendee = (
      clientX: number,
      clientY: number,
    ): string | null => {
      const built = builtSceneRef.current;
      const camera = cameraRef.current;
      if (!built || !camera) return null;
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
      if (viewModeRef.current !== 'overview') return;
      isDragging = true;
      pointerDownPos = [e.clientX, e.clientY];
      lastPos = [e.clientX, e.clientY];
    };

    const onPointerMove = (e: PointerEvent) => {
      if (viewModeRef.current !== 'overview') return;
      if (!isDragging) {
        const picked = resolvePickedAttendee(e.clientX, e.clientY);
        setHoveredAttendeeId(picked);
        return;
      }
      const dx = e.clientX - lastPos[0];
      const dy = e.clientY - lastPos[1];
      lastPos = [e.clientX, e.clientY];
      orbitRef.current.azimuthRad -= dx * 0.0075;
      orbitRef.current.polarRad = Math.max(
        0.18,
        Math.min(Math.PI * 0.46, orbitRef.current.polarRad - dy * 0.0065),
      );
      renderFnRef.current?.();
    };

    const onPointerUp = (e: PointerEvent) => {
      if (viewModeRef.current !== 'overview') return;
      const moveDist = Math.hypot(
        e.clientX - pointerDownPos[0],
        e.clientY - pointerDownPos[1],
      );
      isDragging = false;
      if (moveDist < 6 && onSelectAttendeeRef.current) {
        const picked = resolvePickedAttendee(e.clientX, e.clientY);
        if (picked) {
          onSelectAttendeeRef.current(picked);
        }
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (viewModeRef.current !== 'overview') return;
      e.preventDefault();
      orbitRef.current.distanceM = Math.max(
        3.5,
        Math.min(26.0, orbitRef.current.distanceM + e.deltaY * 0.01),
      );
      renderFnRef.current?.();
    };

    const onResize = () => {
      renderFnRef.current?.();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', onResize);

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
      if (builtSceneRef.current) {
        disposeVenueScene(builtSceneRef.current.scene);
        builtSceneRef.current = null;
      }
      if (rendererRef.current) {
        rendererRef.current.dispose();
        try {
          rendererRef.current.forceContextLoss();
        } catch {
          // Ignore if context loss extension unavailable
        }
        rendererRef.current = null;
      }
      cameraRef.current = null;
      host.innerHTML = '';
    };
  }, []);

  // 2. Preset Change Effect: Update orbit angles when user clicks an overview camera preset button
  const handleSelectPreset = (preset: OverviewCameraPreset) => {
    setActivePreset(preset);
    orbitRef.current = computeInitialOrbit(snapshot, preset);
    renderFnRef.current?.();
  };

  // 3. Scene & Camera Update Effect: Rebuilds only the lightweight Three.js Scene graph and renders on existing WebGLRenderer
  useEffect(() => {
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const container = containerRef.current;
    if (!renderer || !camera || !container) return;

    if (builtSceneRef.current) {
      disposeVenueScene(builtSceneRef.current.scene);
    }

    const built = buildVenueThreeScene(snapshot, {
      cleanForEvidenceCapture: false,
      selectedAttendeeId: selectedAttendee?.attendeeId,
      viewMode,
      showRoutes,
      showTargetGrid,
      highlightedObjectIds,
    });
    builtSceneRef.current = built;

    const renderCurrentState = () => {
      const activeRenderer = rendererRef.current;
      const activeCamera = cameraRef.current;
      const activeBuilt = builtSceneRef.current;
      const activeContainer = containerRef.current;
      if (!activeRenderer || !activeCamera || !activeBuilt || !activeContainer)
        return;

      const canvas = activeRenderer.domElement;
      const rect = activeContainer.getBoundingClientRect();
      const rawW = Math.max(240, Math.floor(rect.width || 640));
      const rawH = Math.max(240, Math.floor(rect.height || 480));

      if (viewMode === 'attendee_pov' && selectedAttendee) {
        // PRD §6 & §8.8: 1:1 square viewport letterboxed inside wider container
        const squareSize = Math.max(200, Math.min(rawW, rawH) - 24);
        canvas.style.width = `${squareSize}px`;
        canvas.style.height = `${squareSize}px`;
        canvas.style.borderRadius = '8px';
        canvas.style.outline = '1px solid rgba(56, 189, 248, 0.45)';
        canvas.style.outlineOffset = '-1px';
        canvas.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.55)';
        activeRenderer.setSize(squareSize, squareSize, false);

        applyActiveViewerVisibility(
          activeBuilt.scene,
          snapshot,
          'attendee_pov',
          selectedAttendee.attendeeId,
          activeBuilt.objectNodesById,
          activeBuilt.attendeeProxyNodesById,
        );
        applyAttendeeCameraPose(
          activeCamera,
          snapshot,
          selectedAttendee.attendeeId,
        );
      } else {
        canvas.style.width = `${rawW}px`;
        canvas.style.height = `${rawH}px`;
        canvas.style.borderRadius = '0px';
        canvas.style.outline = 'none';
        canvas.style.boxShadow = 'none';
        activeRenderer.setSize(rawW, rawH, false);

        applyActiveViewerVisibility(
          activeBuilt.scene,
          snapshot,
          'overview',
          selectedAttendee?.attendeeId,
          activeBuilt.objectNodesById,
          activeBuilt.attendeeProxyNodesById,
        );
        applyOverviewCameraPose(
          activeCamera,
          snapshot,
          rawW / rawH,
          activePreset,
        );

        const orbit = orbitRef.current;
        const sinP = Math.sin(orbit.polarRad);
        const cosP = Math.cos(orbit.polarRad);
        const cx =
          orbit.target[0] + orbit.distanceM * sinP * Math.sin(orbit.azimuthRad);
        const cy = orbit.target[1] + orbit.distanceM * cosP;
        const cz =
          orbit.target[2] + orbit.distanceM * sinP * Math.cos(orbit.azimuthRad);
        activeCamera.position.set(cx, cy, cz);
        activeCamera.lookAt(orbit.target[0], orbit.target[1], orbit.target[2]);
        activeCamera.updateMatrixWorld(true);
      }

      activeRenderer.render(activeBuilt.scene, activeCamera);
    };

    renderFnRef.current = renderCurrentState;
    renderCurrentState();
  }, [
    snapshot,
    selectedAttendee,
    viewMode,
    showRoutes,
    showTargetGrid,
    highlightedObjectIds,
    activePreset,
  ]);

  const activeProfileMeta = selectedAttendee
    ? PROFILE_BADGE_META[selectedAttendee.profileId]
    : null;

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
        borderRadius: '12px',
        border: '1px solid rgba(255, 255, 255, 0.09)',
        boxShadow:
          '0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.32)',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...style,
      }}
    >
      <style>{VIEWPORT_INLINE_CSS}</style>
      <div
        ref={canvasHostRef}
        style={{
          display: webglAvailable ? 'flex' : 'none',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          cursor:
            viewMode === 'overview'
              ? hoveredAttendeeId
                ? 'pointer'
                : 'grab'
              : 'default',
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

      {/* Top-Left HUD Card (Concentric Radius: outer 8px, inner badge 4px) */}
      <div
        style={{
          position: 'absolute',
          top: '12px',
          left: '12px',
          padding: '8px 12px',
          borderRadius: '8px',
          background: 'rgba(15, 23, 42, 0.88)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          boxShadow:
            '0 1px 2px rgba(0, 0, 0, 0.4), 0 4px 12px rgba(0, 0, 0, 0.3)',
          color: '#f8fafc',
          fontSize: '0.78rem',
          pointerEvents: 'none',
          lineHeight: 1.45,
        }}
      >
        {viewMode === 'attendee_pov' &&
        selectedAttendee &&
        activeAttendeePose ? (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontWeight: 600,
                color: '#38bdf8',
              }}
            >
              <span>Attendee POV · 90° × 90° (1:1 Square)</span>
              {activeProfileMeta && (
                <span
                  style={{
                    padding: '1px 6px',
                    borderRadius: '4px',
                    fontSize: '0.68rem',
                    color: activeProfileMeta.color,
                    background: activeProfileMeta.bg,
                  }}
                >
                  {activeProfileMeta.label}
                </span>
              )}
            </div>
            <div>
              {selectedAttendee.label} · Place{' '}
              <code>{activeAttendeePose.placeId}</code>
            </div>
            <div style={{ color: '#94a3b8', fontSize: '0.73rem' }}>
              Eye World:{' '}
              <code>
                [
                {activeAttendeePose.eyePositionWorld
                  .map((v) => v.toFixed(2))
                  .join(', ')}
                ] m
              </code>{' '}
              · Own chair &amp; proxy excluded
            </div>
          </>
        ) : (
          <>
            <div style={{ fontWeight: 600, color: '#f1f5f9' }}>
              Interactive Room Overview ({snapshot.places.length} places)
            </div>
            <div style={{ color: '#94a3b8', fontSize: '0.74rem' }}>
              Drag to orbit · Scroll to zoom · Click any seat to inspect attendee
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
            padding: '3px',
            borderRadius: '8px',
            background: 'rgba(15, 23, 42, 0.85)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            display: 'flex',
            gap: '4px',
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
              className="vp-preset-btn"
              data-active={activePreset === item.id ? 'true' : 'false'}
              onClick={() => handleSelectPreset(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {/* Bottom-Left Overview Visual Legend */}
      {viewMode === 'overview' && (
        <div
          style={{
            position: 'absolute',
            bottom: '12px',
            left: '12px',
            padding: '6px 10px',
            borderRadius: '8px',
            background: 'rgba(15, 23, 42, 0.86)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '10px',
            fontSize: '0.71rem',
            color: '#cbd5e1',
            pointerEvents: 'none',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '2px',
                background: '#d97706',
              }}
            />
            Movable Prop
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '2px',
                background: '#38bdf8',
              }}
            />
            Shorter Viewer
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '2px',
                background: '#fbbf24',
              }}
            />
            Extra-Legroom
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '2px',
                background: '#a78bfa',
              }}
            />
            Wheelchair Bay
          </span>
        </div>
      )}

      {/* Bottom-Right Hover Attendee Pill */}
      {viewMode === 'overview' && hoveredAttendee && (
        <div
          style={{
            position: 'absolute',
            bottom: '12px',
            right: '12px',
            padding: '6px 10px',
            borderRadius: '8px',
            background: 'rgba(15, 23, 42, 0.92)',
            border: '1px solid rgba(56, 189, 248, 0.45)',
            color: '#f8fafc',
            fontSize: '0.74rem',
            pointerEvents: 'none',
          }}
        >
          <strong>{hoveredAttendee.label}</strong> ·{' '}
          <code>{hoveredAttendee.assignedPlaceId}</code> (Click to select)
        </div>
      )}
    </div>
  );
}
export default VenueViewport;
