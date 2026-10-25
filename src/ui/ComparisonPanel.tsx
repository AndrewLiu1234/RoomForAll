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
  /** Optional Person 1 handoff props (backward-compatible) */
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
  'reference_adult',
  'shorter_seated',
  'wheelchair_user',
  'extra_legroom',
];

/**
 * Builds a deterministic fixture `EvidenceManifest` ONLY when `activeRun.runId === 'preview_dev_fixture'`
 * (the local developer preview fixture) so its timeline matches the preview findings.
 * Never used for live runs.
 */
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

/**
 * Pure helper that resolves a timestamped `EvidenceFinding` against its clip's
 * `EvidenceManifest` and `SceneSnapshot` without guessing attendee identity from
 * assumed segment durations.
 */
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

  // 1. Match keyframe by explicit viewId first, or by [startSec, endSec] segment boundary
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

  // 2. Check if finding/keyframe is an overview segment
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

  // 3. Check if finding/keyframe resolves to a valid attendee in snapshot.roster
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

  // 4. Valid timestamp, but no reliable POV metadata
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

/**
 * Maps a clamped tour timestamp `clampedTourSec` (in `manifest.durationSec` space)
 * to the physical `<video>` element's `currentTime`, handling `0` and proportional
 * wall-clock scaling when `captureEvidence` compressed a virtual tour into a shorter physical clip.
 */
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
    const ratio = Math.min(1, Math.max(0, clampedTourSec / manifestDurationSec));
    return Number((ratio * videoElementDurationSec).toFixed(3));
  }

  if (hasValidVideoDuration) {
    return Math.min(clampedTourSec, videoElementDurationSec);
  }

  return clampedTourSec;
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

  const hasAcceptedRevision =
    activeRun !== null &&
    activeRun.bestSnapshot.sceneHash !== activeRun.baselineSnapshot.sceneHash &&
    (latestAttempt === undefined ||
      latestAttempt.comparisonOutcome === 'accepted');

  const baseEval = activeRun?.baselineEvaluation ?? baselineEvaluation;
  const bestEval = activeRun?.bestEvaluation ?? baselineEvaluation;
  const displayedEval = viewingStage === 'best' ? bestEval : baseEval;

  const selectedBaselineAtt = baseEval.attendees[selectedAttendeeId];
  const selectedBestAtt = bestEval.attendees[selectedAttendeeId];

  // Resolve authoritative EvidenceManifest for baseline and revision
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

  // Video element refs & queued seek state
  const baselineVideoRef = useRef<HTMLVideoElement | null>(null);
  const revisionVideoRef = useRef<HTMLVideoElement | null>(null);
  const pendingSeekRef = useRef<{
    baseline: PendingSeekRequest | null;
    revision: PendingSeekRequest | null;
  }>({
    baseline: null,
    revision: null,
  });

  // Component-owned object URLs & loading/error state
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

  const [baselineMediaLoading, setBaselineMediaLoading] =
    useState<boolean>(false);
  const [revisionMediaLoading, setRevisionMediaLoading] =
    useState<boolean>(false);
  const [baselineMediaError, setBaselineMediaError] = useState<string | null>(
    null,
  );
  const [revisionMediaError, setRevisionMediaError] = useState<string | null>(
    null,
  );

  // Interactive finding selection & user feedback state
  const [selectedFindingKey, setSelectedFindingKey] = useState<string | null>(
    null,
  );
  const [seekFeedback, setSeekFeedback] = useState<{
    message: string;
    isWarning: boolean;
  } | null>(null);

  const resolvedBaselineVideoUrl =
    externalBaselineVideoUrl ?? synthesizedBaselineUrl;
  const resolvedRevisionVideoUrl =
    externalRevisionVideoUrl ?? synthesizedRevisionUrl;

  // Reset run-scoped UI state, pending seeks, and playback when runId or baseline sceneHash changes
  useEffect(() => {
    pendingSeekRef.current = { baseline: null, revision: null };
    setSelectedFindingKey(null);
    setSeekFeedback(null);
    setBaselineMediaError(null);
    setRevisionMediaError(null);

    if (baselineVideoRef.current) {
      try {
        baselineVideoRef.current.pause();
      } catch {
        // Ignore in non-media DOM environments
      }
    }
    if (revisionVideoRef.current) {
      try {
        revisionVideoRef.current.pause();
      } catch {
        // Ignore in non-media DOM environments
      }
    }
  }, [activeRun?.runId, baselineSnapshot.sceneHash]);

  // Manage component-owned object URL for baseline clip (from external Blob or captureEvidence)
  useEffect(() => {
    if (externalBaselineVideoUrl) {
      setSynthesizedBaselineUrl(null);
      setIsSynthesizingBaseline(false);
      return;
    }

    if (externalBaselineVideoBlob) {
      const createdUrl = URL.createObjectURL(externalBaselineVideoBlob);
      setSynthesizedBaselineUrl(createdUrl);
      setIsSynthesizingBaseline(false);
      setBaselineMediaError(null);
      return () => {
        URL.revokeObjectURL(createdUrl);
      };
    }

    if (!activeRun || !baselineManifest) {
      setSynthesizedBaselineUrl(null);
      setIsSynthesizingBaseline(false);
      return;
    }

    let cancelled = false;
    let createdObjectUrl: string | null = null;
    setIsSynthesizingBaseline(true);
    setBaselineMediaError(null);

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
        createdObjectUrl = URL.createObjectURL(payload.videoBlob);
        setSynthesizedBaselineUrl(createdObjectUrl);
        setIsSynthesizingBaseline(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSynthesizedBaselineUrl(null);
        setIsSynthesizingBaseline(false);
        setBaselineMediaError('This evidence clip could not be loaded.');
      });

    return () => {
      cancelled = true;
      if (createdObjectUrl) {
        URL.revokeObjectURL(createdObjectUrl);
      }
    };
  }, [
    activeRun?.runId,
    activeRun?.baselineSnapshot,
    baselineManifest,
    externalBaselineVideoUrl,
    externalBaselineVideoBlob,
  ]);

  // Manage component-owned object URL for revision clip (from external Blob or captureEvidence)
  useEffect(() => {
    if (externalRevisionVideoUrl) {
      setSynthesizedRevisionUrl(null);
      setIsSynthesizingRevision(false);
      return;
    }

    if (externalRevisionVideoBlob) {
      const createdUrl = URL.createObjectURL(externalRevisionVideoBlob);
      setSynthesizedRevisionUrl(createdUrl);
      setIsSynthesizingRevision(false);
      setRevisionMediaError(null);
      return () => {
        URL.revokeObjectURL(createdUrl);
      };
    }

    if (!activeRun || !revisionManifest) {
      setSynthesizedRevisionUrl(null);
      setIsSynthesizingRevision(false);
      return;
    }

    let cancelled = false;
    let createdObjectUrl: string | null = null;
    setIsSynthesizingRevision(true);
    setRevisionMediaError(null);

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
        createdObjectUrl = URL.createObjectURL(payload.videoBlob);
        setSynthesizedRevisionUrl(createdObjectUrl);
        setIsSynthesizingRevision(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSynthesizedRevisionUrl(null);
        setIsSynthesizingRevision(false);
        setRevisionMediaError('This evidence clip could not be loaded.');
      });

    return () => {
      cancelled = true;
      if (createdObjectUrl) {
        URL.revokeObjectURL(createdObjectUrl);
      }
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
      // Ignore if underlying browser media decoder is still initializing
    }
  };

  const handleSelectFinding = (
    finding: EvidenceFinding,
    clipPhase: EvidenceClipPhase,
    findingKey: string,
  ): void => {
    if (!activeRun) return;

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

    if (!navRequest.isValidTimestamp) {
      setSeekFeedback({
        message: `Cannot seek ${clipPhase} clip: finding has an invalid timestamp (${String(finding.timestampSec)}).`,
        isWarning: true,
      });
      return;
    }

    // Pause the opposite video player if playing
    const otherVideoEl =
      clipPhase === 'baseline'
        ? revisionVideoRef.current
        : baselineVideoRef.current;
    if (otherVideoEl) {
      try {
        otherVideoEl.pause();
      } catch {
        // Ignore
      }
    }

    const targetVideoEl =
      clipPhase === 'baseline'
        ? baselineVideoRef.current
        : revisionVideoRef.current;

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

    const isVideoReady =
      targetVideoEl !== null && targetVideoEl.readyState >= 1;

    if (isVideoReady && targetVideoEl) {
      pendingSeekRef.current[clipPhase] = null;
      executeSeekOnVideoElement(targetVideoEl, seekReq);
    } else {
      // Queue seek until onLoadedMetadata fires (latest valid request wins)
      pendingSeekRef.current[clipPhase] = seekReq;
    }

    // Select the matching layout ('baseline' vs 'best') and update the 3D camera if POV metadata is reliable
    onToggleViewingStage(navRequest.targetStage);

    if (navRequest.cameraPose !== null) {
      onJumpToFinding(navRequest.finding);
    }
    onNavigateToFinding?.(navRequest);

    // Construct honest, specific seek & 3D viewpoint feedback message
    const clipLabel = clipPhase === 'baseline' ? 'Baseline' : 'Revision';
    const timeNote = navRequest.isTimestampOutOfRange
      ? `Requested timestamp ${navRequest.requestedTimestampSec.toFixed(1)}s exceeds ${clipLabel.toLowerCase()} clip duration (${(navRequest.clipDurationSec ?? 0).toFixed(1)}s); clamped to ${navRequest.clampedTimestampSec.toFixed(1)}s.`
      : isVideoReady
        ? `Paused ${clipLabel} video at ${navRequest.clampedTimestampSec.toFixed(1)}s.`
        : `Queued ${clipLabel} video seek to ${navRequest.clampedTimestampSec.toFixed(1)}s (loading media metadata…).`;

    const povNote =
      navRequest.cameraPose === null
        ? ' Matching 3D viewpoint metadata is unavailable for this finding.'
        : navRequest.cameraPose.kind === 'overview'
          ? ` Switched 3D viewport to ${navRequest.targetStage === 'best' ? 'Revised' : 'Baseline'} Room Overview.`
          : ` Switched 3D viewport to ${navRequest.cameraPose.label}.`;

    setSeekFeedback({
      message: `${timeNote}${povNote}`,
      isWarning:
        navRequest.isTimestampOutOfRange || navRequest.cameraPose === null,
    });
  };

  // Determine explicit status messages for Baseline and Revision video slots
  const getBaselinePlaceholderMessage = (): {
    text: string;
    isError: boolean;
  } => {
    if (!activeRun) {
      return {
        text: 'No run selected. Start a live review or load a fixture preview to inspect baseline video evidence.',
        isError: false,
      };
    }
    if (baselineMediaError) {
      return { text: baselineMediaError, isError: true };
    }
    if (
      activeRun.state === 'preparing' ||
      activeRun.state === 'capturing_baseline'
    ) {
      return { text: 'Baseline video is being captured.', isError: false };
    }
    if (isSynthesizingBaseline) {
      return { text: 'Loading baseline evidence clip…', isError: false };
    }
    return {
      text: 'Baseline video has not been produced for this run.',
      isError: true,
    };
  };

  const getRevisionPlaceholderMessage = (): {
    text: string;
    isError: boolean;
  } => {
    if (!activeRun) {
      return {
        text: 'No run selected. Revision video is recorded after a proposed change passes verification.',
        isError: false,
      };
    }
    if (revisionMediaError) {
      return { text: revisionMediaError, isError: true };
    }
    if (activeRun.state === 'rendering_revision') {
      return { text: 'Revision video is being captured.', isError: false };
    }
    if (
      activeRun.state === 'preparing' ||
      activeRun.state === 'capturing_baseline' ||
      activeRun.state === 'inspecting_baseline' ||
      activeRun.state === 'proposing' ||
      activeRun.state === 'verifying'
    ) {
      return {
        text: 'Revision video is pending baseline review and patch verification.',
        isError: false,
      };
    }
    if (isSynthesizingRevision) {
      return { text: 'Loading revision evidence clip…', isError: false };
    }
    if (latestAttempt && latestAttempt.comparisonOutcome !== 'accepted') {
      return {
        text: `Revision video has not been produced — the proposed change was rejected (${latestAttempt.comparisonOutcome}).`,
        isError: false,
      };
    }
    if (activeRun.outcome === 'timeout') {
      return {
        text: 'Revision video has not been produced — the run timed out before revision capture.',
        isError: true,
      };
    }
    if (activeRun.outcome === 'failure') {
      return {
        text: 'Revision video has not been produced — the run ended due to an error.',
        isError: true,
      };
    }
    return {
      text: 'Revision video has not been produced.',
      isError: false,
    };
  };

  const baselinePlaceholder = getBaselinePlaceholderMessage();
  const revisionPlaceholder = getRevisionPlaceholderMessage();

  return (
    <aside className="vp-comparison-panel">
      {/* Before / After Layout Switcher */}
      <div className="vp-card-inner">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            marginBottom: '8px',
            flexWrap: 'wrap',
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
            Layout &amp; Evidence Comparison (PRD §6, §9)
          </span>
          {activeRun && (
            <span
              className={`vp-badge ${
                activeRun.outcome === 'improved'
                  ? 'vp-badge-pass'
                  : activeRun.outcome === 'in_progress'
                    ? 'vp-badge-warn'
                    : activeRun.outcome === 'failure' ||
                        activeRun.outcome === 'timeout'
                      ? 'vp-badge-fail'
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
            disabled={!activeRun || !hasAcceptedRevision}
            title={
              !activeRun
                ? 'Start a run or preview first'
                : !hasAcceptedRevision
                  ? 'No accepted revision layout available yet'
                  : 'Inspect the verified revised layout in the 3D viewport'
            }
            onClick={() => onToggleViewingStage('best')}
          >
            {hasAcceptedRevision
              ? 'After (Verified Revision)'
              : 'After (No Accepted Revision)'}
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

      {/* Baseline vs Revision Video Evidence Comparison */}
      <div className="vp-card-inner">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            marginBottom: '8px',
            flexWrap: 'wrap',
          }}
        >
          <h3 style={{ margin: 0, fontSize: '0.84rem' }}>
            Recorded Evidence Clips
          </h3>
          {isFixturePreview && (
            <span className="vp-badge vp-badge-warn">
              Fixture Evidence
            </span>
          )}
        </div>

        <div className="vp-video-comparison-grid">
          {/* Baseline Video Player Slot */}
          <div
            className={`vp-video-slot ${
              viewingStage === 'baseline' && activeRun
                ? 'vp-video-slot-active'
                : ''
            }`}
          >
            <div className="vp-video-slot-header">
              <span className="vp-video-slot-title">Baseline</span>
              <span
                className={`vp-badge ${
                  resolvedBaselineVideoUrl && !baselineMediaError
                    ? 'vp-badge-neutral'
                    : activeRun?.state === 'capturing_baseline' ||
                        isSynthesizingBaseline
                      ? 'vp-badge-warn'
                      : 'vp-badge-neutral'
                }`}
              >
                {resolvedBaselineVideoUrl && !baselineMediaError
                  ? baselineMediaLoading
                    ? 'Loading…'
                    : `${(baselineManifest?.durationSec ?? 0).toFixed(1)}s Tour`
                  : activeRun?.state === 'capturing_baseline' ||
                      isSynthesizingBaseline
                    ? 'Capturing'
                    : 'Unavailable'}
              </span>
            </div>

            <div className="vp-video-frame">
              {resolvedBaselineVideoUrl && !baselineMediaError ? (
                <video
                  ref={baselineVideoRef}
                  src={resolvedBaselineVideoUrl}
                  className="vp-video-element"
                  controls
                  playsInline
                  preload="metadata"
                  aria-label="Baseline venue inspection evidence clip"
                  onLoadStart={() => setBaselineMediaLoading(true)}
                  onLoadedMetadata={(e) => {
                    setBaselineMediaLoading(false);
                    const pending = pendingSeekRef.current.baseline;
                    if (pending && pending.runId === activeRun?.runId) {
                      pendingSeekRef.current.baseline = null;
                      executeSeekOnVideoElement(e.currentTarget, pending);
                    }
                  }}
                  onCanPlay={() => setBaselineMediaLoading(false)}
                  onError={() => {
                    setBaselineMediaLoading(false);
                    setBaselineMediaError(
                      'This evidence clip could not be loaded.',
                    );
                  }}
                />
              ) : (
                <div
                  className={`vp-video-placeholder ${
                    baselinePlaceholder.isError
                      ? 'vp-video-placeholder-error'
                      : ''
                  }`}
                >
                  <span>{baselinePlaceholder.text}</span>
                </div>
              )}
            </div>

            <div className="vp-video-meta">
              <span className="mono">
                {baselineManifest?.captureId ?? 'no-capture-id'}
              </span>
              <span className="mono">
                {(
                  activeRun?.baselineSnapshot.sceneHash ??
                  baselineSnapshot.sceneHash
                ).slice(0, 11)}
              </span>
            </div>
          </div>

          {/* Revision Video Player Slot */}
          <div
            className={`vp-video-slot ${
              viewingStage === 'best' && hasAcceptedRevision
                ? 'vp-video-slot-active'
                : ''
            }`}
          >
            <div className="vp-video-slot-header">
              <span className="vp-video-slot-title">Revision</span>
              <span
                className={`vp-badge ${
                  resolvedRevisionVideoUrl &&
                  !revisionMediaError &&
                  hasAcceptedRevision
                    ? 'vp-badge-pass'
                    : activeRun?.state === 'rendering_revision' ||
                        isSynthesizingRevision
                      ? 'vp-badge-warn'
                      : latestAttempt &&
                          latestAttempt.comparisonOutcome !== 'accepted'
                        ? 'vp-badge-fail'
                        : 'vp-badge-neutral'
                }`}
              >
                {resolvedRevisionVideoUrl && !revisionMediaError
                  ? revisionMediaLoading
                    ? 'Loading…'
                    : hasAcceptedRevision
                      ? `Verified · ${(revisionManifest?.durationSec ?? 0).toFixed(1)}s`
                      : 'Unverified'
                  : activeRun?.state === 'rendering_revision' ||
                      isSynthesizingRevision
                    ? 'Capturing'
                    : latestAttempt &&
                        latestAttempt.comparisonOutcome !== 'accepted'
                      ? 'Rejected'
                      : 'Pending'}
              </span>
            </div>

            <div className="vp-video-frame">
              {resolvedRevisionVideoUrl && !revisionMediaError ? (
                <video
                  ref={revisionVideoRef}
                  src={resolvedRevisionVideoUrl}
                  className="vp-video-element"
                  controls
                  playsInline
                  preload="metadata"
                  aria-label="Revision venue inspection evidence clip"
                  onLoadStart={() => setRevisionMediaLoading(true)}
                  onLoadedMetadata={(e) => {
                    setRevisionMediaLoading(false);
                    const pending = pendingSeekRef.current.revision;
                    if (pending && pending.runId === activeRun?.runId) {
                      pendingSeekRef.current.revision = null;
                      executeSeekOnVideoElement(e.currentTarget, pending);
                    }
                  }}
                  onCanPlay={() => setRevisionMediaLoading(false)}
                  onError={() => {
                    setRevisionMediaLoading(false);
                    setRevisionMediaError(
                      'This evidence clip could not be loaded.',
                    );
                  }}
                />
              ) : (
                <div
                  className={`vp-video-placeholder ${
                    revisionPlaceholder.isError
                      ? 'vp-video-placeholder-error'
                      : ''
                  }`}
                >
                  <span>{revisionPlaceholder.text}</span>
                </div>
              )}
            </div>

            <div className="vp-video-meta">
              <span className="mono">
                {revisionManifest?.captureId ?? 'no-revision-clip'}
              </span>
              <span className="mono">
                {hasAcceptedRevision && activeRun
                  ? activeRun.bestSnapshot.sceneHash.slice(0, 11)
                  : 'unchanged'}
              </span>
            </div>
          </div>
        </div>

        {/* Active Seek / Camera Handoff Feedback Banner */}
        {seekFeedback && (
          <div
            role="status"
            aria-live="polite"
            className={`vp-seek-callout ${
              seekFeedback.isWarning ? 'vp-seek-callout-warn' : ''
            }`}
            style={{ marginTop: '8px' }}
          >
            {seekFeedback.message}
          </div>
        )}
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
                {selectedBaselineAtt.visibleSamples}/
                {selectedBaselineAtt.totalSamples} (
                {Math.round(selectedBaselineAtt.sampledVisibility * 100)}%)
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
                border: hasAcceptedRevision
                  ? '1px solid rgba(16, 185, 129, 0.35)'
                  : '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ color: 'var(--text-secondary)', marginBottom: '4px' }}>
                {hasAcceptedRevision ? 'Verified Revision' : 'Baseline Retained'}
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
          {PROFILE_ORDER
            .filter((pid) => (displayedEval.perProfile[pid]?.attendeeCount ?? 0) > 0)
            .map((pid) => {
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
                      {pMetric.clearAndUsableCount}/{pMetric.attendeeCount}{' '}
                      Clear &amp; Usable
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
                      Usable: {pMetric.usableCount}/{pMetric.attendeeCount} ·
                      Clear View: {pMetric.clearViewCount}/
                      {pMetric.attendeeCount}
                    </span>
                    <span className="mono">
                      Mean Vis: {Math.round(baseMetric.meanVisibility * 100)}% →{' '}
                      <strong>
                        {Math.round(bestMetric.meanVisibility * 100)}%
                      </strong>
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

          {latestAttempt.rejectionReasons.length > 0 && (
            <div
              style={{
                marginBottom: '8px',
                padding: '6px 8px',
                borderRadius: 'var(--radius-inner)',
                background: 'var(--color-danger-bg)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                fontSize: '0.73rem',
                color: '#fca5a5',
              }}
            >
              <strong>Rejection reasons:</strong>{' '}
              {latestAttempt.rejectionReasons.join(' · ')}
            </div>
          )}

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
                    gap: '6px',
                    flexWrap: 'wrap',
                  }}
                >
                  <span className="mono">
                    {op.targetType}: {op.targetId}
                  </span>
                  <span className="mono" style={{ color: '#93c5fd' }}>
                    Δpos=[{op.deltaPositionM.join(', ')}]m · Δyaw=
                    {op.deltaYawDeg}°
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

          {/* Argon Evidence-Linked Visual Diagnosis (Baseline Findings) */}
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
                Baseline Critique Findings (Click to seek Baseline clip &amp; 3D
                POV):
              </div>
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}
              >
                {latestAttempt.patch.diagnosis.map((f, idx) => {
                  const findingKey = `baseline_${latestAttempt.attemptIndex}_${idx}`;
                  const isSelected = selectedFindingKey === findingKey;
                  const resolvedPreview = activeRun
                    ? resolveFindingNavigation({
                        runId: activeRun.runId,
                        clipPhase: 'baseline',
                        finding: f,
                        manifest: baselineManifest,
                        snapshot: activeRun.baselineSnapshot,
                        hasAcceptedRevision,
                      })
                    : null;

                  return (
                    <button
                      key={findingKey}
                      type="button"
                      aria-pressed={isSelected}
                      className={`vp-finding-btn ${
                        isSelected ? 'vp-finding-btn-selected' : ''
                      }`}
                      onClick={() =>
                        handleSelectFinding(f, 'baseline', findingKey)
                      }
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          width: '100%',
                          gap: '6px',
                          flexWrap: 'wrap',
                          fontSize: '0.71rem',
                          color: '#93c5fd',
                        }}
                      >
                        <span className="mono">
                          [Baseline] {f.viewId} @{' '}
                          {Number.isFinite(f.timestampSec)
                            ? `${f.timestampSec.toFixed(1)}s`
                            : 'invalid'}
                        </span>
                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                          {resolvedPreview?.cameraPose ? (
                            <span className="vp-badge vp-badge-neutral">
                              {resolvedPreview.cameraPose.kind === 'overview'
                                ? '3D Overview'
                                : `3D POV: ${resolvedPreview.cameraPose.attendeeId}`}
                            </span>
                          ) : (
                            <span className="vp-badge vp-badge-warn">
                              Video Only (No 3D POV)
                            </span>
                          )}
                          {f.isUnmeasuredVisualNote && (
                            <span className="vp-badge vp-badge-warn">
                              Unmeasured Visual Note
                            </span>
                          )}
                        </div>
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
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Final Reinspection Findings (Revision Clip Findings) */}
      {activeRun?.finalInspection && (
        <div className="vp-card-inner">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              marginBottom: '6px',
            }}
          >
            <h3 style={{ margin: 0, fontSize: '0.84rem' }}>
              Final Visual Reinspection (PRD §7 Step 6)
            </h3>
            <span className="vp-badge vp-badge-pass">Revision Evidence</span>
          </div>
          <p
            style={{
              margin: '0 0 8px 0',
              fontSize: '0.75rem',
              color: '#34d399',
            }}
          >
            {activeRun.finalInspection.remainingIssuesSummary}
          </p>
          <div
            style={{
              fontSize: '0.73rem',
              fontWeight: 600,
              marginBottom: '6px',
              color: 'var(--text-secondary)',
            }}
          >
            Revision Findings (Click to seek Revision clip &amp; 3D POV):
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {activeRun.finalInspection.findings.map((f, idx) => {
              const findingKey = `revision_final_${idx}`;
              const isSelected = selectedFindingKey === findingKey;
              const resolvedPreview = resolveFindingNavigation({
                runId: activeRun.runId,
                clipPhase: 'revision',
                finding: f,
                manifest: revisionManifest,
                snapshot: activeRun.bestSnapshot,
                hasAcceptedRevision,
              });

              return (
                <button
                  key={findingKey}
                  type="button"
                  aria-pressed={isSelected}
                  className={`vp-finding-btn ${
                    isSelected ? 'vp-finding-btn-selected' : ''
                  }`}
                  onClick={() => handleSelectFinding(f, 'revision', findingKey)}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      width: '100%',
                      gap: '6px',
                      flexWrap: 'wrap',
                      fontSize: '0.71rem',
                      color: '#34d399',
                    }}
                  >
                    <span className="mono">
                      [Revision] {f.viewId} @{' '}
                      {Number.isFinite(f.timestampSec)
                        ? `${f.timestampSec.toFixed(1)}s`
                        : 'invalid'}
                    </span>
                    {resolvedPreview.cameraPose ? (
                      <span className="vp-badge vp-badge-pass">
                        {resolvedPreview.cameraPose.kind === 'overview'
                          ? '3D Overview'
                          : `3D POV: ${resolvedPreview.cameraPose.attendeeId}`}
                      </span>
                    ) : (
                      <span className="vp-badge vp-badge-warn">
                        Video Only (No 3D POV)
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
              );
            })}
          </div>
        </div>
      )}
    </aside>
  );
}
