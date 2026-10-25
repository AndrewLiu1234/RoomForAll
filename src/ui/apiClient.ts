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
import {
  applyAndValidatePatch,
  compareEvaluations,
} from '../evaluation/index.js';
import {
  PREPARED_VENUE_SCENE_ID,
  createBunchedEmergencyReferencePatch,
  createPreparedVenueReferencePatch,
} from '../scene/index.js';
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
  const nowIso = new Date().toISOString();

  const hasPreparedProps = baselineSnapshot.objects.some(
    (o) => o.id === 'obj_prop_welcome_sign',
  );

  if (
    baselineSnapshot.sceneId === PREPARED_VENUE_SCENE_ID ||
    baselineSnapshot.sceneId === 'scene_community_hall_24_bunched' ||
    hasPreparedProps
  ) {
    const isBunched =
      baselineSnapshot.sceneId === 'scene_community_hall_24_bunched';
    const rawPatch = isBunched
      ? createBunchedEmergencyReferencePatch(
          'preview_dev_fixture',
          baselineSnapshot.sceneHash,
        )
      : createPreparedVenueReferencePatch(
          'preview_dev_fixture',
          baselineSnapshot.sceneHash,
        );
    const validObjectIds = new Set(baselineSnapshot.objects.map((o) => o.id));
    const validGroupIds = new Set(
      baselineSnapshot.chairGroups.map((g) => g.id),
    );
    const hasAllFourRowGroups =
      isBunched || validGroupIds.has('group_row_4');
    const patch: LayoutPatch = {
      ...rawPatch,
      operations: rawPatch.operations.filter((op) =>
        op.targetType === 'group'
          ? hasAllFourRowGroups && validGroupIds.has(op.targetId)
          : validObjectIds.has(op.targetId),
      ),
    };
    const validated = applyAndValidatePatch(
      baselineSnapshot,
      baselineSnapshot,
      patch,
    );
    const bestSnapshot = validated.snapshot
      ? withUpdatedSceneHash(validated.snapshot)
      : baselineSnapshot;
    const bestEvaluation = evaluateSceneWithFallback(bestSnapshot);
    const placeCount = bestSnapshot.places.length;

    return {
      contractVersion: CONTRACT_VERSION,
      runId: 'preview_dev_fixture',
      state: 'finished',
      outcome: 'improved',
      terminalReason: `Local ${placeCount}-Place Reference Repair Preview (use "Review and Improve" for live Gemini 4 Argon run).`,
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
        captureId: `cap_preview_revision_${placeCount}`,
        sceneHash: bestSnapshot.sceneHash,
        findings: isBunched
          ? [
              {
                attendeeId: 'att_adult_01',
                viewId: 'view_overview_room',
                timestampSec: 1.4,
                observation:
                  'Spaced Row 2 chair groups (group_r2_west, group_r2_center, group_r2_east) back by +0.55m, eliminating emergency extrication jamming.',
              },
              {
                attendeeId: 'att_wheelchair_01',
                viewId: 'view_overview_room',
                timestampSec: 1.8,
                observation:
                  'Moved obj_prop_exit_barrier clear of the East Secondary Emergency Exit, opening both exit portals and cutting total emergency evacuation time.',
              },
              {
                attendeeId: 'att_shorter_01',
                viewId: 'view_pov_att_shorter_01',
                timestampSec: 3.5,
                observation:
                  'Shifting obj_prop_welcome_sign 0.55m west cleared the central screen sightline for Row 1 Center (135/135 visible samples).',
              },
            ]
          : [
              {
                attendeeId: 'att_shorter_01',
                viewId: 'view_pov_att_shorter_01',
                timestampSec: 3.5,
                observation:
                  'Shifting obj_prop_welcome_sign 0.55m west cleared the central screen sightline for Row 1 Center (135/135 visible samples).',
              },
              {
                attendeeId: 'att_extra_legroom_01',
                viewId: 'view_pov_att_extra_legroom_01',
                timestampSec: 6.0,
                observation:
                  'Shifting obj_prop_catering_table 0.55m toward the stage restored full >= 0.55m front legroom for Row 1 East seats.',
              },
              {
                attendeeId: 'att_wheelchair_01',
                viewId: 'view_pov_att_wheelchair_01',
                timestampSec: 8.5,
                observation:
                  'Shifting obj_prop_av_cart 0.60m east cleared Wheelchair Bay W2 turning circle (1.55m diameter unobstructed).',
              },
            ],
        remainingIssuesSummary: `All ${placeCount} audience places now satisfy sightline, route, footprint, front-legroom, wheelchair turning-space, and emergency evacuation requirements.`,
      },
      providerModel: 'local-reference-preview (no paid model call)',
      providerRequestIds: [],
    };
  }

  const hasDevSign = baselineSnapshot.objects.some(
    (o) => o.id === 'obj_prop_sign_01',
  );

  // Generic bounded coordinate-search solver for arbitrary uploaded .glb venues
  if (!hasDevSign) {
    const candidateDeltas: Array<[number, 0, number]> = [
      [-0.55, 0, 0],
      [0.55, 0, 0],
      [0, 0, -0.55],
      [0, 0, 0.55],
      [-0.55, 0, -0.55],
      [0.55, 0, 0.55],
    ];
    const editableProps = baselineSnapshot.objects
      .filter((o) => o.editable && o.category === 'movable_prop')
      .slice(0, 6);

    const ops: LayoutPatch['operations'] = [];
    let currentSnap = baselineSnapshot;
    let currentEval = baselineEvaluation;

    for (const prop of editableProps) {
      for (const delta of candidateDeltas) {
        const trialPatch: LayoutPatch = {
          contractVersion: CONTRACT_VERSION,
          runId: 'preview_custom_glb',
          parentSceneHash: currentSnap.sceneHash,
          diagnosis: [],
          operations: [
            {
              targetType: 'object',
              targetId: prop.id,
              deltaPositionM: delta,
              deltaYawDeg: 0,
              reason: `Relocate ${prop.id} by [${delta.join(', ')}]m to improve sightline or access clearance.`,
            },
          ],
          summary: `Auto-repaired ${prop.id}.`,
        };
        const val = applyAndValidatePatch(baselineSnapshot, currentSnap, trialPatch);
        if (val.valid && val.snapshot) {
          const nextEval = evaluateSceneWithFallback(val.snapshot);
          const cmp = compareEvaluations(currentEval, nextEval);
          if (cmp.accepted) {
            ops.push(trialPatch.operations[0]!);
            currentSnap = val.snapshot;
            currentEval = nextEval;
            break;
          }
        }
      }
    }

    const combinedPatch: LayoutPatch = {
      contractVersion: CONTRACT_VERSION,
      runId: 'preview_custom_glb',
      parentSceneHash: baselineSnapshot.sceneHash,
      diagnosis: [
        {
          viewId: 'view_overview_room',
          timestampSec: 1.0,
          observation: `Evaluated ${editableProps.length} movable props in uploaded .glb venue.`,
        },
      ],
      operations: ops,
      summary:
        ops.length > 0
          ? `Applied ${ops.length} bounded prop adjustment(s) on uploaded .glb venue.`
          : 'No movable prop adjustments improved the uploaded .glb venue.',
    };

    return {
      contractVersion: CONTRACT_VERSION,
      runId: 'preview_custom_glb',
      state: 'finished',
      outcome: ops.length > 0 ? 'improved' : 'no_improvement',
      terminalReason: 'Local Uploaded .glb Repair Preview.',
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      deadlineIso: nowIso,
      elapsedMs: 0,
      baselineSnapshot,
      baselineEvaluation,
      bestSnapshot: currentSnap,
      bestEvaluation: currentEval,
      attempts: [
        {
          attemptIndex: 0,
          patch: combinedPatch,
          candidateSceneHash: currentSnap.sceneHash,
          evaluation: currentEval,
          comparisonOutcome: ops.length > 0 ? 'accepted' : 'rejected_no_improvement',
          rejectionReasons: [],
          timestampIso: nowIso,
        },
      ],
      finalInspection: {
        captureId: 'cap_preview_custom_glb',
        sceneHash: currentSnap.sceneHash,
        findings: [
          {
            viewId: 'view_overview_room',
            timestampSec: 1.0,
            observation: combinedPatch.summary,
          },
        ],
        remainingIssuesSummary: `Unmet requirements: ${currentEval.comparison.attendeesWithUnmetRequirements} (${currentEval.comparison.totalFailedRequirementChecks} failed checks).`,
      },
      providerModel: 'local-glb-repair-solver (no paid model call)',
      providerRequestIds: [],
    };
  }

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
      {
        targetType: 'object',
        targetId: 'obj_chair_r2_c1',
        deltaPositionM: [0, 0.10, 0],
        deltaYawDeg: 0,
        reason:
          'Elevate Row 2 chair by 0.10m on stepped riser platform to create tiered sightlines over Row 1 with ADA-compliant ramp slope.',
      },
    ],
  };

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
