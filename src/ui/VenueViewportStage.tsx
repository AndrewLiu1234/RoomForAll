import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  INSPECTION_CAMERA,
  getAttendeeCameraPose,
  type Evaluation,
  type SceneSnapshot,
} from '../shared/index.js';
import type { VenueViewportProps } from '../scene/index.js';
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
  const [orbitAngles, setOrbitAngles] = useState<{
    azimuthRad: number;
    polarRad: number;
    distanceM: number;
  }>({
    azimuthRad: 0.38,
    polarRad: 0.92,
    distanceM: 7.4,
  });
  const dragStateRef = useRef<{
    dragging: boolean;
    lastX: number;
    lastY: number;
  }>({
    dragging: false,
    lastX: 0,
    lastY: 0,
  });

  const selectedAttendee = snapshot.roster.find(
    (a) => a.attendeeId === selectedAttendeeId,
  );
  const selectedEval = selectedAttendeeId
    ? evaluation.attendees[selectedAttendeeId]
    : undefined;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = Math.max(320, container.clientWidth);
    const height = Math.max(320, container.clientHeight);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    populateThreeSceneFromSnapshot(scene, snapshot, {
      hideAttendeeId:
        viewMode === 'attendee_pov' ? selectedAttendeeId : undefined,
      forBlindEvidenceCapture: false,
    });

    // Add route polylines and dynamic final-approach segments in overview mode
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

        // Selection / status ring on floor under seat/bay
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
        scene.add(ringMesh);

        // Final approach segment from routeAnchorPoint to seat
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
    }

    // Add 15x9 target sample grid & sightline rays when enabled
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

        // In overview mode, draw representative corner & center rays from attendee eye to screen
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

    const camera = new THREE.PerspectiveCamera(
      viewMode === 'attendee_pov' ? INSPECTION_CAMERA.fovDeg : 52,
      viewMode === 'attendee_pov' ? INSPECTION_CAMERA.aspect : width / height,
      INSPECTION_CAMERA.nearM,
      INSPECTION_CAMERA.farM,
    );

    if (viewMode === 'attendee_pov' && selectedAttendeeId) {
      try {
        const pose = getAttendeeCameraPose(snapshot, selectedAttendeeId);
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
        // Square 1:1 viewport framing for 90° x 90° inspection camera
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
      const targetPivot = new THREE.Vector3(0, 0.7, -1.6);
      const cx =
        targetPivot.x +
        orbitAngles.distanceM *
          Math.sin(orbitAngles.polarRad) *
          Math.sin(orbitAngles.azimuthRad);
      const cy =
        targetPivot.y + orbitAngles.distanceM * Math.cos(orbitAngles.polarRad);
      const cz =
        targetPivot.z +
        orbitAngles.distanceM *
          Math.sin(orbitAngles.polarRad) *
          Math.cos(orbitAngles.azimuthRad);
      camera.position.set(cx, cy, cz);
      camera.lookAt(targetPivot);
    }

    renderer.render(scene, camera);

    const handleResize = (): void => {
      if (!containerRef.current) return;
      const w = Math.max(320, containerRef.current.clientWidth);
      const h = Math.max(320, containerRef.current.clientHeight);
      renderer.setSize(w, h);
      if (viewMode === 'attendee_pov') {
        const side = Math.min(w, h);
        const ox = Math.floor((w - side) * 0.5);
        const oy = Math.floor((h - side) * 0.5);
        renderer.setScissorTest(true);
        renderer.setViewport(ox, oy, side, side);
        renderer.setScissor(ox, oy, side, side);
      } else {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      renderer.render(scene, camera);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      renderer.dispose();
    };
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
              0.25,
              Math.min(1.42, prev.polarRad - dy * 0.007),
            ),
          }));
        }}
        onMouseUp={() => {
          dragStateRef.current.dragging = false;
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
              Math.min(13.5, prev.distanceM + e.deltaY * 0.005),
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

        {/* Fast camera jump pills */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
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
                style={{ padding: '5px 10px', fontSize: '0.75rem' }}
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
