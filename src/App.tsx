import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createDevFixtureSnapshot,
  type CaptureTourSpec,
  type Evaluation,
  type EvidenceFinding,
  type ProfileId,
  type ProfileRequirements,
  type RunRecord,
  type SceneSnapshot,
} from './shared/index.js';
import {
  ComparisonPanel,
  ProfileEditorModal,
  RosterPanel,
  RunProgressBanner,
  VenueViewportStage,
  captureEvidenceWithFallback,
  createLocalFixtureRepairPreviewRun,
  evaluateSceneWithFallback,
  getRunStatus,
  postCreateRun,
  postPreview,
  uploadRunEvidence,
} from './ui/index.js';

export function App(): React.ReactElement {
  const initialSnapshot = useMemo(() => createDevFixtureSnapshot(), []);
  const [baselineSnapshot, setBaselineSnapshot] =
    useState<SceneSnapshot>(initialSnapshot);
  const [baselineEvaluation, setBaselineEvaluation] = useState<Evaluation>(() =>
    evaluateSceneWithFallback(initialSnapshot),
  );

  // Default to Sam (Shorter Viewer at R2-1) so the initial obstruction is immediately visible
  const [selectedAttendeeId, setSelectedAttendeeId] = useState<string>(
    () =>
      initialSnapshot.roster.find((a) => a.profileId === 'shorter_seated')
        ?.attendeeId ??
      initialSnapshot.roster[0]?.attendeeId ??
      '',
  );

  const [viewMode, setViewMode] = useState<'overview' | 'attendee_pov'>(
    'overview',
  );
  const [showSightlineOverlays, setShowSightlineOverlays] =
    useState<boolean>(true);
  const [viewingStage, setViewingStage] = useState<'baseline' | 'best'>(
    'baseline',
  );
  const [isProfileModalOpen, setIsProfileModalOpen] = useState<boolean>(false);

  const [activeRun, setActiveRun] = useState<RunRecord | null>(null);
  const [isCapturingClip, setIsCapturingClip] = useState<boolean>(false);
  const [captureStatusText, setCaptureStatusText] = useState<string | null>(
    null,
  );
  const [errorText, setErrorText] = useState<string | null>(null);

  // Track which captureIds have already been recorded & uploaded in this session (single-upload guarantee)
  const handledCaptureIdsRef = useRef<Set<string>>(new Set());

  const isFrozen = activeRun !== null;

  const displayedSnapshot =
    viewingStage === 'best' && activeRun
      ? activeRun.bestSnapshot
      : activeRun
        ? activeRun.baselineSnapshot
        : baselineSnapshot;

  const displayedEvaluation =
    viewingStage === 'best' && activeRun
      ? activeRun.bestEvaluation
      : activeRun
        ? activeRun.baselineEvaluation
        : baselineEvaluation;

  // Poll GET /api/runs/:id while a live run is active
  useEffect(() => {
    if (
      !activeRun ||
      activeRun.runId === 'preview_dev_fixture' ||
      activeRun.state === 'finished'
    ) {
      return;
    }

    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const res = await getRunStatus(activeRun.runId);
        if (cancelled) return;
        setActiveRun(res.run);
        if (
          res.run.bestSnapshot.sceneHash !== res.run.baselineSnapshot.sceneHash
        ) {
          setViewingStage('best');
        }
      } catch (err) {
        if (cancelled) return;
        setErrorText(
          err instanceof Error ? err.message : 'Failed to poll run status.',
        );
      }
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeRun?.runId, activeRun?.state]);

  // Automatically record & upload browser video evidence when pendingCapture appears
  useEffect(() => {
    const pending: CaptureTourSpec | undefined = activeRun?.pendingCapture;
    if (!activeRun || !pending) return;
    if (handledCaptureIdsRef.current.has(pending.captureId)) return;

    handledCaptureIdsRef.current.add(pending.captureId);
    let cancelled = false;

    const runCaptureAndUpload = async (): Promise<void> => {
      setIsCapturingClip(true);
      setErrorText(null);
      setCaptureStatusText(
        `Recording ${pending.phase} inspection video (${pending.captureId}) on dedicated 512×512 canvas…`,
      );

      try {
        const { videoBlob, manifest } = await captureEvidenceWithFallback(
          pending.snapshot,
          pending,
        );
        if (cancelled) return;

        setCaptureStatusText(
          `Uploading ${pending.phase} video (${(videoBlob.size / 1024).toFixed(1)} KB, ${manifest.mimeType}) to POST /api/runs/${activeRun.runId}/evidence…`,
        );

        await uploadRunEvidence(activeRun.runId, videoBlob, manifest);
        if (cancelled) return;

        const refreshed = await getRunStatus(activeRun.runId);
        if (cancelled) return;
        setActiveRun(refreshed.run);
        setCaptureStatusText(
          `Uploaded ${pending.phase} evidence (${manifest.captureId}). Waiting for Argon controller (${refreshed.run.state})…`,
        );
      } catch (err) {
        if (cancelled) return;
        handledCaptureIdsRef.current.delete(pending.captureId);
        setErrorText(
          err instanceof Error
            ? err.message
            : 'Failed to capture or upload evidence.',
        );
      } finally {
        if (!cancelled) {
          setIsCapturingClip(false);
        }
      }
    };

    void runCaptureAndUpload();

    return () => {
      cancelled = true;
    };
  }, [activeRun?.runId, activeRun?.pendingCapture?.captureId]);

  const handleSelectAttendee = (attendeeId: string): void => {
    setSelectedAttendeeId(attendeeId);
  };

  const handleChangePlaceAssignment = async (
    attendeeId: string,
    newPlaceId: string,
  ): Promise<void> => {
    if (isFrozen) return;
    setErrorText(null);

    // If another attendee currently occupies `newPlaceId`, swap their places so assignments remain 1-to-1
    const currentMember = baselineSnapshot.roster.find(
      (a) => a.attendeeId === attendeeId,
    );
    const otherOccupant = baselineSnapshot.roster.find(
      (a) => a.assignedPlaceId === newPlaceId && a.attendeeId !== attendeeId,
    );

    const updatedRoster = baselineSnapshot.roster.map((member) => {
      if (member.attendeeId === attendeeId) {
        return { ...member, assignedPlaceId: newPlaceId };
      }
      if (
        otherOccupant &&
        currentMember &&
        member.attendeeId === otherOccupant.attendeeId
      ) {
        return { ...member, assignedPlaceId: currentMember.assignedPlaceId };
      }
      return member;
    });

    try {
      const preview = await postPreview({
        snapshot: baselineSnapshot,
        roster: updatedRoster,
      });
      setBaselineSnapshot(preview.snapshot);
      setBaselineEvaluation(preview.evaluation);
    } catch (err) {
      setErrorText(
        err instanceof Error ? err.message : 'Failed to update place preview.',
      );
    }
  };

  const handleSaveProfiles = async (
    updatedProfiles: Record<ProfileId, ProfileRequirements>,
  ): Promise<void> => {
    if (isFrozen) return;
    setErrorText(null);
    try {
      const preview = await postPreview({
        snapshot: baselineSnapshot,
        profiles: updatedProfiles,
      });
      setBaselineSnapshot(preview.snapshot);
      setBaselineEvaluation(preview.evaluation);
    } catch (err) {
      setErrorText(
        err instanceof Error
          ? err.message
          : 'Failed to update profile requirements.',
      );
    }
  };

  const handleStartLiveRun = async (): Promise<void> => {
    setErrorText(null);
    setCaptureStatusText('Starting live run via POST /api/runs…');
    try {
      const created = await postCreateRun(baselineSnapshot);
      const statusRes = await getRunStatus(created.runId);
      setViewingStage('baseline');
      setActiveRun(statusRes.run);
    } catch (err) {
      setCaptureStatusText(null);
      setErrorText(
        err instanceof Error ? err.message : 'Could not start live run.',
      );
    }
  };

  const handlePreviewLocalRepair = (): void => {
    setErrorText(null);
    const previewRun = createLocalFixtureRepairPreviewRun(baselineSnapshot);
    setActiveRun(previewRun);
    setViewingStage('best');
    setCaptureStatusText(
      'Showing Local Dev Fixture Repair Preview (obj_prop_sign_01 shifted -0.55m X; Sam R2-1 visibility 67/135 → 135/135).',
    );
  };

  const handleResetToBaseline = (): void => {
    setActiveRun(null);
    setViewingStage('baseline');
    setCaptureStatusText(null);
    setErrorText(null);
  };

  const handleJumpToFinding = (finding: EvidenceFinding): void => {
    if (finding.attendeeId) {
      setSelectedAttendeeId(finding.attendeeId);
      setViewMode('attendee_pov');
    } else {
      setViewMode('overview');
    }
  };

  return (
    <div className="vp-shell">
      <RunProgressBanner
        activeRun={activeRun}
        isCapturingClip={isCapturingClip}
        captureStatusText={captureStatusText}
        errorText={errorText}
        onStartLiveRun={() => void handleStartLiveRun()}
        onPreviewLocalRepair={handlePreviewLocalRepair}
        onResetToBaseline={handleResetToBaseline}
      />

      <RosterPanel
        snapshot={displayedSnapshot}
        evaluation={displayedEvaluation}
        selectedAttendeeId={selectedAttendeeId}
        isFrozen={isFrozen}
        onSelectAttendee={handleSelectAttendee}
        onChangePlaceAssignment={(attId, placeId) =>
          void handleChangePlaceAssignment(attId, placeId)
        }
        onOpenProfileEditor={() => setIsProfileModalOpen(true)}
      />

      <main
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        <VenueViewportStage
          snapshot={displayedSnapshot}
          selectedAttendeeId={selectedAttendeeId}
          viewMode={viewMode}
          onSelectAttendee={handleSelectAttendee}
          evaluation={displayedEvaluation}
          showSightlineOverlays={showSightlineOverlays}
          onToggleViewMode={setViewMode}
          onToggleSightlineOverlays={() =>
            setShowSightlineOverlays((prev) => !prev)
          }
        />
      </main>

      <ComparisonPanel
        baselineSnapshot={baselineSnapshot}
        baselineEvaluation={baselineEvaluation}
        activeRun={activeRun}
        viewingStage={viewingStage}
        selectedAttendeeId={selectedAttendeeId}
        onToggleViewingStage={setViewingStage}
        onJumpToFinding={handleJumpToFinding}
      />

      {isProfileModalOpen && (
        <ProfileEditorModal
          profiles={baselineSnapshot.profiles}
          isFrozen={isFrozen}
          onSaveProfiles={(updated) => void handleSaveProfiles(updated)}
          onClose={() => setIsProfileModalOpen(false)}
        />
      )}
    </div>
  );
}

export default App;
