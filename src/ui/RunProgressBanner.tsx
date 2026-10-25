import React from 'react';
import {
  RUN_TIMING,
  type RunRecord,
  type RunState,
} from '../shared/index.js';

export interface RunProgressBannerProps {
  activeRun: RunRecord | null;
  isCapturingClip: boolean;
  captureStatusText: string | null;
  errorText: string | null;
  onStartLiveRun: () => void;
  onPreviewLocalRepair: () => void;
  onResetToBaseline: () => void;
}

const ORDERED_STATES: Array<{ state: RunState; label: string }> = [
  { state: 'preparing', label: '1. Preparing' },
  { state: 'capturing_baseline', label: '2. Capturing Baseline' },
  { state: 'inspecting_baseline', label: '3. Argon Baseline Critique' },
  { state: 'proposing', label: '4. Proposing Patch' },
  { state: 'verifying', label: '5. Independent Verification' },
  { state: 'rendering_revision', label: '6. Capturing Revision' },
  { state: 'inspecting_revision', label: '7. Argon Final Inspection' },
  { state: 'finished', label: '8. Finished' },
];

export function RunProgressBanner({
  activeRun,
  isCapturingClip,
  captureStatusText,
  errorText,
  onStartLiveRun,
  onPreviewLocalRepair,
  onResetToBaseline,
}: RunProgressBannerProps): React.ReactElement {
  const isRunning = activeRun !== null && activeRun.state !== 'finished';
  const currentIdx = activeRun
    ? ORDERED_STATES.findIndex((s) => s.state === activeRun.state)
    : -1;

  const remainingSec = activeRun
    ? Math.max(
        0,
        Math.ceil((RUN_TIMING.liveDeadlineMs - activeRun.elapsedMs) / 1000),
      )
    : Math.ceil(RUN_TIMING.liveDeadlineMs / 1000);

  return (
    <header
      style={{
        gridColumn: '1 / -1',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '12px 18px',
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--bg-surface)',
      }}
    >
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h1 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700 }}>
                VenuePilot
              </h1>
              <span className="vp-badge vp-badge-neutral">
                Argon Visual Audit &amp; Bounded Repair
              </span>
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

        {/* Action Buttons & Live Timer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {activeRun && (
            <div
              className="vp-card-inner"
              style={{
                padding: '6px 10px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '0.76rem',
              }}
            >
              {isRunning && <span className="vp-live-dot" />}
              <span className="mono">
                Elapsed: {(activeRun.elapsedMs / 1000).toFixed(1)}s
              </span>
              <span style={{ color: 'var(--text-muted)' }}>|</span>
              <span className="mono" style={{ color: remainingSec < 20 ? '#f87171' : 'var(--text-secondary)' }}>
                Budget: {remainingSec}s / 110s
              </span>
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
            title="Test Before/After comparison using the deterministic devFixture sign repair while Stream C backend is a stub"
          >
            Preview Repair (Dev Fixture)
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
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(8, minmax(0, 1fr))',
          gap: '6px',
        }}
      >
        {ORDERED_STATES.map((step, idx) => {
          const isCurrent = activeRun?.state === step.state;
          const isCompleted = currentIdx > idx || activeRun?.state === 'finished';

          return (
            <div
              key={step.state}
              style={{
                padding: '5px 8px',
                borderRadius: 'var(--radius-inner)',
                fontSize: '0.71rem',
                fontWeight: isCurrent ? 700 : 500,
                textAlign: 'center',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                border: isCurrent
                  ? '1px solid var(--border-accent)'
                  : '1px solid var(--border-subtle)',
                background: isCurrent
                  ? 'var(--bg-surface-active)'
                  : isCompleted
                    ? 'rgba(16, 185, 129, 0.12)'
                    : 'var(--bg-surface-elevated)',
                color: isCurrent
                  ? '#93c5fd'
                  : isCompleted
                    ? '#34d399'
                    : 'var(--text-muted)',
              }}
            >
              {step.label}
            </div>
          );
        })}
      </div>

      {/* Status / Error Callouts */}
      {(captureStatusText || errorText) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            fontSize: '0.76rem',
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
          {activeRun?.runId && (
            <span className="mono" style={{ fontSize: '0.72rem' }}>
              runId: {activeRun.runId}
            </span>
          )}
        </div>
      )}
    </header>
  );
}
