import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  INSPECTION_CAMERA,
  getAttendeeCameraPose,
  type Evaluation,
  type EvacuationMode,
} from '../shared/index.js';
import { simulateEvacuation } from '../evaluation/index.js';
import {
  updateSceneEvacuationStep,
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
}: InteractiveViewportStageProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const attendeeProxyNodesRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const defaultDistance = snapshot.places.length > 8 ? 10.6 : 7.2;

  const [evacMode, setEvacMode] = useState<EvacuationMode>('none');
  const [evacTimeSec, setEvacTimeSec] = useState<number>(0);
  const [isPlayingEvac, setIsPlayingEvac] = useState<boolean>(false);
  const [evacCounts, setEvacCounts] = useState<{
    exitedCount: number;
    queuingCount: number;
    activeCount: number;
  }>({ exitedCount: 0, queuingCount: 0, activeCount: snapshot.roster.length });

  const evacSimResult = useMemo(() => {
    if (evacMode === 'none') return null;
    return simulateEvacuation(snapshot, evacMode);
  }, [snapshot, evacMode]);

  const [orbitAngles, setOrbitAngles] = useState<{
    azimuthRad: number;
    polarRad: number;
    distanceM: number;
  }>(() => ({
    azimuthRad: 0.38,
    polarRad: 0.92,
    distanceM: defaultDistance,
  }));

  const orbitAnglesRef = useRef(orbitAngles);
  orbitAnglesRef.current = orbitAngles;

  useEffect(() => {
    setOrbitAngles({
      azimuthRad: 0.38,
      polarRad: 0.92,
      distanceM: snapshot.places.length > 8 ? 10.6 : 7.2,
    });
  }, [snapshot.sceneId, snapshot.places.length]);

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
  const selectedProfile = selectedAttendee
    ? snapshot.profiles[selectedAttendee.profileId]
    : undefined;
  const selectedPlace = selectedAttendee
    ? snapshot.places.find((p) => p.id === selectedAttendee.assignedPlaceId)
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
      onSelectAttendee(nextIssue.attendeeId);
    }
  };

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

    const proxyMap = new Map<string, THREE.Object3D>();
    scene.traverse((child) => {
      if (child.name.startsWith('proxy_attendee_torso_') && child.userData?.ownerAttendeeId) {
        proxyMap.set(child.userData.ownerAttendeeId as string, child);
      }
    });
    attendeeProxyNodesRef.current = proxyMap;

    // Add route polylines and dynamic final-approach segments in overview mode
    if (viewMode === 'overview') {
      for (const route of snapshot.routes) {
        if (route.waypoints.length >= 2) {
          const pts = route.waypoints.map(
            ([x, z]) => new THREE.Vector3(x, 0.03, z),
          );
          const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
          const lineMat = new THREE.LineBasicMaterial({
            color: 0x38bdf8,
            transparent: true,
            opacity: 0.45,
          });
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
        const chairElevation = Math.max(0.04, obj.transform.position[1]);
        const ringGeo = new THREE.RingGeometry(
          isSelected ? 0.44 : 0.36,
          isSelected ? 0.54 : 0.43,
          32,
        );
        const ringMat = new THREE.MeshBasicMaterial({
          color: isSelected ? 0x60a5fa : ringColor,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: isSelected ? 0.95 : 0.72,
        });
        const ringMesh = new THREE.Mesh(ringGeo, ringMat);
        ringMesh.rotation.x = -Math.PI / 2;
        ringMesh.position.set(
          obj.transform.position[0],
          chairElevation + 0.005,
          obj.transform.position[2],
        );
        scene.add(ringMesh);

        // Final approach segment from routeAnchorPoint to seat
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
          transparent: true,
          opacity: 0.4,
        });
        scene.add(new THREE.Line(appGeo, appMat));
      }

      // Draw baseline -> revised displacement vectors for any object moved by a patch
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

    // Add 15x9 target sample grid & sightline rays when enabled
    if (showSightlineOverlays && selectedAttendeeId) {
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
            opacity: isClear ? 0.32 : 0.65,
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
      const currentOrbit = orbitAnglesRef.current;
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, width, height);
      const targetPivot = new THREE.Vector3(0, 0.7, -1.6);
      const cx =
        targetPivot.x +
        currentOrbit.distanceM *
          Math.sin(currentOrbit.polarRad) *
          Math.sin(currentOrbit.azimuthRad);
      const cy =
        targetPivot.y +
        currentOrbit.distanceM * Math.cos(currentOrbit.polarRad);
      const cz =
        targetPivot.z +
        currentOrbit.distanceM *
          Math.sin(currentOrbit.polarRad) *
          Math.cos(currentOrbit.azimuthRad);
      camera.position.set(cx, cy, cz);
      camera.lookAt(targetPivot);
    }

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;

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
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      renderer.dispose();
    };
  }, [
    snapshot,
    selectedAttendeeId,
    viewMode,
    evaluation,
    showSightlineOverlays,
  ]);

  // Lightweight camera orbit update without recreating WebGLRenderer or Three.js scene
  useEffect(() => {
    if (viewMode !== 'overview') return;
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return;

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
    renderer.render(scene, camera);
  }, [orbitAngles, viewMode]);

  // Apply evacuation step whenever evacTimeSec or evacSimResult changes
  useEffect(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return;

    const counts = updateSceneEvacuationStep(
      attendeeProxyNodesRef.current,
      evacSimResult,
      evacTimeSec,
    );
    setEvacCounts(counts);
    renderer.render(scene, camera);
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
        {/* Left: Camera Mode Switcher + Ray Overlay Toggle */}
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
              onClick={() => onToggleViewMode('overview')}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                <line x1="12" x2="12" y1="22.08" y2="12" />
              </svg>
              <span>Room Orbit</span>
            </button>

            <button
              type="button"
              className={`vp-segment-btn vp-focusable ${
                viewMode === 'attendee_pov' ? 'vp-segment-btn-active' : ''
              }`}
              onClick={() => onToggleViewMode('attendee_pov')}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
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
              <span>
                Next Issue ({obstructedAttendees.length})
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Live Egress / Emergency Evacuation Telemetry HUD Banner */}
      {evacMode !== 'none' && evacSimResult && (
        <div
          style={{
            position: 'absolute',
            top: '60px',
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
          </div>
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
          cursor: viewMode === 'overview' ? 'grab' : 'default',
        }}
      />

      {/* Sleek Bottom-Center Floating Guest Dock */}
      {selectedAttendee && selectedEval && (
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
              maxWidth: '680px',
            }}
          >
            {/* Prev / Next Guest Stepper */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <button
                type="button"
                aria-label="Previous guest"
                className="vp-btn"
                style={{ padding: '5px 8px' }}
                onClick={() => stepAttendee(-1)}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>
              <button
                type="button"
                aria-label="Next guest"
                className="vp-btn"
                style={{ padding: '5px 8px' }}
                onClick={() => stepAttendee(1)}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
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
              <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                {selectedProfile?.label ?? selectedAttendee.profileId}
              </div>
            </div>

            <div className="vp-divider-v" />

            {/* Sightline Status Pill */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span
                className={`vp-badge ${
                  selectedEval.clearAndUsable ? 'vp-badge-pass' : 'vp-badge-fail'
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
                onToggleViewMode(
                  viewMode === 'attendee_pov' ? 'overview' : 'attendee_pov',
                )
              }
            >
              {viewMode === 'attendee_pov' ? 'Back to Orbit' : 'Inspect POV'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
