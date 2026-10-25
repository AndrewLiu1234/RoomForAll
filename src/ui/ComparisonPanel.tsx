import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CONTRACT_VERSION,
  getAttendeeCameraPose,
  type CaptureKeyframe,
  type CaptureTourSpec,
  type Evaluation,
  type EvidenceFinding,
  type EvidenceManifest,
  type ProfileId,
  type RunRecord,
  type SceneSnapshot,
  type Vec3,
} from '../shared/index.js';
import {
  PREPARED_VENUE_SCENE_ID,
  buildDefaultCaptureKeyframes,
  captureEvidence,
  getOverviewCameraPose,
} from '../scene/index.js';

export type EvidenceClipPhase = 'baseline' | 'revision';

export interface FindingCameraPose {
  kind: 'overview' | 'attendee_pov';
  attendeeId?: string;
  placeId?: string;
  viewId?: string;
  label: string;
  cameraPosition: Vec3;
  cameraLookAt: Vec3;
  fovDeg: number;
  aspect: number;
}

export interface FindingNavigationRequest {
  runId: string;
  clipPhase: EvidenceClipPhase;
  targetStage: 'baseline' | 'best';
  captureId?: string;
  snapshot: SceneSnapshot;
  finding: EvidenceFinding;
  isValidTimestamp: boolean;
  requestedTimestampSec: number;
  clampedTimestampSec: number;
  clipDurationSec?: number;
  isTimestampOutOfRange: boolean;
  cameraPose: FindingCameraPose | null;
}

export interface ComparisonPanelProps {
  baselineSnapshot: SceneSnapshot;
  baselineEvaluation: Evaluation;
  activeRun: RunRecord | null;
  viewingStage: 'baseline' | 'best';
  selectedAttendeeId: string;
  onToggleViewingStage: (stage: 'baseline' | 'best') => void;
  onJumpToFinding: (finding: EvidenceFinding) => void;
  baselineVideoUrl?: string | null;
  revisionVideoUrl?: string | null;
  baselineVideoBlob?: Blob | null;
  revisionVideoBlob?: Blob | null;
  onNavigateToFinding?: (request: FindingNavigationRequest) => void;
}

interface PendingSeekRequest {
  runId: string;
  clipPhase: EvidenceClipPhase;
  captureId?: string;
  requestedTimestampSec: number;
  clampedTimestampSec: number;
  manifestDurationSec?: number;
  isTimestampOutOfRange: boolean;
  findingKey: string;
}

const PROFILE_ORDER: ProfileId[] = [
  'shorter_seated',
  'wheelchair_user',
  'extra_legroom',
  'reference_adult',
];

function buildFixturePreviewManifest(
  snapshot: SceneSnapshot,
  phase: EvidenceClipPhase,
): EvidenceManifest {
  const isPrepared24 = snapshot.sceneId === PREPARED_VENUE_SCENE_ID;
  const durationSec = isPrepared24 ? 10 : 3;
  const keyframes = buildDefaultCaptureKeyframes(snapshot, durationSec);
  return {
    contractVersion: CONTRACT_VERSION,
    captureId: `cap_preview_${phase}_${isPrepared24 ? '24' : '4'}`,
    runId: 'preview_dev_fixture',
    phase,
    sceneHash: snapshot.sceneHash,
    mimeType: 'video/webm',
    byteLength: 0,
    durationSec,
    widthPx: 512,
    heightPx: 512,
    keyframes,
    recordedAtIso: new Date().toISOString(),
  };
}

export function resolveFindingNavigation(params: {
  runId: string;
  clipPhase: EvidenceClipPhase;
  finding: EvidenceFinding;
  manifest?: EvidenceManifest;
  snapshot: SceneSnapshot;
  hasAcceptedRevision: boolean;
}): FindingNavigationRequest {
  const {
    runId,
    clipPhase,
    finding,
    manifest,
    snapshot,
    hasAcceptedRevision,
  } = params;

  const targetStage: 'baseline' | 'best' =
    clipPhase === 'revision' && hasAcceptedRevision ? 'best' : 'baseline';

  const rawTime = finding.timestampSec;
  if (typeof rawTime !== 'number' || !Number.isFinite(rawTime) || rawTime < 0) {
    return {
      runId,
      clipPhase,
      targetStage,
      captureId: manifest?.captureId,
      snapshot,
      finding,
      isValidTimestamp: false,
      requestedTimestampSec: rawTime,
      clampedTimestampSec: 0,
      clipDurationSec: manifest?.durationSec,
      isTimestampOutOfRange: true,
      cameraPose: null,
    };
  }

  const clipDurationSec =
    manifest &&
    typeof manifest.durationSec === 'number' &&
    Number.isFinite(manifest.durationSec) &&
    manifest.durationSec > 0
      ? manifest.durationSec
      : undefined;

  const isTimestampOutOfRange =
    clipDurationSec !== undefined && rawTime > clipDurationSec + 1e-3;
  const clampedTimestampSec =
    clipDurationSec !== undefined
      ? Math.max(0, Math.min(rawTime, clipDurationSec))
      : Math.max(0, rawTime);

  const keyframes: CaptureKeyframe[] = manifest?.keyframes ?? [];

  const kfById =
    typeof finding.viewId === 'string' && finding.viewId.trim().length > 0
      ? keyframes.find((k) => k.viewId === finding.viewId)
      : undefined;

  const kfByTime =
    !isTimestampOutOfRange && keyframes.length > 0
      ? keyframes.find(
          (k) =>
            clampedTimestampSec >= k.startSec - 1e-3 &&
            clampedTimestampSec <= k.endSec + 1e-3,
        )
      : undefined;

  const matchedKf = kfById ?? kfByTime;

  const isOverviewViewId =
    !finding.attendeeId &&
    typeof finding.viewId === 'string' &&
    /^view_overview\b/i.test(finding.viewId.trim());

  if (matchedKf?.kind === 'overview' || isOverviewViewId) {
    const fallbackOverview = getOverviewCameraPose(snapshot, 'front_high');
    return {
      runId,
      clipPhase,
      targetStage,
      captureId: manifest?.captureId,
      snapshot,
      finding,
      isValidTimestamp: true,
      requestedTimestampSec: rawTime,
      clampedTimestampSec,
      clipDurationSec,
      isTimestampOutOfRange,
      cameraPose: {
        kind: 'overview',
        viewId: matchedKf?.viewId ?? finding.viewId,
        label: matchedKf?.label ?? 'Venue Room Overview',
        cameraPosition: matchedKf?.cameraPosition ?? fallbackOverview.position,
        cameraLookAt: matchedKf?.cameraLookAt ?? fallbackOverview.lookAt,
        fovDeg: matchedKf?.fovDeg ?? fallbackOverview.fovDeg,
        aspect: matchedKf?.aspect ?? 1.0,
      },
    };
  }

  const rosterMap = new Map(snapshot.roster.map((m) => [m.attendeeId, m]));
  let resolvedAttendeeId: string | undefined;

  if (finding.attendeeId && rosterMap.has(finding.attendeeId)) {
    resolvedAttendeeId = finding.attendeeId;
  } else if (
    matchedKf?.kind === 'attendee_pov' &&
    matchedKf.attendeeId &&
    rosterMap.has(matchedKf.attendeeId)
  ) {
    resolvedAttendeeId = matchedKf.attendeeId;
  } else if (typeof finding.viewId === 'string') {
    const stripped = finding.viewId.trim().replace(/^view_(?:pov_)?/, '');
    if (rosterMap.has(stripped)) {
      resolvedAttendeeId = stripped;
    }
  }

  if (resolvedAttendeeId) {
    const member = rosterMap.get(resolvedAttendeeId)!;
    const pose = getAttendeeCameraPose(snapshot, resolvedAttendeeId);
    return {
      runId,
      clipPhase,
      targetStage,
      captureId: manifest?.captureId,
      snapshot,
      finding: {
        ...finding,
        attendeeId: resolvedAttendeeId,
      },
      isValidTimestamp: true,
      requestedTimestampSec: rawTime,
      clampedTimestampSec,
      clipDurationSec,
      isTimestampOutOfRange,
      cameraPose: {
        kind: 'attendee_pov',
        attendeeId: resolvedAttendeeId,
        placeId: pose.placeId,
        viewId: matchedKf?.viewId ?? finding.viewId,
        label:
          matchedKf?.label ?? `${member.label} (${member.assignedPlaceId})`,
        cameraPosition: matchedKf?.cameraPosition ?? pose.eyePositionWorld,
        cameraLookAt: matchedKf?.cameraLookAt ?? pose.lookAtWorld,
        fovDeg: matchedKf?.fovDeg ?? pose.fovDeg,
        aspect: matchedKf?.aspect ?? pose.aspect,
      },
    };
  }

  return {
    runId,
    clipPhase,
    targetStage,
    captureId: manifest?.captureId,
    snapshot,
    finding,
    isValidTimestamp: true,
    requestedTimestampSec: rawTime,
    clampedTimestampSec,
    clipDurationSec,
    isTimestampOutOfRange,
    cameraPose: null,
  };
}

export function computePhysicalVideoSeekTime(
  clampedTourSec: number,
  manifestDurationSec?: number,
  videoElementDurationSec?: number,
): number {
  if (!Number.isFinite(clampedTourSec) || clampedTourSec <= 0) {
    return 0;
  }

  const hasValidVideoDuration =
    typeof videoElementDurationSec === 'number' &&
    Number.isFinite(videoElementDurationSec) &&
    videoElementDurationSec > 0;

  const hasValidManifestDuration =
    typeof manifestDurationSec === 'number' &&
    Number.isFinite(manifestDurationSec) &&
    manifestDurationSec > 0;

  if (hasValidManifestDuration && hasValidVideoDuration) {
    const ratio = Math.min(
      1,
      Math.max(0, clampedTourSec / manifestDurationSec),
    );
    return Number((ratio * videoElementDurationSec).toFixed(3));
  }

  if (hasValidVideoDuration) {
    return Math.min(clampedTourSec, videoElementDurationSec);
  }

  return clampedTourSec;
}

function formatObjectName(targetId: string): string {
  const map: Record<string, string> = {
    obj_prop_welcome_sign: 'Welcome Sign',
    obj_prop_sign_01: 'Welcome Sign',
    obj_prop_catering_table: 'Literature Table',
    obj_prop_av_cart: 'AV Equipment Cart',
  };
  if (map[targetId]) return map[targetId];
  return targetId
    .replace(/^obj_prop_/, '')
    .replace(/^obj_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatMovementDelta(
  deltaPos: [number, number, number],
  deltaYaw: number,
): string {
  const parts: string[] = [];
  const [dx, dy, dz] = deltaPos;
  if (Math.abs(dx) >= 0.01) {
    parts.push(`${Math.abs(dx).toFixed(2)}m ${dx < 0 ? 'west' : 'east'}`);
  }
  if (Math.abs(dy ?? 0) >= 0.01) {
    parts.push(`${(dy ?? 0) > 0 ? '+' : ''}${(dy ?? 0).toFixed(2)}m elevation`);
  }
  if (Math.abs(dz) >= 0.01) {
    parts.push(`${Math.abs(dz).toFixed(2)}m ${dz < 0 ? 'north' : 'south'}`);
  }
  if (Math.abs(deltaYaw) >= 0.5) {
    parts.push(`${deltaYaw > 0 ? '+' : ''}${deltaYaw}° yaw`);
  }
  return parts.length > 0 ? parts.join(', ') : 'In place';
}

function formatViewLabel(viewId: string): string {
  if (viewId.includes('overview')) return 'Room Overview';
  if (viewId.includes('shorter')) return 'Shorter Viewer POV';
  if (viewId.includes('wheelchair')) return 'Wheelchair Bay POV';
  if (viewId.includes('extra_legroom')) return 'Extra Legroom POV';
  if (viewId.includes('adult')) return 'Standard Adult POV';
  return viewId.replace(/^pov_/, '').replace(/_/g, ' ');
}

function formatOutcomeLabel(outcome: string): string {
  const map: Record<string, string> = {
    improved: 'Verified Improvement',
    in_progress: 'In Progress',
    no_improvement: 'Baseline Retained',
    provider_error: 'Provider Error',
    invalid_structured_output: 'Validation Rejected',
    timeout: 'Timed Out',
    partial_incomplete: 'Partial Improvement',
    failure: 'Run Failed',
  };
  return map[outcome] ?? outcome.replace(/_/g, ' ');
}

function humanizeObservation(text: string): string {
  return text
    .replace(/obj_prop_welcome_sign/g, 'Welcome Sign')
    .replace(/obj_prop_sign_01/g, 'Welcome Sign')
    .replace(/obj_prop_catering_table/g, 'Literature Table')
    .replace(/obj_prop_av_cart/g, 'AV Equipment Cart');
}

export function ComparisonPanel({
  baselineSnapshot,
  baselineEvaluation,
  activeRun,
  viewingStage,
  selectedAttendeeId,
  onToggleViewingStage,
  onJumpToFinding,
  baselineVideoUrl: externalBaselineVideoUrl,
  revisionVideoUrl: externalRevisionVideoUrl,
  baselineVideoBlob: externalBaselineVideoBlob,
  revisionVideoBlob: externalRevisionVideoBlob,
  onNavigateToFinding,
}: ComparisonPanelProps): React.ReactElement {
  const isFixturePreview = activeRun?.runId === 'preview_dev_fixture';

  const latestAttempt =
    activeRun && activeRun.attempts.length > 0
      ? activeRun.attempts[activeRun.attempts.length - 1]
      : undefined;

  const hasRevision =
    activeRun !== null &&
    activeRun.bestSnapshot.sceneHash !== activeRun.baselineSnapshot.sceneHash;

  const hasAcceptedRevision =
    hasRevision &&
    (latestAttempt === undefined ||
      latestAttempt.comparisonOutcome === 'accepted');

  const baseEval = activeRun?.baselineEvaluation ?? baselineEvaluation;
  const bestEval = activeRun?.bestEvaluation ?? baselineEvaluation;
  const displayedEval = viewingStage === 'best' ? bestEval : baseEval;

  const selectedBaselineAtt = baseEval.attendees[selectedAttendeeId];
  const selectedBestAtt = bestEval.attendees[selectedAttendeeId];

  // Resolve EvidenceManifest for baseline and revision video clips
  const baselineManifest: EvidenceManifest | undefined = useMemo(() => {
    if (!activeRun) return undefined;
    if (activeRun.baselineEvidence) return activeRun.baselineEvidence;
    if (isFixturePreview) {
      return buildFixturePreviewManifest(
        activeRun.baselineSnapshot,
        'baseline',
      );
    }
    return undefined;
  }, [activeRun, isFixturePreview]);

  const revisionManifest: EvidenceManifest | undefined = useMemo(() => {
    if (!activeRun) return undefined;
    if (activeRun.revisionEvidence) return activeRun.revisionEvidence;
    if (isFixturePreview && hasAcceptedRevision) {
      return buildFixturePreviewManifest(activeRun.bestSnapshot, 'revision');
    }
    return undefined;
  }, [activeRun, isFixturePreview, hasAcceptedRevision]);

  const baselineVideoRef = useRef<HTMLVideoElement | null>(null);
  const revisionVideoRef = useRef<HTMLVideoElement | null>(null);
  const pendingSeekRef = useRef<{
    baseline: PendingSeekRequest | null;
    revision: PendingSeekRequest | null;
  }>({
    baseline: null,
    revision: null,
  });

  const [synthesizedBaselineUrl, setSynthesizedBaselineUrl] = useState<
    string | null
  >(null);
  const [synthesizedRevisionUrl, setSynthesizedRevisionUrl] = useState<
    string | null
  >(null);
  const [isSynthesizingBaseline, setIsSynthesizingBaseline] =
    useState<boolean>(false);
  const [isSynthesizingRevision, setIsSynthesizingRevision] =
    useState<boolean>(false);
  const [selectedFindingKey, setSelectedFindingKey] = useState<string | null>(
    null,
  );

  const resolvedBaselineVideoUrl =
    externalBaselineVideoUrl ?? synthesizedBaselineUrl;
  const resolvedRevisionVideoUrl =
    externalRevisionVideoUrl ?? synthesizedRevisionUrl;

  useEffect(() => {
    pendingSeekRef.current = { baseline: null, revision: null };
    setSelectedFindingKey(null);
  }, [activeRun?.runId, baselineSnapshot.sceneHash]);

  // Synthesize baseline clip URL when activeRun has a baseline manifest
  useEffect(() => {
    if (externalBaselineVideoUrl) {
      setSynthesizedBaselineUrl(null);
      setIsSynthesizingBaseline(false);
      return;
    }
    if (externalBaselineVideoBlob) {
      const url = URL.createObjectURL(externalBaselineVideoBlob);
      setSynthesizedBaselineUrl(url);
      setIsSynthesizingBaseline(false);
      return () => URL.revokeObjectURL(url);
    }
    if (!activeRun || !baselineManifest) {
      setSynthesizedBaselineUrl(null);
      setIsSynthesizingBaseline(false);
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;
    setIsSynthesizingBaseline(true);

    const tourSpec: CaptureTourSpec = {
      captureId: baselineManifest.captureId,
      runId: activeRun.runId,
      phase: 'baseline',
      sceneHash: activeRun.baselineSnapshot.sceneHash,
      snapshot: activeRun.baselineSnapshot,
      keyframes: baselineManifest.keyframes,
      totalDurationSec: baselineManifest.durationSec || 3,
      deadlineIso: new Date(Date.now() + 60_000).toISOString(),
    };

    captureEvidence(activeRun.baselineSnapshot, tourSpec)
      .then((payload) => {
        if (cancelled) return;
        createdUrl = URL.createObjectURL(payload.videoBlob);
        setSynthesizedBaselineUrl(createdUrl);
        setIsSynthesizingBaseline(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSynthesizedBaselineUrl(null);
        setIsSynthesizingBaseline(false);
      });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [
    activeRun?.runId,
    activeRun?.baselineSnapshot,
    baselineManifest,
    externalBaselineVideoUrl,
    externalBaselineVideoBlob,
  ]);

  // Synthesize revision clip URL when activeRun has a revision manifest
  useEffect(() => {
    if (externalRevisionVideoUrl) {
      setSynthesizedRevisionUrl(null);
      setIsSynthesizingRevision(false);
      return;
    }
    if (externalRevisionVideoBlob) {
      const url = URL.createObjectURL(externalRevisionVideoBlob);
      setSynthesizedRevisionUrl(url);
      setIsSynthesizingRevision(false);
      return () => URL.revokeObjectURL(url);
    }
    if (!activeRun || !revisionManifest) {
      setSynthesizedRevisionUrl(null);
      setIsSynthesizingRevision(false);
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;
    setIsSynthesizingRevision(true);

    const tourSpec: CaptureTourSpec = {
      captureId: revisionManifest.captureId,
      runId: activeRun.runId,
      phase: 'revision',
      sceneHash: activeRun.bestSnapshot.sceneHash,
      snapshot: activeRun.bestSnapshot,
      keyframes: revisionManifest.keyframes,
      totalDurationSec: revisionManifest.durationSec || 3,
      deadlineIso: new Date(Date.now() + 60_000).toISOString(),
    };

    captureEvidence(activeRun.bestSnapshot, tourSpec)
      .then((payload) => {
        if (cancelled) return;
        createdUrl = URL.createObjectURL(payload.videoBlob);
        setSynthesizedRevisionUrl(createdUrl);
        setIsSynthesizingRevision(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSynthesizedRevisionUrl(null);
        setIsSynthesizingRevision(false);
      });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [
    activeRun?.runId,
    activeRun?.bestSnapshot,
    revisionManifest,
    externalRevisionVideoUrl,
    externalRevisionVideoBlob,
  ]);

  const executeSeekOnVideoElement = (
    videoEl: HTMLVideoElement,
    req: PendingSeekRequest,
  ): void => {
    const physicalTime = computePhysicalVideoSeekTime(
      req.clampedTimestampSec,
      req.manifestDurationSec,
      videoEl.duration,
    );
    try {
      videoEl.currentTime = physicalTime;
      videoEl.pause();
    } catch {
      // Ignore if media decoder is initializing
    }
  };

  const handleSelectFinding = (
    finding: EvidenceFinding,
    clipPhase: EvidenceClipPhase,
    findingKey: string,
  ): void => {
    if (!activeRun) {
      onJumpToFinding(finding);
      return;
    }

    setSelectedFindingKey(findingKey);

    const targetManifest =
      clipPhase === 'revision' ? revisionManifest : baselineManifest;
    const targetSnapshot =
      clipPhase === 'revision' && hasAcceptedRevision
        ? activeRun.bestSnapshot
        : activeRun.baselineSnapshot;

    const navRequest = resolveFindingNavigation({
      runId: activeRun.runId,
      clipPhase,
      finding,
      manifest: targetManifest,
      snapshot: targetSnapshot,
      hasAcceptedRevision,
    });

    const targetVideoEl =
      clipPhase === 'baseline'
        ? baselineVideoRef.current
        : revisionVideoRef.current;

    if (navRequest.isValidTimestamp) {
      const seekReq: PendingSeekRequest = {
        runId: activeRun.runId,
        clipPhase,
        captureId: targetManifest?.captureId,
        requestedTimestampSec: navRequest.requestedTimestampSec,
        clampedTimestampSec: navRequest.clampedTimestampSec,
        manifestDurationSec: navRequest.clipDurationSec,
        isTimestampOutOfRange: navRequest.isTimestampOutOfRange,
        findingKey,
      };

      if (targetVideoEl && targetVideoEl.readyState >= 1) {
        pendingSeekRef.current[clipPhase] = null;
        executeSeekOnVideoElement(targetVideoEl, seekReq);
      } else {
        pendingSeekRef.current[clipPhase] = seekReq;
      }
    }

    onToggleViewingStage(navRequest.targetStage);
    if (navRequest.cameraPose !== null) {
      onJumpToFinding(navRequest.finding);
    } else {
      onJumpToFinding(finding);
    }
    onNavigateToFinding?.(navRequest);
  };

  return (
    <aside className="vp-rail-right" aria-label="Spatial Audit and Comparison">
      {/* Top Section: Before / After Switcher & Headline Outcome */}
      <div
        className="vp-section"
        style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h2 className="vp-section-title">Spatial Audit</h2>
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
              {formatOutcomeLabel(activeRun.outcome)}
            </span>
          )}
        </div>

        {/* Before / After Segmented Switcher */}
        <div
          className="vp-segmented"
          style={{
            width: '100%',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
          }}
          role="tablist"
          aria-label="Compare baseline and repaired layouts"
        >
          <button
            type="button"
            role="tab"
            aria-selected={viewingStage === 'baseline'}
            className={`vp-segment-btn vp-focusable ${
              viewingStage === 'baseline' ? 'vp-segment-btn-active' : ''
            }`}
            onClick={() => onToggleViewingStage('baseline')}
          >
            Before · Baseline
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewingStage === 'best'}
            disabled={!activeRun}
            className={`vp-segment-btn vp-focusable ${
              viewingStage === 'best' ? 'vp-segment-btn-active' : ''
            }`}
            onClick={() => onToggleViewingStage('best')}
          >
            After · Repaired
          </button>
        </div>

        {/* Overall Requirement Summary Banner */}
        <div
          style={{
            padding: '10px 12px',
            borderRadius: 'var(--radius-card)',
            background: displayedEval.allModeledRequirementsMet
              ? 'var(--status-pass-bg)'
              : 'var(--status-warn-bg)',
            border: `1px solid ${
              displayedEval.allModeledRequirementsMet
                ? 'var(--status-pass-border)'
                : 'var(--status-warn-border)'
            }`,
            display: 'flex',
            alignItems: 'flex-start',
            gap: '9px',
          }}
        >
          <span
            className={`vp-status-dot ${
              displayedEval.allModeledRequirementsMet
                ? 'vp-status-dot-pass'
                : 'vp-status-dot-warn'
            }`}
            style={{ marginTop: '5px' }}
          />
          <div style={{ fontSize: '0.78rem', lineHeight: 1.4 }}>
            <div
              style={{
                fontWeight: 600,
                color: displayedEval.allModeledRequirementsMet
                  ? 'var(--status-pass-text)'
                  : 'var(--status-warn-text)',
              }}
            >
              {displayedEval.allModeledRequirementsMet
                ? `All ${displayedEval.occupiedCount} seats clear & accessible`
                : `${displayedEval.comparison.attendeesWithUnmetRequirements} of ${displayedEval.occupiedCount} guests have unmet requirements`}
            </div>
            <div
              style={{
                fontSize: '0.72rem',
                color: 'var(--text-secondary)',
                marginTop: '2px',
              }}
            >
              {displayedEval.allModeledRequirementsMet
                ? 'Zero sightline obstructions, route blocks, or clearance failures.'
                : `${displayedEval.comparison.totalFailedRequirementChecks} failed spatial checks detected in this layout.`}
            </div>
          </div>
        </div>
      </div>

      {/* Section 2: Key Metrics & Selected Guest Before -> After */}
      <div
        className="vp-section"
        style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
      >
        <h3 className="vp-section-title">Verification Metrics</h3>

        <div className="vp-metric-list">
          <div className="vp-metric-row">
            <span style={{ color: 'var(--text-secondary)' }}>
              Impacted Guests
            </span>
            <div
              className="mono"
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <span>{baseEval.comparison.attendeesWithUnmetRequirements}</span>
              {hasRevision && (
                <>
                  <span style={{ color: 'var(--text-muted)' }}>→</span>
                  <span
                    style={{
                      fontWeight: 600,
                      color:
                        bestEval.comparison.attendeesWithUnmetRequirements <
                        baseEval.comparison.attendeesWithUnmetRequirements
                          ? 'var(--status-pass-text)'
                          : 'var(--text-primary)',
                    }}
                  >
                    {bestEval.comparison.attendeesWithUnmetRequirements}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="vp-metric-row">
            <span style={{ color: 'var(--text-secondary)' }}>Failed Checks</span>
            <div
              className="mono"
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <span>{baseEval.comparison.totalFailedRequirementChecks}</span>
              {hasRevision && (
                <>
                  <span style={{ color: 'var(--text-muted)' }}>→</span>
                  <span
                    style={{
                      fontWeight: 600,
                      color:
                        bestEval.comparison.totalFailedRequirementChecks <
                        baseEval.comparison.totalFailedRequirementChecks
                          ? 'var(--status-pass-text)'
                          : 'var(--text-primary)',
                    }}
                  >
                    {bestEval.comparison.totalFailedRequirementChecks}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="vp-metric-row">
            <span style={{ color: 'var(--text-secondary)' }}>
              Lowest Group Sightline
            </span>
            <div
              className="mono"
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <span>
                {Math.round(
                  baseEval.comparison.worstProfileMeanVisibility * 100,
                )}
                %
              </span>
              {hasRevision && (
                <>
                  <span style={{ color: 'var(--text-muted)' }}>→</span>
                  <span
                    style={{
                      fontWeight: 600,
                      color:
                        bestEval.comparison.worstProfileMeanVisibility >
                        baseEval.comparison.worstProfileMeanVisibility
                          ? 'var(--status-pass-text)'
                          : 'var(--text-primary)',
                    }}
                  >
                    {Math.round(
                      bestEval.comparison.worstProfileMeanVisibility * 100,
                    )}
                    %
                  </span>
                </>
              )}
            </div>
          </div>

          {baseEval.evacuation && bestEval.evacuation && (
            <>
              <div className="vp-metric-row">
                <span style={{ color: 'var(--text-secondary)' }}>
                  Emergency Evac Time
                </span>
                <div
                  className="mono"
                  style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <span>
                    {baseEval.evacuation.totalEvacuationTimeSec.toFixed(1)}s
                  </span>
                  {hasRevision && (
                    <>
                      <span style={{ color: 'var(--text-muted)' }}>→</span>
                      <span
                        style={{
                          fontWeight: 600,
                          color:
                            bestEval.evacuation.totalEvacuationTimeSec <
                            baseEval.evacuation.totalEvacuationTimeSec
                              ? 'var(--status-pass-text)'
                              : 'var(--text-primary)',
                        }}
                      >
                        {bestEval.evacuation.totalEvacuationTimeSec.toFixed(1)}s
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="vp-metric-row">
                <span style={{ color: 'var(--text-secondary)' }}>
                  Active Emergency Exits
                </span>
                <div
                  className="mono"
                  style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <span>
                    {baseEval.evacuation.activeExitCount}/
                    {baseEval.evacuation.totalExitCount}
                  </span>
                  {hasRevision && (
                    <>
                      <span style={{ color: 'var(--text-muted)' }}>→</span>
                      <span
                        style={{
                          fontWeight: 600,
                          color:
                            bestEval.evacuation.activeExitCount >
                            baseEval.evacuation.activeExitCount
                              ? 'var(--status-pass-text)'
                              : 'var(--text-primary)',
                        }}
                      >
                        {bestEval.evacuation.activeExitCount}/
                        {bestEval.evacuation.totalExitCount}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </>
          )}

          {selectedBaselineAtt && selectedBestAtt && (
            <div className="vp-metric-row">
              <span style={{ color: 'var(--text-secondary)' }}>
                Selected Seat Sightline
              </span>
              <div
                className="mono"
                style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <span>
                  {Math.round(selectedBaselineAtt.sampledVisibility * 100)}%
                </span>
                {hasRevision && (
                  <>
                    <span style={{ color: 'var(--text-muted)' }}>→</span>
                    <span
                      style={{
                        fontWeight: 600,
                        color:
                          selectedBestAtt.sampledVisibility >
                          selectedBaselineAtt.sampledVisibility
                            ? 'var(--status-pass-text)'
                            : 'var(--text-primary)',
                      }}
                    >
                      {Math.round(selectedBestAtt.sampledVisibility * 100)}%
                    </span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Section 3: Audience Profile Breakdown */}
      <div
        className="vp-section"
        style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
      >
        <h3 className="vp-section-title">Audience Groups</h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {PROFILE_ORDER.map((pid) => {
            const pMetric = displayedEval.perProfile[pid];
            const baseMetric = baseEval.perProfile[pid];
            const bestMetric = bestEval.perProfile[pid];
            const profLabel = baselineSnapshot.profiles[pid]?.label ?? pid;
            const visPct = Math.round(pMetric.meanVisibility * 100);
            const allClear = pMetric.unmetRequirementCount === 0;

            return (
              <div
                key={pid}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '5px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '0.76rem',
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{profLabel}</span>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <span
                      className="mono"
                      style={{
                        fontSize: '0.72rem',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {hasRevision &&
                      baseMetric.meanVisibility !== bestMetric.meanVisibility
                        ? `${Math.round(baseMetric.meanVisibility * 100)}% → ${Math.round(bestMetric.meanVisibility * 100)}%`
                        : `${visPct}% view`}
                    </span>
                    <span
                      className={`vp-badge ${
                        allClear ? 'vp-badge-pass' : 'vp-badge-fail'
                      }`}
                    >
                      {pMetric.clearAndUsableCount}/{pMetric.attendeeCount} Clear
                    </span>
                  </div>
                </div>

                {/* Subtle Sightline Progress Bar */}
                <div
                  style={{
                    height: '4px',
                    width: '100%',
                    borderRadius: 'var(--radius-pill)',
                    background: 'var(--bg-elevated)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${visPct}%`,
                      background: allClear
                        ? 'var(--status-pass)'
                        : 'var(--status-fail)',
                      transition: 'width 220ms var(--ease-out-expo)',
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Section 4: Side-by-Side Optical Video Evidence when a Run is Active */}
      {activeRun && (
        <div
          className="vp-section"
          style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
        >
          <h3 className="vp-section-title">Optical Tour Video</h3>

          <div className="vp-video-grid">
            {/* Baseline Video Slot */}
            <div
              className={`vp-video-slot ${
                viewingStage === 'baseline' ? 'vp-video-slot-active' : ''
              }`}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: '0.71rem',
                }}
              >
                <span style={{ fontWeight: 600 }}>Before</span>
                {baselineManifest && (
                  <span className="mono" style={{ color: 'var(--text-muted)' }}>
                    {baselineManifest.durationSec.toFixed(0)}s
                  </span>
                )}
              </div>
              <div className="vp-video-frame">
                {resolvedBaselineVideoUrl ? (
                  <video
                    ref={baselineVideoRef}
                    src={resolvedBaselineVideoUrl}
                    controls
                    playsInline
                    preload="metadata"
                    className="vp-video-element vp-focusable"
                    aria-label="Baseline optical tour video"
                    onLoadedMetadata={(e) => {
                      const pending = pendingSeekRef.current.baseline;
                      if (pending && pending.runId === activeRun.runId) {
                        pendingSeekRef.current.baseline = null;
                        executeSeekOnVideoElement(e.currentTarget, pending);
                      }
                    }}
                  />
                ) : (
                  <span
                    style={{
                      fontSize: '0.7rem',
                      color: 'var(--text-muted)',
                      padding: '8px',
                      textAlign: 'center',
                    }}
                  >
                    {isSynthesizingBaseline ? 'Rendering clip…' : 'Pending tour'}
                  </span>
                )}
              </div>
            </div>

            {/* Repaired Video Slot */}
            <div
              className={`vp-video-slot ${
                viewingStage === 'best' ? 'vp-video-slot-active' : ''
              }`}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: '0.71rem',
                }}
              >
                <span style={{ fontWeight: 600 }}>After</span>
                {revisionManifest && (
                  <span className="mono" style={{ color: 'var(--text-muted)' }}>
                    {revisionManifest.durationSec.toFixed(0)}s
                  </span>
                )}
              </div>
              <div className="vp-video-frame">
                {resolvedRevisionVideoUrl ? (
                  <video
                    ref={revisionVideoRef}
                    src={resolvedRevisionVideoUrl}
                    controls
                    playsInline
                    preload="metadata"
                    className="vp-video-element vp-focusable"
                    aria-label="Repaired optical tour video"
                    onLoadedMetadata={(e) => {
                      const pending = pendingSeekRef.current.revision;
                      if (pending && pending.runId === activeRun.runId) {
                        pendingSeekRef.current.revision = null;
                        executeSeekOnVideoElement(e.currentTarget, pending);
                      }
                    }}
                  />
                ) : (
                  <span
                    style={{
                      fontSize: '0.7rem',
                      color: 'var(--text-muted)',
                      padding: '8px',
                      textAlign: 'center',
                    }}
                  >
                    {isSynthesizingRevision ? 'Rendering clip…' : 'Pending fix'}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Section 5: Applied Spatial Repairs & Argon Visual Critique */}
      {latestAttempt && (
        <div
          className="vp-section"
          style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <h3 className="vp-section-title">Applied Spatial Adjustments</h3>
            <span
              className={`vp-badge ${
                latestAttempt.comparisonOutcome === 'accepted'
                  ? 'vp-badge-pass'
                  : 'vp-badge-fail'
              }`}
            >
              {latestAttempt.comparisonOutcome === 'accepted'
                ? 'Verified'
                : 'Rejected'}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {latestAttempt.patch.operations.map((op, i) => (
              <div
                key={i}
                style={{
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-card)',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-hairline)',
                  fontSize: '0.75rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '6px',
                  }}
                >
                  <span style={{ fontWeight: 600 }}>
                    {formatObjectName(op.targetId)}
                  </span>
                  <span
                    className="mono"
                    style={{
                      fontSize: '0.7rem',
                      color: 'var(--accent-primary-bright)',
                    }}
                  >
                    {formatMovementDelta(op.deltaPositionM, op.deltaYawDeg)}
                  </span>
                </div>
                <div
                  style={{ color: 'var(--text-secondary)', fontSize: '0.73rem' }}
                >
                  {humanizeObservation(op.reason)}
                </div>
              </div>
            ))}
          </div>

          {/* Clickable Visual Critique Camera & Video Jump Cards */}
          {latestAttempt.patch.diagnosis.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                marginTop: '4px',
              }}
            >
              <div
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                }}
              >
                Visual Inspection Evidence
              </div>
              {latestAttempt.patch.diagnosis.map((f, idx) => {
                const key = `base_${idx}`;
                const isSelected = selectedFindingKey === key;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`vp-finding-btn vp-focusable ${
                      isSelected ? 'vp-finding-btn-selected' : ''
                    }`}
                    onClick={() => handleSelectFinding(f, 'baseline', key)}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        width: '100%',
                        fontSize: '0.71rem',
                        color: 'var(--accent-primary-bright)',
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>
                        {formatViewLabel(f.viewId)}
                      </span>
                      <span className="mono">{f.timestampSec.toFixed(1)}s ↗</span>
                    </div>
                    <span
                      style={{
                        fontSize: '0.73rem',
                        color: 'var(--text-secondary)',
                        lineHeight: 1.4,
                      }}
                    >
                      {humanizeObservation(f.observation)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Final Reinspection Summary & Findings */}
      {activeRun?.finalInspection && (
        <div
          className="vp-section"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            borderBottom: 'none',
          }}
        >
          <h3 className="vp-section-title">Final Optical Sign-Off</h3>
          <p
            style={{
              margin: 0,
              fontSize: '0.75rem',
              color: 'var(--status-pass-text)',
              lineHeight: 1.45,
            }}
          >
            {humanizeObservation(
              activeRun.finalInspection.remainingIssuesSummary,
            )}
          </p>

          {activeRun.finalInspection.findings.map((f, idx) => {
            const key = `rev_${idx}`;
            const isSelected = selectedFindingKey === key;
            return (
              <button
                key={key}
                type="button"
                className={`vp-finding-btn vp-focusable ${
                  isSelected ? 'vp-finding-btn-selected' : ''
                }`}
                onClick={() => handleSelectFinding(f, 'revision', key)}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    width: '100%',
                    fontSize: '0.71rem',
                    color: 'var(--status-pass-text)',
                  }}
                >
                  <span style={{ fontWeight: 600 }}>
                    {formatViewLabel(f.viewId)} · Verified
                  </span>
                  <span className="mono">{f.timestampSec.toFixed(1)}s ↗</span>
                </div>
                <span
                  style={{
                    fontSize: '0.73rem',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.4,
                  }}
                >
                  {humanizeObservation(f.observation)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </aside>
  );
}
