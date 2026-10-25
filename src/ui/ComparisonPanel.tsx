import React from 'react';
import type {
  Evaluation,
  EvidenceFinding,
  ProfileId,
  RunRecord,
  SceneSnapshot,
} from '../shared/index.js';

export interface ComparisonPanelProps {
  baselineSnapshot: SceneSnapshot;
  baselineEvaluation: Evaluation;
  activeRun: RunRecord | null;
  viewingStage: 'baseline' | 'best';
  selectedAttendeeId: string;
  onToggleViewingStage: (stage: 'baseline' | 'best') => void;
  onJumpToFinding: (finding: EvidenceFinding) => void;
}

const PROFILE_ORDER: ProfileId[] = [
  'reference_adult',
  'shorter_seated',
  'wheelchair_user',
  'extra_legroom',
];

export function ComparisonPanel({
  baselineSnapshot,
  baselineEvaluation,
  activeRun,
  viewingStage,
  selectedAttendeeId,
  onToggleViewingStage,
  onJumpToFinding,
}: ComparisonPanelProps): React.ReactElement {
  const hasRevision =
    activeRun !== null &&
    activeRun.bestSnapshot.sceneHash !== activeRun.baselineSnapshot.sceneHash;

  const baseEval = activeRun?.baselineEvaluation ?? baselineEvaluation;
  const bestEval = activeRun?.bestEvaluation ?? baselineEvaluation;
  const displayedEval = viewingStage === 'best' ? bestEval : baseEval;

  const selectedBaselineAtt = baseEval.attendees[selectedAttendeeId];
  const selectedBestAtt = bestEval.attendees[selectedAttendeeId];

  const latestAttempt =
    activeRun && activeRun.attempts.length > 0
      ? activeRun.attempts[activeRun.attempts.length - 1]
      : undefined;

  return (
    <aside
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        padding: '16px',
        borderLeft: '1px solid var(--border-subtle)',
        background: 'var(--bg-surface)',
        overflowY: 'auto',
      }}
    >
      {/* Before / After Layout Switcher */}
      <div className="vp-card-inner">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '8px',
          }}
        >
          <span
            style={{
              fontSize: '0.74rem',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: 'var(--text-secondary)',
            }}
          >
            Layout Comparison (PRD §6, §9)
          </span>
          {activeRun && (
            <span
              className={`vp-badge ${
                activeRun.outcome === 'improved'
                  ? 'vp-badge-pass'
                  : activeRun.outcome === 'in_progress'
                    ? 'vp-badge-warn'
                    : 'vp-badge-neutral'
              }`}
            >
              {activeRun.outcome}
            </span>
          )}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '6px',
          }}
        >
          <button
            type="button"
            className={`vp-btn ${viewingStage === 'baseline' ? 'vp-btn-primary' : ''}`}
            onClick={() => onToggleViewingStage('baseline')}
          >
            Before (Baseline)
          </button>
          <button
            type="button"
            className={`vp-btn ${viewingStage === 'best' ? 'vp-btn-primary' : ''}`}
            disabled={!activeRun}
            onClick={() => onToggleViewingStage('best')}
          >
            After (Best Verified)
          </button>
        </div>

        {/* Overall Requirement Headline Banner */}
        <div
          style={{
            marginTop: '10px',
            padding: '8px 10px',
            borderRadius: 'var(--radius-inner)',
            background: displayedEval.allModeledRequirementsMet
              ? 'var(--color-success-bg)'
              : 'var(--color-warning-bg)',
            border: displayedEval.allModeledRequirementsMet
              ? '1px solid rgba(16, 185, 129, 0.3)'
              : '1px solid rgba(245, 158, 11, 0.3)',
            fontSize: '0.78rem',
            fontWeight: 600,
            color: displayedEval.allModeledRequirementsMet
              ? '#34d399'
              : '#fbbf24',
          }}
        >
          {displayedEval.allModeledRequirementsMet
            ? 'All modeled attendee requirements met'
            : `${displayedEval.comparison.attendeesWithUnmetRequirements} attendee(s) with unmet required checks (${displayedEval.comparison.totalFailedRequirementChecks} total failed checks)`}
        </div>
      </div>

      {/* Selected Attendee Before vs After Card */}
      {selectedBaselineAtt && selectedBestAtt && (
        <div className="vp-card-inner">
          <h3 style={{ margin: '0 0 8px 0', fontSize: '0.84rem' }}>
            Selected Attendee Before / After
          </h3>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '8px',
              fontSize: '0.76rem',
            }}
          >
            <div
              style={{
                padding: '8px',
                borderRadius: 'var(--radius-inner)',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ color: 'var(--text-secondary)', marginBottom: '4px' }}>
                Baseline
              </div>
              <div className="mono" style={{ fontWeight: 700, fontSize: '0.86rem' }}>
                {selectedBaselineAtt.visibleSamples}/{selectedBaselineAtt.totalSamples}{' '}
                ({Math.round(selectedBaselineAtt.sampledVisibility * 100)}%)
              </div>
              <div style={{ marginTop: '4px' }}>
                <span
                  className={`vp-badge ${
                    selectedBaselineAtt.clearAndUsable
                      ? 'vp-badge-pass'
                      : 'vp-badge-fail'
                  }`}
                >
                  {selectedBaselineAtt.clearAndUsable
                    ? 'Clear & Usable'
                    : 'Unmet Check'}
                </span>
              </div>
            </div>

            <div
              style={{
                padding: '8px',
                borderRadius: 'var(--radius-inner)',
                background: 'var(--bg-surface)',
                border: hasRevision
                  ? '1px solid rgba(16, 185, 129, 0.35)'
                  : '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ color: 'var(--text-secondary)', marginBottom: '4px' }}>
                Best Verified
              </div>
              <div className="mono" style={{ fontWeight: 700, fontSize: '0.86rem' }}>
                {selectedBestAtt.visibleSamples}/{selectedBestAtt.totalSamples} (
                {Math.round(selectedBestAtt.sampledVisibility * 100)}%)
              </div>
              <div style={{ marginTop: '4px' }}>
                <span
                  className={`vp-badge ${
                    selectedBestAtt.clearAndUsable
                      ? 'vp-badge-pass'
                      : 'vp-badge-fail'
                  }`}
                >
                  {selectedBestAtt.clearAndUsable
                    ? 'Clear & Usable'
                    : 'Unmet Check'}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Lexicographic Comparison Priorities (PRD §6) */}
      <div className="vp-card-inner">
        <h3 style={{ margin: '0 0 8px 0', fontSize: '0.84rem' }}>
          Ordered Acceptance Priorities (PRD §6)
        </h3>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto auto',
            gap: '6px 10px',
            fontSize: '0.75rem',
            alignItems: 'center',
          }}
        >
          <span style={{ color: 'var(--text-muted)' }}>Metric</span>
          <span className="mono" style={{ color: 'var(--text-muted)' }}>
            Before
          </span>
          <span className="mono" style={{ color: 'var(--text-muted)' }}>
            After
          </span>

          <span>1. Unmet Attendees (↓)</span>
          <span className="mono">
            {baseEval.comparison.attendeesWithUnmetRequirements}
          </span>
          <span
            className="mono"
            style={{
              fontWeight: 700,
              color:
                bestEval.comparison.attendeesWithUnmetRequirements <
                baseEval.comparison.attendeesWithUnmetRequirements
                  ? '#34d399'
                  : 'var(--text-primary)',
            }}
          >
            {bestEval.comparison.attendeesWithUnmetRequirements}
          </span>

          <span>2. Failed Checks (↓)</span>
          <span className="mono">
            {baseEval.comparison.totalFailedRequirementChecks}
          </span>
          <span
            className="mono"
            style={{
              fontWeight: 700,
              color:
                bestEval.comparison.totalFailedRequirementChecks <
                baseEval.comparison.totalFailedRequirementChecks
                  ? '#34d399'
                  : 'var(--text-primary)',
            }}
          >
            {bestEval.comparison.totalFailedRequirementChecks}
          </span>

          <span>3. Worst Profile Vis (↑)</span>
          <span className="mono">
            {Math.round(baseEval.comparison.worstProfileMeanVisibility * 100)}%
          </span>
          <span
            className="mono"
            style={{
              fontWeight: 700,
              color:
                bestEval.comparison.worstProfileMeanVisibility >
                baseEval.comparison.worstProfileMeanVisibility
                  ? '#34d399'
                  : 'var(--text-primary)',
            }}
          >
            {Math.round(bestEval.comparison.worstProfileMeanVisibility * 100)}%
          </span>

          <span>4. Total Visible Samples (↑)</span>
          <span className="mono">
            {baseEval.comparison.totalVisibleSamples}
          </span>
          <span
            className="mono"
            style={{
              fontWeight: 700,
              color:
                bestEval.comparison.totalVisibleSamples >
                baseEval.comparison.totalVisibleSamples
                  ? '#34d399'
                  : 'var(--text-primary)',
            }}
          >
            {bestEval.comparison.totalVisibleSamples}
          </span>
        </div>
      </div>

      {/* Per-Profile Metrics Table (No synthetic accessibility score per PRD §6) */}
      <div className="vp-card-inner">
        <h3 style={{ margin: '0 0 8px 0', fontSize: '0.84rem' }}>
          Per-Profile Breakdown ({viewingStage === 'best' ? 'After' : 'Before'})
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {PROFILE_ORDER.map((pid) => {
            const pMetric = displayedEval.perProfile[pid];
            const baseMetric = baseEval.perProfile[pid];
            const bestMetric = bestEval.perProfile[pid];
            const profLabel =
              baselineSnapshot.profiles[pid]?.label ?? pid;

            return (
              <div
                key={pid}
                style={{
                  padding: '8px',
                  borderRadius: 'var(--radius-inner)',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: '0.75rem',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontWeight: 600,
                    marginBottom: '4px',
                  }}
                >
                  <span>{profLabel}</span>
                  <span
                    className={`vp-badge ${
                      pMetric.unmetRequirementCount === 0
                        ? 'vp-badge-pass'
                        : 'vp-badge-fail'
                    }`}
                  >
                    {pMetric.clearAndUsableCount}/{pMetric.attendeeCount} Clear &amp;
                    Usable
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <span>
                    Usable: {pMetric.usableCount}/{pMetric.attendeeCount} · Clear
                    View: {pMetric.clearViewCount}/{pMetric.attendeeCount}
                  </span>
                  <span className="mono">
                    Mean Vis: {Math.round(baseMetric.meanVisibility * 100)}% →{' '}
                    <strong>{Math.round(bestMetric.meanVisibility * 100)}%</strong>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Proposed Patch Operations & Verification Result */}
      {latestAttempt && (
        <div className="vp-card-inner">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '6px',
            }}
          >
            <h3 style={{ margin: 0, fontSize: '0.84rem' }}>
              Proposed Patch (#{latestAttempt.attemptIndex + 1})
            </h3>
            <span
              className={`vp-badge ${
                latestAttempt.comparisonOutcome === 'accepted'
                  ? 'vp-badge-pass'
                  : 'vp-badge-fail'
              }`}
            >
              {latestAttempt.comparisonOutcome}
            </span>
          </div>

          <p
            style={{
              margin: '0 0 8px 0',
              fontSize: '0.76rem',
              color: 'var(--text-secondary)',
            }}
          >
            {latestAttempt.patch.summary}
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {latestAttempt.patch.operations.map((op, i) => (
              <div
                key={i}
                style={{
                  padding: '7px 9px',
                  borderRadius: 'var(--radius-inner)',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: '0.74rem',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontWeight: 600,
                  }}
                >
                  <span className="mono">
                    {op.targetType}: {op.targetId}
                  </span>
                  <span className="mono" style={{ color: '#93c5fd' }}>
                    Δpos=[{op.deltaPositionM.join(', ')}]m · Δyaw={op.deltaYawDeg}°
                  </span>
                </div>
                <div
                  style={{
                    marginTop: '3px',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {op.reason}
                </div>
              </div>
            ))}
          </div>

          {/* Argon Evidence-Linked Visual Diagnosis */}
          {latestAttempt.patch.diagnosis.length > 0 && (
            <div style={{ marginTop: '10px' }}>
              <div
                style={{
                  fontSize: '0.74rem',
                  fontWeight: 600,
                  marginBottom: '6px',
                  color: 'var(--text-secondary)',
                }}
              >
                Initial Visual Critique Findings (Click to jump camera):
              </div>
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}
              >
                {latestAttempt.patch.diagnosis.map((f, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="vp-btn"
                    style={{
                      justifyContent: 'flex-start',
                      textAlign: 'left',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: '3px',
                      padding: '7px 9px',
                    }}
                    onClick={() => onJumpToFinding(f)}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        width: '100%',
                        fontSize: '0.71rem',
                        color: '#93c5fd',
                      }}
                    >
                      <span className="mono">
                        {f.viewId} @ {f.timestampSec.toFixed(1)}s
                      </span>
                      {f.isUnmeasuredVisualNote && (
                        <span className="vp-badge vp-badge-warn">
                          Unmeasured Visual Note
                        </span>
                      )}
                    </div>
                    <span
                      style={{
                        fontSize: '0.74rem',
                        fontWeight: 400,
                        color: 'var(--text-primary)',
                      }}
                    >
                      {f.observation}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Final Reinspection Findings */}
      {activeRun?.finalInspection && (
        <div className="vp-card-inner">
          <h3 style={{ margin: '0 0 6px 0', fontSize: '0.84rem' }}>
            Final Visual Reinspection (PRD §7 Step 6)
          </h3>
          <p
            style={{
              margin: '0 0 8px 0',
              fontSize: '0.75rem',
              color: '#34d399',
            }}
          >
            {activeRun.finalInspection.remainingIssuesSummary}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {activeRun.finalInspection.findings.map((f, idx) => (
              <button
                key={idx}
                type="button"
                className="vp-btn"
                style={{
                  justifyContent: 'flex-start',
                  textAlign: 'left',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: '3px',
                  padding: '7px 9px',
                }}
                onClick={() => onJumpToFinding(f)}
              >
                <span
                  className="mono"
                  style={{ fontSize: '0.71rem', color: '#34d399' }}
                >
                  {f.viewId} @ {f.timestampSec.toFixed(1)}s
                </span>
                <span
                  style={{
                    fontSize: '0.74rem',
                    fontWeight: 400,
                    color: 'var(--text-primary)',
                  }}
                >
                  {f.observation}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
