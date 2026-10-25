import React from 'react';
import type {
  CaptureKeyframe,
  RunRecord,
  RunState,
} from '../shared/index.js';

/**
 * Authoritative live capture progress handoff contract (Person 1 -> Person 2).
 * Driven by the same clock/keyframe scheduler as the recording pipeline.
 */
export interface ActiveCaptureProgress {
  phase: 'baseline' | 'revision';
  captureId: string;
  /** 1-based index of the currently active keyframe in `keyframes` */
  currentViewIndex?: number;
  totalViews?: number;
  activeKeyframe?: CaptureKeyframe;
  elapsedTourSec?: number;
  totalTourSec?: number;
}

export interface RunProgressBannerProps {
  activeRun: RunRecord | null;
  isCapturingClip: boolean;
  captureStatusText: string | null;
  errorText: string | null;
  venuePreset?: 'prepared_24' | 'dev_4';
  onSelectVenuePreset?: (preset: 'prepared_24' | 'dev_4') => void;
  onStartLiveRun: () => void;
  onPreviewLocalRepair: () => void;
  onResetToBaseline: () => void;
  /** Optional Person 1 handoff props for authoritative live capture POV display */
  activeCaptureProgress?: ActiveCaptureProgress | null;
  selectedAttendeeId?: string;
  activeViewMode?: 'overview' | 'attendee_pov';
}

const ORDERED_STATES: Array<{ state: RunState; shortLabel: string }> = [
  { state: 'preparing', shortLabel: '1. Preparing' },
  { state: 'capturing_baseline', shortLabel: '2. Capturing Baseline' },
  { state: 'inspecting_baseline', shortLabel: '3. Reviewing Baseline' },
  { state: 'proposing', shortLabel: '4. Proposing Change' },
  { state: 'verifying', shortLabel: '5. Checking Change' },
  { state: 'rendering_revision', shortLabel: '6. Capturing Revision' },
  { state: 'inspecting_revision', shortLabel: '7. Inspecting Revision' },
  { state: 'finished', shortLabel: '8. Complete' },
];

function getReadableStageSummary(
  activeRun: RunRecord | null,
  isCapturingClip: boolean,
  captureStatusText: string | null,
): {
  headline: string;
  detail: string;
  tone: 'neutral' | 'active' | 'success' | 'warn' | 'danger';
} {
  if (!activeRun) {
    return {
      headline: 'Ready to review venue',
      detail:
        'Inspect audience sightlines and access clearances, or start a live Argon review.',
      tone: 'neutral',
    };
  }

  const isUploading =
    typeof captureStatusText === 'string' &&
    /^uploading\b/i.test(captureStatusText.trim());

  switch (activeRun.state) {
    case 'preparing':
      return {
        headline: 'Preparing venue evaluation',
        detail:
          'Freezing baseline snapshot and scheduling camera inspection viewpoints.',
        tone: 'active',
      };
    case 'capturing_baseline':
      if (isUploading) {
        return {
          headline: 'Uploading evidence',
          detail:
            'Sending recorded baseline viewpoint video and manifest to the controller.',
          tone: 'active',
        };
      }
      return {
        headline: 'Capturing baseline viewpoints',
        detail: isCapturingClip
          ? 'Recording clean 512×512 audience POV and room overview frames.'
          : 'Waiting for baseline viewpoint recording.',
        tone: 'active',
      };
    case 'inspecting_baseline':
      return {
        headline: 'Argon reviewing the venue',
        detail:
          'Gemini 4 Argon is inspecting the rendered baseline video without evaluator answers.',
        tone: 'active',
      };
    case 'proposing':
      return {
        headline: 'Argon reviewing the venue & proposing adjustment',
        detail:
          'Generating timestamped visual observations and a bounded layout patch.',
        tone: 'active',
      };
    case 'verifying':
      return {
        headline: 'Checking the proposed change',
        detail:
          'Running independent geometric validation, clearance checks, and non-regression gates.',
        tone: 'active',
      };
    case 'rendering_revision':
      if (isUploading) {
        return {
          headline: 'Uploading evidence',
          detail:
            'Sending recorded revision viewpoint video and manifest for final inspection.',
          tone: 'active',
        };
      }
      return {
        headline: 'Capturing revised viewpoints',
        detail: isCapturingClip
          ? 'Re-recording the same viewpoint sequence on the verified revised layout.'
          : 'Preparing revised layout viewpoint capture.',
        tone: 'active',
      };
    case 'inspecting_revision':
      return {
        headline: 'Argon inspecting the revision',
        detail:
          'Verifying visual sightlines and summarizing any remaining concerns on the revised clip.',
        tone: 'active',
      };
    case 'finished': {
      const isFixturePreview = activeRun.runId === 'preview_dev_fixture';
      const prefix = isFixturePreview ? 'Fixture preview complete' : 'Run complete';

      if (activeRun.outcome === 'improved') {
        return {
          headline: `${prefix} — Verified layout improvement accepted`,
          detail:
            activeRun.terminalReason ??
            'The proposed layout change passed all non-regression checks and improved venue metrics.',
          tone: 'success',
        };
      }
      if (activeRun.outcome === 'partial_incomplete') {
        return {
          headline: 'Run ended incomplete — Verified layout improvement preserved',
          detail:
            activeRun.terminalReason ??
            'The layout patch passed independent verification, but final visual inspection did not complete.',
          tone: 'warn',
        };
      }
      if (activeRun.outcome === 'no_improvement') {
        return {
          headline: `${prefix} — No improvement accepted (baseline retained)`,
          detail:
            activeRun.terminalReason ??
            'The proposed change did not pass verification or did not improve the venue layout.',
          tone: 'warn',
        };
      }
      if (activeRun.outcome === 'timeout') {
        return {
          headline: 'Run timed out — Baseline layout retained',
          detail:
            activeRun.terminalReason ??
            'The live run reached the time budget before a verified improvement was completed.',
          tone: 'danger',
        };
      }
      if (activeRun.outcome === 'failure') {
        return {
          headline: 'Run failed — Error during review',
          detail:
            activeRun.terminalReason ??
            'An error occurred during evidence review or model inference.',
          tone: 'danger',
        };
      }
      return {
        headline: prefix,
        detail: activeRun.terminalReason ?? 'Review finished.',
        tone: 'neutral',
      };
    }
  }
}

function getMeasuredElapsedSec(activeRun: RunRecord | null): number | null {
  if (!activeRun) return null;
  if (Number.isFinite(activeRun.elapsedMs) && activeRun.elapsedMs > 0) {
    return activeRun.elapsedMs / 1000;
  }
  const createdMs = Date.parse(activeRun.createdAtIso);
  const updatedMs = Date.parse(activeRun.updatedAtIso);
  if (
    Number.isFinite(createdMs) &&
    Number.isFinite(updatedMs) &&
    updatedMs > createdMs
  ) {
    return (updatedMs - createdMs) / 1000;
  }
  return null;
}

export function RunProgressBanner({
  activeRun,
  isCapturingClip,
  captureStatusText,
  errorText,
  venuePreset = 'prepared_24',
  onSelectVenuePreset,
  onStartLiveRun,
  onPreviewLocalRepair,
  onResetToBaseline,
  activeCaptureProgress,
  selectedAttendeeId,
  activeViewMode,
}: RunProgressBannerProps): React.ReactElement {
  const isRunning = activeRun !== null && activeRun.state !== 'finished';
  const isFixturePreview = activeRun?.runId === 'preview_dev_fixture';
  const currentIdx = activeRun
    ? ORDERED_STATES.findIndex((s) => s.state === activeRun.state)
    : -1;

  const measuredElapsedSec = getMeasuredElapsedSec(activeRun);
  const stageSummary = getReadableStageSummary(
    activeRun,
    isCapturingClip,
    captureStatusText,
  );

  // Determine authoritative capture tour metadata during capturing_baseline / rendering_revision
  const isCapturePhase =
    activeRun?.state === 'capturing_baseline' ||
    activeRun?.state === 'rendering_revision';
  const pendingCapture = activeRun?.pendingCapture;
  const authoritativeKeyframes: CaptureKeyframe[] =
    pendingCapture?.keyframes ?? [];

  // Resolve active keyframe from explicit activeCaptureProgress or authoritative viewport selection
  let resolvedActiveKeyframe: CaptureKeyframe | undefined =
    activeCaptureProgress?.activeKeyframe;
  let resolvedViewIndex: number | undefined =
    activeCaptureProgress?.currentViewIndex;
  const resolvedTotalViews: number | undefined =
    activeCaptureProgress?.totalViews ??
    (authoritativeKeyframes.length > 0
      ? authoritativeKeyframes.length
      : undefined);

  if (!resolvedActiveKeyframe && isCapturePhase && authoritativeKeyframes.length > 0) {
    if (activeViewMode === 'overview') {
      const idx = authoritativeKeyframes.findIndex((k) => k.kind === 'overview');
      if (idx >= 0) {
        resolvedActiveKeyframe = authoritativeKeyframes[idx];
        resolvedViewIndex = idx + 1;
      }
    } else if (selectedAttendeeId) {
      const idx = authoritativeKeyframes.findIndex(
        (k) => k.kind === 'attendee_pov' && k.attendeeId === selectedAttendeeId,
      );
      if (idx >= 0) {
        resolvedActiveKeyframe = authoritativeKeyframes[idx];
        resolvedViewIndex = idx + 1;
      }
    }
  }

  const latestAttempt =
    activeRun && activeRun.attempts.length > 0
      ? activeRun.attempts[activeRun.attempts.length - 1]
      : undefined;

  return (
    <header className="vp-progress-banner">
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
        }}
      >
        {/* Brand & Subtitle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '8px',
              background: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: '0.95rem',
              color: '#fff',
            }}
          >
            VP
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <h1 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700 }}>
                VenuePilot
              </h1>
              <span className="vp-badge vp-badge-neutral">
                Argon Visual Audit &amp; Bounded Repair
              </span>
              {isFixturePreview && (
                <span className="vp-badge vp-badge-warn">
                  Local Fixture Preview
                </span>
              )}
            </div>
            <p
              style={{
                margin: '2px 0 0 0',
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
              }}
            >
              Existing Venue Accessibility, Sightline (15×9 Grid) &amp; Comfort
              Review · Not an ADA Certification
            </p>
          </div>
        </div>

        {/* Action Buttons & Measured Elapsed Time */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
          }}
        >
          {onSelectVenuePreset && (
            <div
              role="group"
              aria-label="Venue preset selector"
              style={{
                display: 'inline-flex',
                gap: '4px',
                padding: '3px',
                borderRadius: 'var(--radius-inner)',
                background: 'var(--bg-surface-elevated)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <button
                type="button"
                className={`vp-btn ${venuePreset === 'prepared_24' ? 'vp-btn-primary' : ''}`}
                style={{ padding: '4px 9px', fontSize: '0.73rem' }}
                disabled={isRunning || isCapturingClip}
                onClick={() => onSelectVenuePreset('prepared_24')}
              >
                24-Place Village Hall
              </button>
              <button
                type="button"
                className={`vp-btn ${venuePreset === 'dev_4' ? 'vp-btn-primary' : ''}`}
                style={{ padding: '4px 9px', fontSize: '0.73rem' }}
                disabled={isRunning || isCapturingClip}
                onClick={() => onSelectVenuePreset('dev_4')}
              >
                4-Place Compact Hall
              </button>
            </div>
          )}

          {activeRun && (isRunning || measuredElapsedSec !== null) && (
            <div
              className="vp-card-inner"
              style={{
                padding: '6px 10px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '0.75rem',
              }}
            >
              {isRunning && <span className="vp-live-dot" aria-hidden="true" />}
              {measuredElapsedSec !== null ? (
                <span className="mono">
                  Elapsed: {measuredElapsedSec.toFixed(1)}s
                </span>
              ) : (
                <span style={{ color: 'var(--text-secondary)' }}>
                  {isFixturePreview ? 'Instant fixture preview' : 'Run active'}
                </span>
              )}
            </div>
          )}

          <button
            type="button"
            className="vp-btn vp-btn-primary"
            disabled={isRunning || isCapturingClip}
            onClick={onStartLiveRun}
          >
            {isRunning ? 'Live Run in Progress…' : 'Review and Improve (Live API)'}
          </button>

          <button
            type="button"
            className="vp-btn"
            disabled={isRunning || isCapturingClip}
            onClick={onPreviewLocalRepair}
            title="Inspect Before/After comparison using the deterministic local reference repair fixture"
          >
            Preview Repair (Fixture)
          </button>

          {activeRun && (
            <button
              type="button"
              className="vp-btn"
              onClick={onResetToBaseline}
            >
              Reset to Baseline
            </button>
          )}
        </div>
      </div>

      {/* 8-State Pipeline Bar */}
      <div className="vp-progress-stage-grid" role="list" aria-label="Review pipeline stages">
        {ORDERED_STATES.map((step, idx) => {
          const isCurrent = activeRun?.state === step.state;
          const isFinishedFailed =
            activeRun?.state === 'finished' &&
            step.state === 'finished' &&
            (activeRun.outcome === 'failure' || activeRun.outcome === 'timeout');
          const isCompleted =
            !isCurrent &&
            !isFinishedFailed &&
            (currentIdx > idx ||
              (activeRun?.state === 'finished' &&
                step.state === 'finished' &&
                activeRun.outcome === 'improved'));

          let stepClass = 'vp-progress-stage-step';
          if (isFinishedFailed) {
            stepClass += ' vp-progress-stage-step-error';
          } else if (isCurrent) {
            stepClass += ' vp-progress-stage-step-current';
          } else if (isCompleted) {
            stepClass += ' vp-progress-stage-step-done';
          }

          return (
            <div
              key={step.state}
              role="listitem"
              aria-current={isCurrent ? 'step' : undefined}
              className={stepClass}
            >
              {step.shortLabel}
            </div>
          );
        })}
      </div>

      {/* Readable Current-Stage Status & Verification Milestones */}
      {activeRun && (
        <div
          className="vp-progress-status-bar"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span
                className={`vp-badge ${
                  stageSummary.tone === 'success'
                    ? 'vp-badge-pass'
                    : stageSummary.tone === 'danger'
                      ? 'vp-badge-fail'
                      : stageSummary.tone === 'warn'
                        ? 'vp-badge-warn'
                        : 'vp-badge-neutral'
                }`}
              >
                {stageSummary.headline}
              </span>

              {activeRun.runId && (
                <span className="mono" style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  {activeRun.runId}
                </span>
              )}
            </div>
            <span style={{ fontSize: '0.73rem', color: 'var(--text-secondary)' }}>
              {stageSummary.detail}
            </span>
          </div>

          {/* Explicit Milestone Status Pills (Proposal -> Validation -> Acceptance -> Final Inspection) */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
            <span
              className={`vp-badge ${
                latestAttempt ? 'vp-badge-pass' : 'vp-badge-neutral'
              }`}
              title="Whether Argon has returned a structured layout proposal"
            >
              Proposal: {latestAttempt ? `Received (${latestAttempt.patch.operations.length} op)` : 'Pending'}
            </span>

            <span
              className={`vp-badge ${
                !latestAttempt
                  ? 'vp-badge-neutral'
                  : latestAttempt.comparisonOutcome === 'rejected_structural'
                    ? 'vp-badge-fail'
                    : 'vp-badge-pass'
              }`}
              title="Whether the proposed patch passed structural and step/displacement guardrails"
            >
              Validation:{' '}
              {!latestAttempt
                ? 'Pending'
                : latestAttempt.comparisonOutcome === 'rejected_structural'
                  ? 'Failed Guardrails'
                  : 'Valid Structure'}
            </span>

            <span
              className={`vp-badge ${
                !latestAttempt
                  ? 'vp-badge-neutral'
                  : latestAttempt.comparisonOutcome === 'accepted'
                    ? 'vp-badge-pass'
                    : 'vp-badge-fail'
              }`}
              title="Whether the candidate passed non-regression gates and improved lexicographic metrics"
            >
              Outcome:{' '}
              {!latestAttempt
                ? 'Pending'
                : latestAttempt.comparisonOutcome === 'accepted'
                  ? 'Change Accepted'
                  : `Rejected (${latestAttempt.comparisonOutcome})`}
            </span>

            <span
              className={`vp-badge ${
                activeRun.finalInspection
                  ? 'vp-badge-pass'
                  : activeRun.state === 'finished' &&
                      activeRun.outcome !== 'improved'
                    ? 'vp-badge-warn'
                    : 'vp-badge-neutral'
              }`}
              title="Whether Argon completed final visual reinspection on the revised clip"
            >
              Final Inspection:{' '}
              {activeRun.finalInspection
                ? 'Complete'
                : activeRun.state === 'finished'
                  ? 'Not Reached'
                  : 'Pending'}
            </span>
          </div>
        </div>
      )}

      {/* Active Capture Tour & POV Telemetry during capturing_baseline / rendering_revision */}
      {isCapturePhase && pendingCapture && (
        <div className="vp-progress-status-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span className="vp-badge vp-badge-warn">
              {pendingCapture.phase === 'baseline'
                ? 'Baseline Tour Capture'
                : 'Revision Tour Capture'}
            </span>
            {resolvedViewIndex !== undefined &&
              resolvedTotalViews !== undefined && (
                <span className="mono" style={{ fontWeight: 700, color: '#93c5fd' }}>
                  View {resolvedViewIndex} of {resolvedTotalViews}
                </span>
              )}
            {resolvedActiveKeyframe ? (
              <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                Active POV: {resolvedActiveKeyframe.label} (
                <span className="mono">{resolvedActiveKeyframe.viewId}</span>)
              </span>
            ) : (
              <span style={{ color: 'var(--text-secondary)' }}>
                Recording {authoritativeKeyframes.length} scheduled viewpoints (
                {pendingCapture.totalDurationSec.toFixed(1)}s tour)
              </span>
            )}
          </div>

          {authoritativeKeyframes.length > 0 && (
            <div className="vp-tour-pov-strip" aria-label="Scheduled capture viewpoints">
              {authoritativeKeyframes.map((kf, idx) => {
                const isActiveChip =
                  resolvedActiveKeyframe?.viewId === kf.viewId;
                return (
                  <span
                    key={kf.viewId}
                    className={`vp-tour-pov-chip ${
                      isActiveChip ? 'vp-tour-pov-chip-active' : ''
                    }`}
                  >
                    <span className="mono">{idx + 1}/{authoritativeKeyframes.length}</span>
                    <span>
                      {kf.kind === 'overview'
                        ? 'Overview'
                        : kf.attendeeId ?? kf.viewId}
                    </span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Capture / Upload / Error Callouts */}
      {(captureStatusText || errorText) && (
        <div
          role={errorText ? 'alert' : 'status'}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            fontSize: '0.75rem',
            padding: '6px 10px',
            borderRadius: 'var(--radius-inner)',
            background: errorText
              ? 'var(--color-danger-bg)'
              : 'rgba(59, 130, 246, 0.12)',
            border: errorText
              ? '1px solid rgba(239, 68, 68, 0.3)'
              : '1px solid rgba(59, 130, 246, 0.3)',
            color: errorText ? '#fca5a5' : '#93c5fd',
          }}
        >
          <span>{errorText ?? captureStatusText}</span>
          {activeRun?.providerModel && (
            <span className="mono" style={{ fontSize: '0.7rem' }}>
              model: {activeRun.providerModel}
            </span>
          )}
        </div>
      )}
    </header>
  );
}
