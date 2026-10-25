import React from 'react';
import {
  RUN_TIMING,
  type CaptureKeyframe,
  type RunRecord,
  type RunState,
} from '../shared/index.js';

export interface ActiveCaptureProgress {
  phase: 'baseline' | 'revision';
  captureId: string;
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
  venuePreset?: 'prepared_24' | 'bunched_emergency_24' | 'dev_4';
  unmetCount?: number;
  totalSeats?: number;
  onSelectVenuePreset?: (
    preset: 'prepared_24' | 'bunched_emergency_24' | 'dev_4',
  ) => void;
  onStartLiveRun: () => void;
  onPreviewLocalRepair: () => void;
  onResetToBaseline: () => void;
  activeCaptureProgress?: ActiveCaptureProgress | null;
  selectedAttendeeId?: string;
  activeViewMode?: 'overview' | 'attendee_pov';
}

const ORDERED_STATES: Array<{ state: RunState; label: string }> = [
  { state: 'preparing', label: 'Preparing Scene' },
  { state: 'capturing_baseline', label: 'Recording Baseline Tour' },
  { state: 'inspecting_baseline', label: 'Argon Visual Critique' },
  { state: 'proposing', label: 'Synthesizing Spatial Patch' },
  { state: 'verifying', label: 'Verifying Geometry & Rays' },
  { state: 'rendering_revision', label: 'Recording Repaired Tour' },
  { state: 'inspecting_revision', label: 'Final Optical Verification' },
  { state: 'finished', label: 'Verification Complete' },
];

export function RunProgressBanner({
  activeRun,
  isCapturingClip,
  captureStatusText,
  errorText,
  venuePreset = 'prepared_24',
  unmetCount = 0,
  totalSeats = 24,
  onSelectVenuePreset,
  onStartLiveRun,
  onPreviewLocalRepair,
  onResetToBaseline,
  activeCaptureProgress,
}: RunProgressBannerProps): React.ReactElement {
  const isRunning = activeRun !== null && activeRun.state !== 'finished';
  const currentIdx = activeRun
    ? ORDERED_STATES.findIndex((s) => s.state === activeRun.state)
    : -1;
  const currentStep = currentIdx >= 0 ? ORDERED_STATES[currentIdx] : undefined;

  const progressFraction =
    activeRun?.state === 'finished'
      ? 1
      : currentIdx >= 0
        ? (currentIdx + 1) / ORDERED_STATES.length
        : 0;

  const remainingSec = activeRun
    ? Math.max(
        0,
        Math.ceil((RUN_TIMING.liveDeadlineMs - activeRun.elapsedMs) / 1000),
      )
    : Math.ceil(RUN_TIMING.liveDeadlineMs / 1000);

  const activePovLabel = activeCaptureProgress?.activeKeyframe?.label;

  return (
    <header className="vp-header">
      {/* Left: Brand & Venue Switcher */}
      <div className="vp-brand">
        <div className="vp-brand-mark" aria-hidden="true">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </div>
        <h1 className="vp-brand-title">VenuePilot</h1>

        <div className="vp-divider-v" />

        {onSelectVenuePreset && (
          <div className="vp-segmented" role="group" aria-label="Venue preset">
            <button
              type="button"
              className={`vp-segment-btn vp-focusable ${
                venuePreset === 'prepared_24' ? 'vp-segment-btn-active' : ''
              }`}
              disabled={isRunning || isCapturingClip}
              onClick={() => onSelectVenuePreset('prepared_24')}
            >
              Village Hall · 24
            </button>
            <button
              type="button"
              className={`vp-segment-btn vp-focusable ${
                venuePreset === 'bunched_emergency_24'
                  ? 'vp-segment-btn-active'
                  : ''
              }`}
              disabled={isRunning || isCapturingClip}
              onClick={() => onSelectVenuePreset('bunched_emergency_24')}
            >
              Bunched Evac · 24
            </button>
            <button
              type="button"
              className={`vp-segment-btn vp-focusable ${
                venuePreset === 'dev_4' ? 'vp-segment-btn-active' : ''
              }`}
              disabled={isRunning || isCapturingClip}
              onClick={() => onSelectVenuePreset('dev_4')}
            >
              Compact Hall · 4
            </button>
          </div>
        )}
      </div>

      {/* Center: Live Telemetry / Status Pill */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          minWidth: 0,
        }}
      >
        {errorText ? (
          <div
            className="vp-badge vp-badge-fail"
            style={{
              padding: '4px 12px',
              fontSize: '0.75rem',
              maxWidth: '460px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={errorText}
          >
            <span className="vp-status-dot vp-status-dot-fail" />
            <span>{errorText}</span>
          </div>
        ) : isRunning || isCapturingClip ? (
          <div
            className="vp-badge vp-badge-neutral"
            style={{
              padding: '4px 12px',
              fontSize: '0.75rem',
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-accent)',
              color: 'var(--text-primary)',
            }}
          >
            <span className="vp-live-dot" />
            <span>
              Step {Math.max(1, currentIdx + 1)}/{ORDERED_STATES.length} ·{' '}
              {currentStep?.label ?? 'Inspecting'}
              {activePovLabel ? ` (${activePovLabel})` : ''}
            </span>
            {activeRun && (
              <span
                className="mono"
                style={{
                  color:
                    remainingSec < 20
                      ? 'var(--status-fail-text)'
                      : 'var(--text-secondary)',
                  marginLeft: '4px',
                }}
              >
                {(activeRun.elapsedMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>
        ) : activeRun?.state === 'finished' ? (
          <div
            className={`vp-badge ${
              activeRun.outcome === 'improved'
                ? 'vp-badge-pass'
                : 'vp-badge-neutral'
            }`}
            style={{ padding: '4px 12px', fontSize: '0.75rem' }}
          >
            <span
              className={`vp-status-dot ${
                activeRun.outcome === 'improved'
                  ? 'vp-status-dot-pass'
                  : 'vp-status-dot-warn'
              }`}
            />
            <span>
              {activeRun.runId === 'preview_dev_fixture'
                ? 'Reference Repair Applied · All Seats Verified Clear'
                : `Audit Complete · ${
                    activeRun.outcome === 'improved'
                      ? 'Layout Improved'
                      : activeRun.outcome === 'no_improvement'
                        ? 'Baseline Retained'
                        : activeRun.outcome.replace(/_/g, ' ')
                  }`}
            </span>
          </div>
        ) : (
          <div
            className={`vp-badge ${
              unmetCount === 0 ? 'vp-badge-pass' : 'vp-badge-warn'
            }`}
            style={{ padding: '4px 12px', fontSize: '0.75rem' }}
          >
            <span
              className={`vp-status-dot ${
                unmetCount === 0 ? 'vp-status-dot-pass' : 'vp-status-dot-warn'
              }`}
            />
            <span>
              {unmetCount === 0
                ? `All ${totalSeats} seats clear & accessible`
                : `${unmetCount} of ${totalSeats} seats have sightline or access issues`}
            </span>
          </div>
        )}
      </div>

      {/* Right: Primary & Secondary Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {activeRun && (
          <button
            type="button"
            className="vp-btn vp-btn-ghost"
            onClick={onResetToBaseline}
          >
            Reset Baseline
          </button>
        )}

        <button
          type="button"
          className="vp-btn"
          disabled={isRunning || isCapturingClip}
          onClick={onPreviewLocalRepair}
          title="Instantly apply verified layout repair for live comparison"
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
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          <span>Instant Repair</span>
        </button>

        <button
          type="button"
          className="vp-btn vp-btn-primary"
          disabled={isRunning || isCapturingClip}
          onClick={onStartLiveRun}
          title={
            captureStatusText ?? 'Run live Argon visual audit & spatial repair'
          }
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
            <path d="M12 3v3m0 12v3M3 12h3m12 0h3m-2.6-6.4-2.1 2.1M8.7 15.3l-2.1 2.1m0-12.8 2.1 2.1m6.6 6.6 2.1 2.1" />
          </svg>
          <span>{isRunning ? 'Auditing Venue…' : 'Run Live Audit'}</span>
        </button>
      </div>

      {/* Sleek Bottom Edge Progress Track during Active Run */}
      {(isRunning || isCapturingClip) && (
        <div className="vp-header-progress-track" aria-hidden="true">
          <div
            className="vp-header-progress-fill"
            style={{
              width: '100%',
              transform: `scaleX(${Math.max(0.08, progressFraction)})`,
            }}
          />
        </div>
      )}
    </header>
  );
}
