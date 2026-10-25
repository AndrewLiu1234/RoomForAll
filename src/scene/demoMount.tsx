/**
 * Stream A — Interactive Guided 3D Demo & Walkthrough (`src/scene/demoMount.tsx`)
 * Exclusive ownership: Workstream A (`src/scene/`, `public/venue/`).
 *
 * Mounted by `public/venue/demo.html` (`http://localhost:5173/venue/demo.html`).
 * Guides the user step-by-step through all four core capabilities of Part A:
 * 1. 24-Place Prepared Venue & 3D Room Overview
 * 2. 1:1 Square 90° Attendee POV & Self-Occlusion Exclusion
 * 3. Before vs. After Bounded Repair Patch Comparison
 * 4. Live Browser Video Recording (`captureEvidence`) + Playable Clip & Manifest
 */
import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  withUpdatedSceneHash,
  type CapturedEvidencePayload,
  type SceneSnapshot,
} from '../shared/index.js';
import { evaluateScene } from '../evaluation/index.js';
import {
  VenueViewport,
  buildDefaultCaptureKeyframes,
  captureEvidence,
  createPreparedVenueReferencePatch,
  createPreparedVenueSnapshot,
  generateVenueGlbBinary,
  parseAndLabelGlbVenue,
  type GlbVenueParseReport,
  type OverviewCameraPreset,
} from './index.js';

function applyPatchForDemo(baseline: SceneSnapshot): SceneSnapshot {
  const cloned = structuredClone(baseline);
  const patch = createPreparedVenueReferencePatch(
    'run_demo_preview',
    baseline.sceneHash,
  );
  for (const op of patch.operations) {
    if (op.targetType === 'object') {
      const obj = cloned.objects.find((o) => o.id === op.targetId);
      if (obj) {
        obj.transform.position[0] = Number(
          (obj.transform.position[0] + op.deltaPositionM[0]).toFixed(4),
        );
        obj.transform.position[1] = Number(
          (obj.transform.position[1] + op.deltaPositionM[1]).toFixed(4),
        );
        obj.transform.position[2] = Number(
          (obj.transform.position[2] + op.deltaPositionM[2]).toFixed(4),
        );
        obj.transform.yawDeg = Number(
          (obj.transform.yawDeg + op.deltaYawDeg).toFixed(4),
        );
      }
    }
  }
  return withUpdatedSceneHash(cloned);
}

interface WalkthroughStep {
  stepNumber: 1 | 2 | 3 | 4;
  title: string;
  shortGoal: string;
  instructions: string[];
}

const WALKTHROUGH_STEPS: WalkthroughStep[] = [
  {
    stepNumber: 1,
    title: 'Step 1: Explore the 24-Place Venue (Overview)',
    shortGoal: 'See the room layout, 4 attendee profiles, and 3 orange movable props.',
    instructions: [
      'Drag on the 3D canvas to rotate the room. Scroll to zoom in and out.',
      'Look at the 3 orange movable props: the Welcome Sign (front center), the Literature Table (front right), and the AV Cart (back right inside the blue wheelchair turning ring).',
      'Toggle "15x9 Target Grid (135 pts)" below to see the exact 135 screen sample points used for scoring.',
    ],
  },
  {
    stepNumber: 2,
    title: 'Step 2: Check Attendee 90° Square POV',
    shortGoal: 'Look through Sam Patel’s eyes (Shorter Viewer, eye height 0.97 m).',
    instructions: [
      'The viewport is now a 1:1 square (90° wide by 90° high) at Sam Patel’s exact eye height (0.97 m).',
      'Notice how the orange Welcome Sign blocks the middle of the presentation screen for Sam.',
      'Also notice that Sam’s own chair and body box are hidden so they do not block the camera, while all other 23 chairs and body boxes stay visible.',
    ],
  },
  {
    stepNumber: 3,
    title: 'Step 3: Compare Before vs. After Repair Patch',
    shortGoal: 'Apply the 3-step repair patch and switch between Baseline and Patched.',
    instructions: [
      'Click "Patched (After 3-Step Fix)" below while looking through Sam Patel’s POV: the orange Welcome Sign moves 0.55 m west, clearing 135/135 screen points.',
      'Switch to "Room Overview" and toggle Before vs. After to watch all 3 cyan-highlighted props move to safe positions.',
      'Click "Morgan Lee" (Extra-Legroom) or "Jordan Taylor" (Wheelchair Bay W2) in the quick list to inspect their fixed spaces.',
    ],
  },
  {
    stepNumber: 4,
    title: 'Step 4: Record a Live Evidence Video Clip',
    shortGoal: 'Run captureEvidence() in your browser to record a real WebM/MP4 tour.',
    instructions: [
      'Click "Record 5-Stop Evidence Video Now" in the right panel.',
      'Part A renders the 5-stop camera tour (Overview + 4 profile POVs) on an offscreen 512x512 canvas while keeping the main 3D viewport interactive.',
      'Play back the recorded video clip and inspect the generated EvidenceManifest JSON below it.',
    ],
  },
];

export function PartADemoApp(): React.ReactElement {
  const baselineSnapshot = useMemo(() => createPreparedVenueSnapshot(), []);
  const patchedSnapshot = useMemo(
    () => applyPatchForDemo(baselineSnapshot),
    [baselineSnapshot],
  );
  const referencePatch = useMemo(
    () =>
      createPreparedVenueReferencePatch(
        'run_demo_preview',
        baselineSnapshot.sceneHash,
      ),
    [baselineSnapshot],
  );

  const [activeStep, setActiveStep] = useState<1 | 2 | 3 | 4>(1);
  const [scenePhase, setScenePhase] = useState<'baseline' | 'patched'>(
    'baseline',
  );
  const [viewMode, setViewMode] = useState<'overview' | 'attendee_pov'>(
    'overview',
  );
  const [selectedAttendeeId, setSelectedAttendeeId] =
    useState<string>('att_shorter_01');
  const [showRoutes, setShowRoutes] = useState<boolean>(true);
  const [showTargetGrid, setShowTargetGrid] = useState<boolean>(false);
  const [highlightMovedProps, setHighlightMovedProps] =
    useState<boolean>(false);
  const [overviewPreset, setOverviewPreset] =
    useState<OverviewCameraPreset>('front_high');

  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordedPayload, setRecordedPayload] =
    useState<CapturedEvidencePayload | null>(null);
  const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [glbParseReport, setGlbParseReport] =
    useState<GlbVenueParseReport | null>(null);
  const [useParsedGlbSnapshot, setUseParsedGlbSnapshot] =
    useState<boolean>(false);

  const activeSnapshot =
    useParsedGlbSnapshot && glbParseReport
      ? glbParseReport.snapshot
      : scenePhase === 'patched'
        ? patchedSnapshot
        : baselineSnapshot;
  const activeEval = useMemo(
    () => evaluateScene(activeSnapshot),
    [activeSnapshot],
  );
  const selectedAttendeeEval = activeEval.attendees[selectedAttendeeId];

  const highlightedObjectIds = useMemo(
    () =>
      highlightMovedProps
        ? [
            'obj_prop_welcome_sign',
            'obj_prop_catering_table',
            'obj_prop_av_cart',
          ]
        : [],
    [highlightMovedProps],
  );

  const goToGuidedStep = (step: 1 | 2 | 3 | 4) => {
    setActiveStep(step);
    if (step === 1) {
      setViewMode('overview');
      setScenePhase('baseline');
      setHighlightMovedProps(false);
      setOverviewPreset('front_high');
    } else if (step === 2) {
      setSelectedAttendeeId('att_shorter_01');
      setViewMode('attendee_pov');
      setScenePhase('baseline');
      setHighlightMovedProps(false);
    } else if (step === 3) {
      setSelectedAttendeeId('att_shorter_01');
      setScenePhase('patched');
      setHighlightMovedProps(true);
    } else if (step === 4) {
      setHighlightMovedProps(true);
    }
  };

  const handleRecordLiveVideo = async () => {
    setIsRecording(true);
    setRecordError(null);
    try {
      const durationSec = 4;
      const keyframes = buildDefaultCaptureKeyframes(
        activeSnapshot,
        durationSec,
      );
      const result = await captureEvidence(activeSnapshot, {
        captureId: `cap_demo_${scenePhase}_${Date.now()}`,
        runId: 'run_interactive_demo',
        phase: scenePhase === 'patched' ? 'revision' : 'baseline',
        sceneHash: activeSnapshot.sceneHash,
        snapshot: activeSnapshot,
        keyframes,
        totalDurationSec: durationSec,
        deadlineIso: new Date(Date.now() + 60_000).toISOString(),
      });
      if (recordedVideoUrl) {
        URL.revokeObjectURL(recordedVideoUrl);
      }
      const nextUrl = URL.createObjectURL(result.videoBlob);
      setRecordedPayload(result);
      setRecordedVideoUrl(nextUrl);
    } catch (err) {
      setRecordError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRecording(false);
    }
  };

  const currentStepInfo = WALKTHROUGH_STEPS.find(
    (s) => s.stepNumber === activeStep,
  )!;

  const keyDemoAttendees = [
    {
      id: 'att_shorter_01',
      tag: 'Problem 1: Blocked View',
      note: 'Row 1 Center shorter viewer behind Welcome Sign',
    },
    {
      id: 'att_extra_legroom_01',
      tag: 'Problem 2: Tight Legroom',
      note: 'Row 1 East extra-legroom seat behind Literature Table',
    },
    {
      id: 'att_wheelchair_01',
      tag: 'Problem 3: Turning Circle',
      note: 'East Wheelchair Bay W2 next to parked AV Cart',
    },
    {
      id: 'att_adult_01',
      tag: 'Control: Clear Adult View',
      note: 'Row 1 West reference adult with unobstructed sightline',
    },
  ];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '360px 1fr 370px',
        height: '100vh',
        background: '#070a12',
        color: '#f8fafc',
        fontFamily:
          'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        overflow: 'hidden',
      }}
    >
      {/* LEFT PANEL: Guided Walkthrough & Controls */}
      <aside
        style={{
          padding: '18px',
          borderRight: '1px solid rgba(255, 255, 255, 0.08)',
          background: '#0f172a',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
        }}
      >
        <div>
          <div
            style={{
              display: 'inline-block',
              padding: '2px 8px',
              borderRadius: '4px',
              background: 'rgba(56, 189, 248, 0.18)',
              color: '#38bdf8',
              fontSize: '0.72rem',
              fontWeight: 600,
              marginBottom: '6px',
            }}
          >
            WORKSTREAM A · INTERACTIVE GUIDE
          </div>
          <h1 style={{ fontSize: '1.15rem', margin: '0 0 4px 0' }}>
            VenuePilot 3D Scene &amp; Evidence Demo
          </h1>
          <div style={{ fontSize: '0.76rem', color: '#94a3b8' }}>
            Scene ID: <code>{activeSnapshot.sceneId}</code> · Hash:{' '}
            <code>{activeSnapshot.sceneHash}</code>
          </div>
        </div>

        {/* Stepper Pills */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '6px',
          }}
        >
          {WALKTHROUGH_STEPS.map((s) => {
            const isCurrent = s.stepNumber === activeStep;
            return (
              <button
                key={s.stepNumber}
                type="button"
                onClick={() => goToGuidedStep(s.stepNumber)}
                style={{
                  padding: '7px 4px',
                  borderRadius: '6px',
                  border: isCurrent
                    ? '1px solid #38bdf8'
                    : '1px solid rgba(255, 255, 255, 0.1)',
                  background: isCurrent ? '#1e3a8a' : '#1e293b',
                  color: isCurrent ? '#ffffff' : '#94a3b8',
                  fontWeight: 600,
                  fontSize: '0.76rem',
                  cursor: 'pointer',
                }}
              >
                Step {s.stepNumber}
              </button>
            );
          })}
        </div>

        {/* Active Step Guide Box */}
        <div
          style={{
            padding: '12px',
            borderRadius: '8px',
            background: 'rgba(30, 58, 138, 0.28)',
            border: '1px solid rgba(56, 189, 248, 0.35)',
          }}
        >
          <div
            style={{
              fontWeight: 600,
              fontSize: '0.88rem',
              color: '#bae6fd',
              marginBottom: '4px',
            }}
          >
            {currentStepInfo.title}
          </div>
          <div
            style={{
              fontSize: '0.78rem',
              color: '#e2e8f0',
              marginBottom: '8px',
            }}
          >
            <strong>Goal:</strong> {currentStepInfo.shortGoal}
          </div>
          <ul
            style={{
              margin: '0 0 10px 0',
              paddingLeft: '18px',
              fontSize: '0.76rem',
              color: '#cbd5e1',
              lineHeight: 1.45,
            }}
          >
            {currentStepInfo.instructions.map((line, i) => (
              <li key={i} style={{ marginBottom: '4px' }}>
                {line}
              </li>
            ))}
          </ul>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <button
              type="button"
              disabled={activeStep === 1}
              onClick={() =>
                goToGuidedStep(Math.max(1, activeStep - 1) as 1 | 2 | 3 | 4)
              }
              style={{
                padding: '5px 10px',
                borderRadius: '5px',
                border: '1px solid #334155',
                background: '#1e293b',
                color: activeStep === 1 ? '#475569' : '#f1f5f9',
                fontSize: '0.75rem',
                cursor: activeStep === 1 ? 'default' : 'pointer',
              }}
            >
              ← Previous
            </button>
            <button
              type="button"
              disabled={activeStep === 4}
              onClick={() =>
                goToGuidedStep(Math.min(4, activeStep + 1) as 1 | 2 | 3 | 4)
              }
              style={{
                padding: '5px 12px',
                borderRadius: '5px',
                border: '1px solid #38bdf8',
                background: activeStep === 4 ? '#1e293b' : '#0284c7',
                color: activeStep === 4 ? '#475569' : '#ffffff',
                fontWeight: 600,
                fontSize: '0.75rem',
                cursor: activeStep === 4 ? 'default' : 'pointer',
              }}
            >
              Next Step →
            </button>
          </div>
        </div>

        {/* Camera & Scene Controls */}
        <div
          style={{
            padding: '12px',
            borderRadius: '8px',
            background: '#1e293b',
            border: '1px solid rgba(255, 255, 255, 0.07)',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>
            1. Camera Mode
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
            <button
              type="button"
              onClick={() => setViewMode('overview')}
              style={{
                padding: '7px',
                borderRadius: '6px',
                border:
                  viewMode === 'overview'
                    ? '1px solid #38bdf8'
                    : '1px solid #334155',
                background: viewMode === 'overview' ? '#0369a1' : '#0f172a',
                color: '#f8fafc',
                fontSize: '0.76rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Room Overview
            </button>
            <button
              type="button"
              onClick={() => setViewMode('attendee_pov')}
              style={{
                padding: '7px',
                borderRadius: '6px',
                border:
                  viewMode === 'attendee_pov'
                    ? '1px solid #38bdf8'
                    : '1px solid #334155',
                background: viewMode === 'attendee_pov' ? '#0369a1' : '#0f172a',
                color: '#f8fafc',
                fontSize: '0.76rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Attendee 90° POV
            </button>
          </div>

          <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>
            2. Layout State (Before vs. After Patch)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
            <button
              type="button"
              onClick={() => setScenePhase('baseline')}
              style={{
                padding: '7px',
                borderRadius: '6px',
                border:
                  scenePhase === 'baseline'
                    ? '1px solid #f59e0b'
                    : '1px solid #334155',
                background: scenePhase === 'baseline' ? '#78350f' : '#0f172a',
                color: '#fef3c7',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Baseline (Before)
            </button>
            <button
              type="button"
              onClick={() => {
                setScenePhase('patched');
                setHighlightMovedProps(true);
              }}
              style={{
                padding: '7px',
                borderRadius: '6px',
                border:
                  scenePhase === 'patched'
                    ? '1px solid #34d399'
                    : '1px solid #334155',
                background: scenePhase === 'patched' ? '#065f46' : '#0f172a',
                color: '#d1fae5',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Patched (After 3-Step Fix)
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.76rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showRoutes}
                onChange={(e) => setShowRoutes(e.target.checked)}
              />
              Show Access Routes &amp; Turning Circles
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showTargetGrid}
                onChange={(e) => setShowTargetGrid(e.target.checked)}
              />
              Show 15×9 Target Sample Grid (135 pts)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={highlightMovedProps}
                onChange={(e) => setHighlightMovedProps(e.target.checked)}
              />
              Highlight 3 Movable Props in Cyan
            </label>
          </div>
        </div>

        {/* Key Demo Attendees Quick-Select */}
        <div>
          <div style={{ fontSize: '0.82rem', fontWeight: 600, marginBottom: '6px' }}>
            Key Attendees to Inspect (Click to View)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {keyDemoAttendees.map((item) => {
              const member = activeSnapshot.roster.find(
                (r) => r.attendeeId === item.id,
              )!;
              const isSelected = selectedAttendeeId === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedAttendeeId(item.id);
                    setViewMode('attendee_pov');
                  }}
                  style={{
                    textAlign: 'left',
                    padding: '8px 10px',
                    borderRadius: '6px',
                    border: isSelected
                      ? '1px solid #38bdf8'
                      : '1px solid #1e293b',
                    background: isSelected ? '#1e293b' : '#090d16',
                    color: '#f8fafc',
                    cursor: 'pointer',
                  }}
                >
                  <div
                    style={{
                      fontSize: '0.7rem',
                      color: '#38bdf8',
                      fontWeight: 600,
                    }}
                  >
                    {item.tag}
                  </div>
                  <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                    {member.label}
                  </div>
                  <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                    {item.note}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      {/* CENTER PANEL: Live 3D VenueViewport */}
      <main
        style={{
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          height: '100%',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ flex: 1, minHeight: 0 }}>
          <VenueViewport
            snapshot={activeSnapshot}
            selectedAttendeeId={selectedAttendeeId}
            viewMode={viewMode}
            onSelectAttendee={(id) => {
              setSelectedAttendeeId(id);
            }}
            showRoutes={showRoutes}
            showTargetGrid={showTargetGrid}
            highlightedObjectIds={highlightedObjectIds}
            overviewPreset={overviewPreset}
          />
        </div>

        {/* Live Evaluator Scorecard Strip */}
        <div
          style={{
            padding: '10px 14px',
            borderRadius: '8px',
            background: '#0f172a',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: '0.78rem',
          }}
        >
          <div>
            <strong>Room Score ({scenePhase}):</strong>{' '}
            <span
              style={{
                color: activeEval.allModeledRequirementsMet
                  ? '#34d399'
                  : '#fbbf24',
                fontWeight: 600,
              }}
            >
              {24 - activeEval.comparison.attendeesWithUnmetRequirements} / 24
              Clear &amp; Usable
            </span>{' '}
            · Failed Checks: {activeEval.comparison.totalFailedRequirementChecks}
          </div>
          {selectedAttendeeEval && (
            <div>
              <strong>Selected ({selectedAttendeeId}):</strong> Sightline{' '}
              <code>
                {selectedAttendeeEval.visibleSamples}/
                {selectedAttendeeEval.totalSamples}
              </code>{' '}
              · Route: <code>{selectedAttendeeEval.routeStatus}</code> · Legroom:{' '}
              <code>{selectedAttendeeEval.legroomPass ? 'PASS' : 'FAIL'}</code> ·
              Turning:{' '}
              <code>
                {selectedAttendeeEval.turningSpacePass ? 'PASS' : 'FAIL'}
              </code>
            </div>
          )}
        </div>
      </main>

      {/* RIGHT PANEL: Patch Operations, Live Video Recorder & All 24 Seats */}
      <aside
        style={{
          padding: '18px',
          borderLeft: '1px solid rgba(255, 255, 255, 0.08)',
          background: '#0f172a',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
        }}
      >
        {/* Live Evidence Video Recorder */}
        <div
          style={{
            padding: '12px',
            borderRadius: '8px',
            background: '#1e293b',
            border: '1px solid rgba(56, 189, 248, 0.3)',
          }}
        >
          <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '4px' }}>
            Live Browser Video Capture (<code>captureEvidence</code>)
          </div>
          <div
            style={{
              fontSize: '0.74rem',
              color: '#94a3b8',
              marginBottom: '10px',
            }}
          >
            Records a 5-stop tour (<code>view_overview_room</code> + 4 profile POVs)
            of the active <strong>{scenePhase}</strong> layout on a dedicated 512×512
            canvas.
          </div>
          <button
            type="button"
            disabled={isRecording}
            onClick={handleRecordLiveVideo}
            style={{
              width: '100%',
              padding: '9px 12px',
              borderRadius: '6px',
              border: '1px solid #38bdf8',
              background: isRecording ? '#334155' : '#0284c7',
              color: '#ffffff',
              fontWeight: 600,
              fontSize: '0.8rem',
              cursor: isRecording ? 'wait' : 'pointer',
            }}
          >
            {isRecording
              ? 'Recording 5-Stop Tour Clip...'
              : `Record 5-Stop Evidence Video (${scenePhase})`}
          </button>

          {recordError && (
            <div
              style={{
                marginTop: '8px',
                color: '#fca5a5',
                fontSize: '0.75rem',
              }}
            >
              Error: {recordError}
            </div>
          )}

          {recordedPayload && recordedVideoUrl && (
            <div style={{ marginTop: '12px' }}>
              <video
                key={recordedVideoUrl}
                src={recordedVideoUrl}
                controls
                autoPlay
                loop
                muted
                style={{
                  width: '100%',
                  borderRadius: '6px',
                  border: '1px solid #334155',
                  background: '#000',
                }}
              />
              <div
                style={{
                  marginTop: '6px',
                  fontSize: '0.72rem',
                  color: '#cbd5e1',
                  lineHeight: 1.4,
                }}
              >
                <div>
                  <strong>Capture ID:</strong>{' '}
                  <code>{recordedPayload.manifest.captureId}</code>
                </div>
                <div>
                  <strong>MIME / Size:</strong>{' '}
                  <code>{recordedPayload.manifest.mimeType}</code> ·{' '}
                  <code>{recordedPayload.manifest.byteLength} bytes</code>
                </div>
                <div>
                  <strong>Keyframes ({recordedPayload.manifest.keyframes.length}):</strong>{' '}
                  {recordedPayload.manifest.keyframes
                    .map((k) => k.viewId)
                    .join(', ')}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 3-Step Reference Repair Patch Summary */}
        <div
          style={{
            padding: '12px',
            borderRadius: '8px',
            background: '#1e293b',
            border: '1px solid rgba(255, 255, 255, 0.07)',
          }}
        >
          <div style={{ fontSize: '0.82rem', fontWeight: 600, marginBottom: '6px' }}>
            Bounded 3-Step Repair Patch
          </div>
          {referencePatch.operations.map((op, i) => (
            <div
              key={op.targetId}
              style={{
                padding: '6px 8px',
                borderRadius: '5px',
                background: '#0f172a',
                marginBottom: '6px',
                fontSize: '0.73rem',
              }}
            >
              <div style={{ color: '#38bdf8', fontWeight: 600 }}>
                {i + 1}. <code>{op.targetId}</code> → Δ[
                {op.deltaPositionM.join(', ')}] m
              </div>
              <div style={{ color: '#94a3b8' }}>{op.reason}</div>
            </div>
          ))}
        </div>

        {/* GLB 3D Building Parser & Seat/Exit Auto-Labeler */}
        <div
          style={{
            padding: '12px',
            borderRadius: '8px',
            background: '#1e293b',
            border: '1px solid rgba(167, 139, 250, 0.35)',
          }}
        >
          <div style={{ fontSize: '0.82rem', fontWeight: 600, marginBottom: '4px', color: '#c4b5fd' }}>
            3D Building GLB Parser &amp; Auto-Labeler
          </div>
          <div style={{ fontSize: '0.73rem', color: '#94a3b8', marginBottom: '8px' }}>
            Upload any <code>.glb</code> 3D venue or parse <code>prepared-venue.glb</code> to auto-label seats, bays, exits, stage, and props.
          </div>
          <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
            <button
              type="button"
              onClick={() => {
                const { glbBytes } = generateVenueGlbBinary(baselineSnapshot);
                const report = parseAndLabelGlbVenue(glbBytes, {
                  fileName: 'prepared-venue.glb',
                });
                setGlbParseReport(report);
              }}
              style={{
                flex: 1,
                padding: '6px 8px',
                borderRadius: '5px',
                border: '1px solid #8b5cf6',
                background: '#4c1d95',
                color: '#f5f3ff',
                fontSize: '0.73rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Parse prepared-venue.glb
            </button>
            <label
              style={{
                flex: 1,
                padding: '6px 8px',
                borderRadius: '5px',
                border: '1px solid #475569',
                background: '#0f172a',
                color: '#e2e8f0',
                fontSize: '0.73rem',
                fontWeight: 600,
                textAlign: 'center',
                cursor: 'pointer',
              }}
            >
              Upload .glb File
              <input
                type="file"
                accept=".glb"
                style={{ display: 'none' }}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const buf = new Uint8Array(await file.arrayBuffer());
                  const report = parseAndLabelGlbVenue(buf, {
                    fileName: file.name,
                  });
                  setGlbParseReport(report);
                  setUseParsedGlbSnapshot(true);
                }}
              />
            </label>
          </div>

          {glbParseReport && (
            <div
              style={{
                padding: '8px',
                borderRadius: '5px',
                background: '#0f172a',
                fontSize: '0.72rem',
                color: '#cbd5e1',
                lineHeight: 1.45,
              }}
            >
              <div>
                <strong>File:</strong> <code>{glbParseReport.fileName}</code> (
                {glbParseReport.byteLength} B · {glbParseReport.totalNodes} nodes)
              </div>
              <div>
                <strong>Labeled Seats:</strong> {glbParseReport.counts.seats} ·{' '}
                <strong>Wheelchair Bays:</strong>{' '}
                {glbParseReport.counts.wheelchairBays}
              </div>
              <div>
                <strong>Stage / Screen:</strong>{' '}
                {glbParseReport.counts.stagesAndScreens} ·{' '}
                <strong>Pillars:</strong>{' '}
                {glbParseReport.counts.pillarsAndStructures} ·{' '}
                <strong>Props:</strong> {glbParseReport.counts.movableProps}
              </div>
              <div>
                <strong>Synthesized Routes:</strong>{' '}
                {glbParseReport.snapshot.routes.length} corridors
              </div>
            </div>
          )}
        </div>

        {/* Full 24-Attendee Roster */}
        <div>
          <div style={{ fontSize: '0.82rem', fontWeight: 600, marginBottom: '6px' }}>
            All 24 Frozen Attendees ({activeSnapshot.roster.length} places)
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              maxHeight: '260px',
              overflowY: 'auto',
            }}
          >
            {activeSnapshot.roster.map((member) => {
              const isSelected = member.attendeeId === selectedAttendeeId;
              return (
                <button
                  key={member.attendeeId}
                  type="button"
                  onClick={() => setSelectedAttendeeId(member.attendeeId)}
                  style={{
                    textAlign: 'left',
                    padding: '6px 8px',
                    borderRadius: '5px',
                    border: isSelected
                      ? '1px solid #38bdf8'
                      : '1px solid #1e293b',
                    background: isSelected ? '#1e293b' : '#090d16',
                    color: '#f1f5f9',
                    fontSize: '0.73rem',
                    cursor: 'pointer',
                  }}
                >
                  <strong>{member.label}</strong> ·{' '}
                  <code>{member.assignedPlaceId}</code>
                </button>
              );
            })}
          </div>
        </div>
      </aside>
    </div>
  );
}

if (typeof document !== 'undefined') {
  const rootEl = document.getElementById('part-a-demo-root');
  if (rootEl) {
    createRoot(rootEl).render(
      <React.StrictMode>
        <PartADemoApp />
      </React.StrictMode>,
    );
  }
}
