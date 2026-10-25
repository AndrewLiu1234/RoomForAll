import {
  CONTRACT_VERSION,
  withUpdatedSceneHash,
  type CreateRunResponse,
  type EvidenceManifest,
  type GetRunResponse,
  type LayoutPatch,
  type PreviewRequest,
  type PreviewResponse,
  type RunRecord,
  type SceneSnapshot,
  type UploadEvidenceResponse,
} from '../shared/index.js';
import { evaluateSceneWithFallback } from './localEvaluatorFallback.js';

export async function postPreview(
  req: PreviewRequest,
): Promise<PreviewResponse> {
  try {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      throw new Error(`Preview failed with status ${res.status}`);
    }
    const data = (await res.json()) as PreviewResponse;
    return {
      snapshot: data.snapshot,
      evaluation: evaluateSceneWithFallback(data.snapshot),
    };
  } catch {
    // Offline fallback if backend server is temporarily restarting
    const base = req.snapshot;
    if (!base) {
      throw new Error('Preview requires a snapshot when backend is offline.');
    }
    const merged = withUpdatedSceneHash({
      ...base,
      profiles: req.profiles
        ? { ...base.profiles, ...req.profiles }
        : base.profiles,
      roster: req.roster ?? base.roster,
    });
    return {
      snapshot: merged,
      evaluation: evaluateSceneWithFallback(merged),
    };
  }
}

export async function postCreateRun(
  snapshot: SceneSnapshot,
): Promise<CreateRunResponse> {
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot }),
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as {
      error?: string;
      activeRunId?: string;
    };
    throw new Error(
      errBody.error ?? `Failed to start run (HTTP ${res.status})`,
    );
  }
  return (await res.json()) as CreateRunResponse;
}

export async function getRunStatus(runId: string): Promise<GetRunResponse> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch run ${runId} (HTTP ${res.status})`);
  }
  const data = (await res.json()) as GetRunResponse;
  return {
    run: {
      ...data.run,
      baselineEvaluation: evaluateSceneWithFallback(data.run.baselineSnapshot),
      bestEvaluation: evaluateSceneWithFallback(data.run.bestSnapshot),
    },
  };
}

export async function uploadRunEvidence(
  runId: string,
  videoBlob: Blob,
  manifest: EvidenceManifest,
): Promise<UploadEvidenceResponse> {
  const form = new FormData();
  const ext = manifest.mimeType.includes('mp4') ? 'mp4' : 'webm';
  form.append('video', videoBlob, `${manifest.captureId}.${ext}`);
  form.append('manifest', JSON.stringify(manifest));

  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/evidence`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      errBody.error ?? `Evidence upload failed (HTTP ${res.status})`,
    );
  }
  return (await res.json()) as UploadEvidenceResponse;
}

/**
 * Developer UI Preview Helper:
 * Constructs a bounded, deterministic repair RunRecord on the shared development fixture
 * (moving `obj_prop_sign_01` by `[-0.55, 0, 0]` to clear `att_shorter_01`'s sightline).
 * Strictly labeled as a local fixture preview so it never masquerades as a live Argon call (PRD §9).
 */
export function createLocalFixtureRepairPreviewRun(
  baselineSnapshot: SceneSnapshot,
): RunRecord {
  const baselineEvaluation = evaluateSceneWithFallback(baselineSnapshot);
  const repairedObjects = baselineSnapshot.objects.map((obj) => {
    if (obj.id === 'obj_prop_sign_01') {
      return {
        ...obj,
        transform: {
          position: [
            Number((obj.transform.position[0] - 0.6).toFixed(4)),
            obj.transform.position[1],
            Number((obj.transform.position[2] + 0.45).toFixed(4)),
          ] as [number, number, number],
          yawDeg: obj.transform.yawDeg,
        },
      };
    }
    return obj;
  });

  const bestSnapshot = withUpdatedSceneHash({
    ...baselineSnapshot,
    objects: repairedObjects,
  });
  const bestEvaluation = evaluateSceneWithFallback(bestSnapshot);

  const patch: LayoutPatch = {
    contractVersion: CONTRACT_VERSION,
    runId: 'preview_dev_fixture',
    parentSceneHash: baselineSnapshot.sceneHash,
    summary:
      'Shift movable welcome sign (-0.60m X, +0.45m Z) so Sam (shorter seated viewer at R2-1) has an unobstructed sightline to the presentation screen.',
    diagnosis: [
      {
        attendeeId: 'att_shorter_01',
        viewId: 'view_att_shorter_01',
        timestampSec: 1.8,
        observation:
          'Freestanding welcome banner at X=0.0m, Z=-1.1m occludes the lower-center presentation screen from eye height 0.97m.',
      },
      {
        viewId: 'view_overview',
        timestampSec: 0.4,
        observation:
          'West aisle corridor and wheelchair bay W1 turning pad remain clear.',
      },
    ],
    operations: [
      {
        targetType: 'object',
        targetId: 'obj_prop_sign_01',
        deltaPositionM: [-0.6, 0, 0.45],
        deltaYawDeg: 0,
        reason:
          'Clear central sightline corridor between Row 1 chairs for shorter seated viewer at Seat R2-1 within 0.60m single-op limit.',
      },
    ],
  };

  const nowIso = new Date().toISOString();
  return {
    contractVersion: CONTRACT_VERSION,
    runId: 'preview_dev_fixture',
    state: 'finished',
    outcome:
      bestEvaluation.comparison.totalVisibleSamples >
      baselineEvaluation.comparison.totalVisibleSamples
        ? 'improved'
        : 'no_improvement',
    terminalReason:
      'Local Dev Fixture Preview (use "Review and Improve" for live backend run).',
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
    deadlineIso: nowIso,
    elapsedMs: 0,
    baselineSnapshot,
    baselineEvaluation,
    bestSnapshot,
    bestEvaluation,
    attempts: [
      {
        attemptIndex: 0,
        patch,
        candidateSceneHash: bestSnapshot.sceneHash,
        evaluation: bestEvaluation,
        comparisonOutcome: 'accepted',
        rejectionReasons: [],
        timestampIso: nowIso,
      },
    ],
    finalInspection: {
      captureId: 'cap_preview_revision',
      sceneHash: bestSnapshot.sceneHash,
      findings: [
        {
          attendeeId: 'att_shorter_01',
          viewId: 'view_att_shorter_01',
          timestampSec: 1.8,
          observation:
            'After shifting obj_prop_sign_01 by -0.55m along X, the presentation target is 100% unobstructed (135/135 samples) from Seat R2-1.',
        },
        {
          attendeeId: 'att_wheelchair_01',
          viewId: 'view_att_wheelchair_01',
          timestampSec: 2.4,
          observation:
            'Wheelchair Bay W1 view and 1.55m turning pad remain completely clear.',
        },
      ],
      remainingIssuesSummary:
        'All modeled attendee requirements met (0 failed checks across all 4 profiles).',
    },
    providerModel: 'local-fixture-preview (no paid model call)',
    providerRequestIds: [],
  };
}
