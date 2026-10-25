import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSION,
  RUN_TIMING,
  createDevFixtureSnapshot,
  withUpdatedSceneHash,
  type BlindCritiquePayload,
  type CreateRunResponse,
  type Evaluation,
  type EvidenceManifest,
  type GetRunResponse,
  type LayoutPatch,
  type PreviewResponse,
  type RunState,
  type SceneSnapshot,
  type UploadEvidenceResponse,
} from '../../src/shared/index.js';
import { evaluateScene } from '../../src/evaluation/index.js';
import {
  buildCaptureTourSpec,
  createApp,
  createGeminiArgonAdapter,
  type ArgonProviderAdapter,
  type CritiqueAndProposePatchInput,
  type EvaluatorAdapter,
  type InspectRevisionInput,
} from '../../src/server/index.js';

interface TestHarness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startTestServer(
  options: Parameters<typeof createApp>[0],
): Promise<TestHarness> {
  const app = createApp(options);
  const server: Server = await new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function uploadMultipartEvidence(
  baseUrl: string,
  runId: string,
  manifest: EvidenceManifest,
  videoBuffer: Buffer,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  if (videoBuffer.byteLength > 0) {
    const blob = new Blob([new Uint8Array(videoBuffer)], {
      type: manifest.mimeType,
    });
    form.append('video', blob, `${manifest.captureId}.webm`);
  } else {
    const emptyBlob = new Blob([], { type: manifest.mimeType });
    form.append('video', emptyBlob, `${manifest.captureId}.webm`);
  }

  const res = await fetch(`${baseUrl}/api/runs/${runId}/evidence`, {
    method: 'POST',
    body: form,
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

/**
 * Deterministic test evaluator adapter that accurately simulates moving
 * `obj_prop_sign_01` out of `att_shorter_01`'s sightline on `devFixture`,
 * allowing `tests/server/` to verify all Workstream C controller paths
 * independently of whether Workstream B's full raycaster is merged yet.
 */
function createRealisticEvaluatorAdapter(): EvaluatorAdapter {
  return {
    evaluateScene(snapshot: SceneSnapshot): Evaluation {
      const baseEval = evaluateScene(snapshot);
      const sign = snapshot.objects.find((o) => o.id === 'obj_prop_sign_01');
      const shorter = baseEval.attendees['att_shorter_01'];

      // If sign is still near X = 0.0, shorter viewer is occluded
      const isSignBlocking =
        sign !== undefined && Math.abs(sign.transform.position[0]) < 0.4;

      if (shorter && isSignBlocking) {
        shorter.visibleSamples = 60;
        shorter.sampledVisibility = 60 / 135;
        shorter.isViewClear = false;
        shorter.clearAndUsable = false;
        shorter.failedRequirements = ['clear_sightline'];
        shorter.primaryBlockerIds = ['obj_prop_sign_01'];

        baseEval.allModeledRequirementsMet = false;
        baseEval.perProfile.shorter_seated = {
          ...baseEval.perProfile.shorter_seated,
          clearViewCount: 0,
          clearAndUsableCount: 0,
          meanVisibility: 60 / 135,
          unmetRequirementCount: 1,
          failedCheckCount: 1,
        };
        baseEval.comparison = {
          attendeesWithUnmetRequirements: 1,
          totalFailedRequirementChecks: 1,
          worstProfileMeanVisibility: 60 / 135,
          totalVisibleSamples: 135 * 3 + 60,
        };
      }

      return baseEval;
    },

    applyAndValidatePatch(baselineSnapshot, currentSnapshot, patch) {
      if (patch.parentSceneHash !== currentSnapshot.sceneHash) {
        return {
          valid: false,
          errors: [
            {
              code: 'STALE_SCENE_HASH',
              message: `Patch parentSceneHash (${patch.parentSceneHash}) does not match current sceneHash (${currentSnapshot.sceneHash}).`,
            },
          ],
        };
      }

      if (patch.operations.length > 6) {
        return {
          valid: false,
          errors: [
            {
              code: 'PATCH_LIMIT_EXCEEDED',
              message: 'Exceeded maximum of 6 operations.',
            },
          ],
        };
      }

      const nextSnapshot = structuredClone(currentSnapshot);

      for (const op of patch.operations) {
        if (op.targetType === 'object') {
          const obj = nextSnapshot.objects.find((o) => o.id === op.targetId);
          if (!obj) {
            return {
              valid: false,
              errors: [
                {
                  code: 'MISSING_REFERENCE',
                  message: `Target object ${op.targetId} not found.`,
                  targetId: op.targetId,
                },
              ],
            };
          }
          if (!obj.editable) {
            return {
              valid: false,
              errors: [
                {
                  code: 'FIXED_OBJECT_MODIFIED',
                  message: `Object ${op.targetId} is fixed and cannot be modified.`,
                  targetId: op.targetId,
                },
              ],
            };
          }

          obj.transform.position = [
            Number((obj.transform.position[0] + op.deltaPositionM[0]).toFixed(4)),
            obj.transform.position[1],
            Number((obj.transform.position[2] + op.deltaPositionM[2]).toFixed(4)),
          ];
          obj.transform.yawDeg = Number(
            (obj.transform.yawDeg + op.deltaYawDeg).toFixed(4),
          );

          const baseObj = baselineSnapshot.objects.find(
            (o) => o.id === op.targetId,
          );
          if (baseObj) {
            const dx =
              obj.transform.position[0] - baseObj.baselineTransform.position[0];
            const dz =
              obj.transform.position[2] - baseObj.baselineTransform.position[2];
            if (Math.hypot(dx, dz) > 1.5 + 1e-6) {
              return {
                valid: false,
                errors: [
                  {
                    code: 'OUT_OF_BOUNDS',
                    message: `Object ${op.targetId} exceeded 1.50m total displacement from baseline.`,
                    targetId: op.targetId,
                  },
                ],
              };
            }
          }
        }
      }

      return {
        valid: true,
        errors: [],
        snapshot: withUpdatedSceneHash(nextSnapshot),
      };
    },

    compareEvaluations(baselineEval, candidateEval) {
      if (!candidateEval.isValidStructure) {
        return {
          accepted: false,
          outcome: 'rejected_structural',
          reasons: candidateEval.structuralErrors.map((e) => e.message),
        };
      }
      if (candidateEval.sceneHash === baselineEval.sceneHash) {
        return {
          accepted: false,
          outcome: 'rejected_no_improvement',
          reasons: ['Candidate scene hash is identical to baseline.'],
        };
      }

      // Check per-profile non-regression
      for (const pid of Object.keys(baselineEval.perProfile) as Array<
        keyof typeof baselineEval.perProfile
      >) {
        const baseProf = baselineEval.perProfile[pid];
        const candProf = candidateEval.perProfile[pid];
        if (
          candProf.clearAndUsableCount < baseProf.clearAndUsableCount ||
          candProf.meanVisibility + 1e-6 < baseProf.meanVisibility
        ) {
          return {
            accepted: false,
            outcome: 'rejected_regression',
            reasons: [`Profile ${pid} regressed in visibility or usability.`],
          };
        }
      }

      if (
        candidateEval.comparison.attendeesWithUnmetRequirements <
          baselineEval.comparison.attendeesWithUnmetRequirements ||
        candidateEval.comparison.totalVisibleSamples >
          baselineEval.comparison.totalVisibleSamples
      ) {
        return {
          accepted: true,
          outcome: 'accepted',
          reasons: [],
        };
      }

      return {
        accepted: false,
        outcome: 'rejected_no_improvement',
        reasons: ['Candidate evaluation did not improve lexicographic metrics.'],
      };
    },
  };
}

describe('Stream C — Argon Controller, Provider Adapter, State Machine & Persistence', () => {
  let tempRunsDir: string;
  let harness: TestHarness | null = null;

  beforeEach(async () => {
    tempRunsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'venuepilot-stream-c-test-'),
    );
  });

  afterEach(async () => {
    if (harness) {
      await harness.close();
      harness = null;
    }
    await fs.rm(tempRunsDir, { recursive: true, force: true });
  });

  it('1. POST /api/preview returns deterministic sceneHash and Evaluation with zero model calls', async () => {
    let modelCalls = 0;
    const spyProvider: ArgonProviderAdapter = {
      modelName: 'mock-argon',
      async critiqueAndProposePatch() {
        modelCalls += 1;
        throw new Error('Should not be called in /api/preview');
      },
      async inspectRevision() {
        modelCalls += 1;
        throw new Error('Should not be called in /api/preview');
      },
    };

    harness = await startTestServer({
      argonProvider: spyProvider,
      runsDir: tempRunsDir,
    });

    const fixture = createDevFixtureSnapshot();
    const res1 = await fetch(`${harness.baseUrl}/api/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        snapshot: fixture,
        profiles: {
          extra_legroom: {
            ...fixture.profiles.extra_legroom,
            requiredFrontLegroomM: 0.6,
          },
        },
      }),
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as PreviewResponse;

    const res2 = await fetch(`${harness.baseUrl}/api/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        snapshot: fixture,
        profiles: {
          extra_legroom: {
            ...fixture.profiles.extra_legroom,
            requiredFrontLegroomM: 0.6,
          },
        },
      }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as PreviewResponse;

    expect(body1.snapshot.sceneHash).toBe(body2.snapshot.sceneHash);
    expect(body1.evaluation.sceneHash).toBe(body1.snapshot.sceneHash);
    expect(
      body1.snapshot.profiles.extra_legroom.requiredFrontLegroomM,
    ).toBe(0.6);
    expect(modelCalls).toBe(0);
  });

  it('2 & 3. Full happy-path state machine transition to outcome="improved" with blind critique verification and disk persistence', async () => {
    const observedStates: RunState[] = [];
    let capturedCall1Input:
      | (Omit<CritiqueAndProposePatchInput, 'blindPayload'> & {
          blindPayload?: BlindCritiquePayload;
        })
      | null = null;
    let capturedCall2Input: InspectRevisionInput | null = null;

    const mockProvider: ArgonProviderAdapter = {
      modelName: 'gemini-2.5-pro-test',
      async critiqueAndProposePatch(input) {
        capturedCall1Input = input;
        return {
          providerModel: 'gemini-2.5-pro-test',
          providerRequestId: 'req_call_1_happy',
          patch: {
            contractVersion: CONTRACT_VERSION,
            runId: input.runId,
            parentSceneHash: input.snapshot.sceneHash,
            diagnosis: [
              {
                attendeeId: 'att_shorter_01',
                viewId: 'view_pov_att_shorter_01',
                timestampSec: 3.2,
                observation:
                  'Movable sign obj_prop_sign_01 blocks the central presentation screen for shorter seated viewer.',
              },
            ],
            operations: [
              {
                targetType: 'object',
                targetId: 'obj_prop_sign_01',
                deltaPositionM: [-0.55, 0, 0],
                deltaYawDeg: 0,
                reason:
                  'Shift welcome sign 0.55m west to clear central sightline.',
              },
            ],
            summary: 'Move welcome sign 0.55m west to clear shorter viewer sightline.',
          },
        };
      },
      async inspectRevision(input) {
        capturedCall2Input = input;
        return {
          providerModel: 'gemini-2.5-pro-test',
          providerRequestId: 'req_call_2_happy',
          report: {
            captureId: input.revisedManifest.captureId,
            sceneHash: input.revisedSnapshot.sceneHash,
            findings: [
              {
                attendeeId: 'att_shorter_01',
                viewId: 'view_pov_att_shorter_01',
                timestampSec: 3.2,
                observation:
                  'Presentation screen is now completely unobstructed from Seat R2-1.',
              },
            ],
            remainingIssuesSummary:
              'All modeled sightline and clearance requirements are satisfied.',
            providerResponseId: 'req_call_2_happy',
          },
        };
      },
    };

    harness = await startTestServer({
      argonProvider: mockProvider,
      runsDir: tempRunsDir,
      evaluator: createRealisticEvaluatorAdapter(),
      onStateTransition: (_runId, state) => {
        observedStates.push(state);
      },
    });

    // Step 1: Start Run
    const startRes = await fetch(`${harness.baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot: createDevFixtureSnapshot() }),
    });
    expect(startRes.status).toBe(201);
    const startData = (await startRes.json()) as CreateRunResponse;
    expect(startData.state).toBe('capturing_baseline');
    expect(startData.pendingCapture).toBeDefined();
    expect(startData.pendingCapture!.phase).toBe('baseline');
    expect(startData.pendingCapture!.keyframes.length).toBeGreaterThanOrEqual(2);
    expect(startData.pendingCapture!.keyframes[0]!.kind).toBe('overview');
    // Shorter viewer has an active sightline failure, so must be prioritized first among POVs
    expect(startData.pendingCapture!.keyframes[1]!.attendeeId).toBe(
      'att_shorter_01',
    );

    const baselineCapture = startData.pendingCapture!;
    const baselineVideoBuffer = Buffer.from('WEBM_BASELINE_VIDEO_BYTES_0123456789');
    const baselineManifest: EvidenceManifest = {
      contractVersion: CONTRACT_VERSION,
      captureId: baselineCapture.captureId,
      runId: startData.runId,
      phase: 'baseline',
      sceneHash: baselineCapture.sceneHash,
      mimeType: 'video/webm',
      byteLength: baselineVideoBuffer.byteLength,
      durationSec: baselineCapture.totalDurationSec,
      widthPx: 512,
      heightPx: 512,
      keyframes: baselineCapture.keyframes,
      recordedAtIso: new Date().toISOString(),
    };

    // Step 2: Upload Baseline Evidence
    const baseUpload = await uploadMultipartEvidence(
      harness.baseUrl,
      startData.runId,
      baselineManifest,
      baselineVideoBuffer,
    );
    expect(baseUpload.status).toBe(200);
    const baseUploadBody = baseUpload.body as unknown as UploadEvidenceResponse;
    expect(baseUploadBody.deduplicated).toBe(false);
    expect(baseUploadBody.state).toBe('rendering_revision');
    expect(baseUploadBody.outcome).toBe('in_progress');

    // Requirement 3: Blind critique verification
    expect(capturedCall1Input).not.toBeNull();
    expect(
      Buffer.compare(capturedCall1Input!.videoBuffer, baselineVideoBuffer),
    ).toBe(0);
    const serializedBlind = JSON.stringify(capturedCall1Input!.blindPayload);
    expect(serializedBlind).not.toContain('sampledVisibility');
    expect(serializedBlind).not.toContain('failedRequirements');
    expect(serializedBlind).not.toContain('primaryBlockerIds');
    expect(serializedBlind).not.toContain('isViewClear');
    expect(serializedBlind).not.toContain('clearAndUsable');
    expect(capturedCall1Input!.blindPayload).toBeDefined();
    expect(
      Object.keys(capturedCall1Input!.blindPayload!),
    ).not.toContain('evaluation');

    // Check run status after baseline upload: pendingCapture should now be revision tour
    const midStatusRes = await fetch(
      `${harness.baseUrl}/api/runs/${startData.runId}`,
    );
    expect(midStatusRes.status).toBe(200);
    const midStatus = (await midStatusRes.json()) as GetRunResponse;
    expect(midStatus.run.state).toBe('rendering_revision');
    expect(midStatus.run.pendingCapture).toBeDefined();
    const revisionCapture = midStatus.run.pendingCapture!;
    expect(revisionCapture.phase).toBe('revision');
    expect(revisionCapture.sceneHash).toBe(midStatus.run.bestSnapshot.sceneHash);
    expect(revisionCapture.sceneHash).not.toBe(
      midStatus.run.baselineSnapshot.sceneHash,
    );
    // Revision tour must preserve exact same viewId/attendee sequence as baseline tour
    expect(revisionCapture.keyframes.map((k) => k.viewId)).toEqual(
      baselineCapture.keyframes.map((k) => k.viewId),
    );

    // Step 3: Upload Revision Evidence
    const revisionVideoBuffer = Buffer.from('WEBM_REVISION_VIDEO_BYTES_9876543210');
    const revisionManifest: EvidenceManifest = {
      contractVersion: CONTRACT_VERSION,
      captureId: revisionCapture.captureId,
      runId: startData.runId,
      phase: 'revision',
      sceneHash: revisionCapture.sceneHash,
      mimeType: 'video/webm',
      byteLength: revisionVideoBuffer.byteLength,
      durationSec: revisionCapture.totalDurationSec,
      widthPx: 512,
      heightPx: 512,
      keyframes: revisionCapture.keyframes,
      recordedAtIso: new Date().toISOString(),
    };

    const revUpload = await uploadMultipartEvidence(
      harness.baseUrl,
      startData.runId,
      revisionManifest,
      revisionVideoBuffer,
    );
    expect(revUpload.status).toBe(200);
    const revUploadBody = revUpload.body as unknown as UploadEvidenceResponse;
    expect(revUploadBody.deduplicated).toBe(false);
    expect(revUploadBody.state).toBe('finished');
    expect(revUploadBody.outcome).toBe('improved');

    // Verify Call 2 received revised video bytes and before/after evaluations
    expect(capturedCall2Input).not.toBeNull();
    expect(
      Buffer.compare(capturedCall2Input!.revisedVideoBuffer, revisionVideoBuffer),
    ).toBe(0);
    expect(capturedCall2Input!.baselineEvaluation.allModeledRequirementsMet).toBe(
      false,
    );
    expect(capturedCall2Input!.revisedEvaluation.allModeledRequirementsMet).toBe(
      true,
    );

    // Verify full state transition sequence
    expect(observedStates).toEqual([
      'capturing_baseline',
      'inspecting_baseline',
      'proposing',
      'verifying',
      'rendering_revision',
      'inspecting_revision',
      'finished',
    ]);

    // Verify final GET /api/runs/:id and disk persistence
    const finalRes = await fetch(
      `${harness.baseUrl}/api/runs/${startData.runId}`,
    );
    const finalData = (await finalRes.json()) as GetRunResponse;
    expect(finalData.run.state).toBe('finished');
    expect(finalData.run.outcome).toBe('improved');
    expect(finalData.run.attempts).toHaveLength(1);
    expect(finalData.run.attempts[0]!.comparisonOutcome).toBe('accepted');
    expect(finalData.run.finalInspection?.remainingIssuesSummary).toContain(
      'All modeled sightline',
    );
    expect(finalData.run.providerRequestIds).toEqual([
      'req_call_1_happy',
      'req_call_2_happy',
    ]);

    // Verify files written to disk under runs/<runId>/
    const runJsonPath = path.join(tempRunsDir, startData.runId, 'run.json');
    const baselineClipPath = path.join(
      tempRunsDir,
      startData.runId,
      `${baselineCapture.captureId}.webm`,
    );
    const revisionClipPath = path.join(
      tempRunsDir,
      startData.runId,
      `${revisionCapture.captureId}.webm`,
    );

    const diskRun = JSON.parse(
      await fs.readFile(runJsonPath, 'utf-8'),
    ) as GetRunResponse['run'];
    expect(diskRun.runId).toBe(startData.runId);
    expect(diskRun.outcome).toBe('improved');

    const savedBaseClip = await fs.readFile(baselineClipPath);
    const savedRevClip = await fs.readFile(revisionClipPath);
    expect(Buffer.compare(savedBaseClip, baselineVideoBuffer)).toBe(0);
    expect(Buffer.compare(savedRevClip, revisionVideoBuffer)).toBe(0);
  });

  it('4. Rejected patch handling: stale parentSceneHash, forbidden fixed-object edit, or non-improving patch records rejection reason, retains baselineSnapshot, and finishes with outcome="no_improvement"', async () => {
    const scenarios: Array<{
      name: string;
      makePatch: (runId: string, snapshot: SceneSnapshot) => LayoutPatch;
      expectedOutcome: string;
      expectedReasonSubstring: string;
    }> = [
      {
        name: 'stale parentSceneHash',
        makePatch: (runId) => ({
          contractVersion: CONTRACT_VERSION,
          runId,
          parentSceneHash: 'vp_stale_hash_00000000',
          diagnosis: [],
          operations: [],
          summary: 'Stale patch.',
        }),
        expectedOutcome: 'rejected_structural',
        expectedReasonSubstring: 'STALE_SCENE_HASH',
      },
      {
        name: 'forbidden fixed-object edit',
        makePatch: (runId, snapshot) => ({
          contractVersion: CONTRACT_VERSION,
          runId,
          parentSceneHash: snapshot.sceneHash,
          diagnosis: [],
          operations: [
            {
              targetType: 'object',
              targetId: 'obj_stage_platform',
              deltaPositionM: [0.2, 0, 0],
              deltaYawDeg: 0,
              reason: 'Attempt to move fixed stage.',
            },
          ],
          summary: 'Illegal fixed object edit.',
        }),
        expectedOutcome: 'rejected_structural',
        expectedReasonSubstring: 'FIXED_OBJECT_MODIFIED',
      },
      {
        name: 'non-improving patch',
        makePatch: (runId, snapshot) => ({
          contractVersion: CONTRACT_VERSION,
          runId,
          parentSceneHash: snapshot.sceneHash,
          diagnosis: [],
          operations: [
            {
              targetType: 'object',
              targetId: 'obj_prop_sign_01',
              deltaPositionM: [-0.05, 0, 0], // still blocking shorter viewer at X = -0.05
              deltaYawDeg: 0,
              reason: 'Tiny shift that does not clear sightline.',
            },
          ],
          summary: 'Insufficient shift.',
        }),
        expectedOutcome: 'rejected_no_improvement',
        expectedReasonSubstring: 'did not improve',
      },
    ];

    for (const scenario of scenarios) {
      let currentMakePatch = scenario.makePatch;
      const provider: ArgonProviderAdapter = {
        modelName: 'mock-argon',
        async critiqueAndProposePatch(input) {
          return {
            providerModel: 'mock-argon',
            providerRequestId: `req_reject_${scenario.name}`,
            patch: currentMakePatch(input.runId, input.snapshot),
          };
        },
        async inspectRevision() {
          throw new Error('Call 2 must not execute when patch is rejected');
        },
      };

      const subHarness = await startTestServer({
        argonProvider: provider,
        runsDir: tempRunsDir,
        evaluator: createRealisticEvaluatorAdapter(),
      });

      try {
        const startRes = await fetch(`${subHarness.baseUrl}/api/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ snapshot: createDevFixtureSnapshot() }),
        });
        expect(startRes.status).toBe(201);
        const startData = (await startRes.json()) as CreateRunResponse;
        const cap = startData.pendingCapture!;

        const manifest: EvidenceManifest = {
          contractVersion: CONTRACT_VERSION,
          captureId: cap.captureId,
          runId: startData.runId,
          phase: 'baseline',
          sceneHash: cap.sceneHash,
          mimeType: 'video/webm',
          byteLength: 16,
          durationSec: cap.totalDurationSec,
          widthPx: 512,
          heightPx: 512,
          keyframes: cap.keyframes,
          recordedAtIso: new Date().toISOString(),
        };

        const uploadRes = await uploadMultipartEvidence(
          subHarness.baseUrl,
          startData.runId,
          manifest,
          Buffer.from('VIDEO_DATA_123456'),
        );
        expect(uploadRes.status).toBe(200);
        const uploadBody = uploadRes.body as unknown as UploadEvidenceResponse;
        expect(uploadBody.state).toBe('finished');
        expect(uploadBody.outcome).toBe('no_improvement');

        const getRes = await fetch(
          `${subHarness.baseUrl}/api/runs/${startData.runId}`,
        );
        const { run } = (await getRes.json()) as GetRunResponse;
        expect(run.state).toBe('finished');
        expect(run.outcome).toBe('no_improvement');
        expect(run.bestSnapshot.sceneHash).toBe(run.baselineSnapshot.sceneHash);
        expect(run.attempts).toHaveLength(1);
        expect(run.attempts[0]!.comparisonOutcome).toBe(scenario.expectedOutcome);
        expect(run.attempts[0]!.rejectionReasons.join(' ')).toContain(
          scenario.expectedReasonSubstring,
        );
      } finally {
        await subHarness.close();
      }
    }
  });

  it('5. Media & hash guards: rejects mismatched captureId, mismatched sceneHash, or empty video buffer with HTTP 400; handles duplicate (runId, captureId) idempotently with only one model call', async () => {
    let call1Count = 0;
    const provider: ArgonProviderAdapter = {
      modelName: 'mock-argon',
      async critiqueAndProposePatch(input) {
        call1Count += 1;
        return {
          providerModel: 'mock-argon',
          providerRequestId: `req_dedup_${call1Count}`,
          patch: {
            contractVersion: CONTRACT_VERSION,
            runId: input.runId,
            parentSceneHash: input.snapshot.sceneHash,
            diagnosis: [],
            operations: [
              {
                targetType: 'object',
                targetId: 'obj_prop_sign_01',
                deltaPositionM: [-0.55, 0, 0],
                deltaYawDeg: 0,
                reason: 'Move sign out of sightline.',
              },
            ],
            summary: 'Move sign.',
          },
        };
      },
      async inspectRevision(input) {
        return {
          providerModel: 'mock-argon',
          providerRequestId: 'req_call2',
          report: {
            captureId: input.revisedManifest.captureId,
            sceneHash: input.revisedSnapshot.sceneHash,
            findings: [],
            remainingIssuesSummary: 'All good.',
          },
        };
      },
    };

    harness = await startTestServer({
      argonProvider: provider,
      runsDir: tempRunsDir,
      evaluator: createRealisticEvaluatorAdapter(),
    });

    const startRes = await fetch(`${harness.baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot: createDevFixtureSnapshot() }),
    });
    const startData = (await startRes.json()) as CreateRunResponse;
    const cap = startData.pendingCapture!;

    const baseManifest: EvidenceManifest = {
      contractVersion: CONTRACT_VERSION,
      captureId: cap.captureId,
      runId: startData.runId,
      phase: 'baseline',
      sceneHash: cap.sceneHash,
      mimeType: 'video/webm',
      byteLength: 32,
      durationSec: cap.totalDurationSec,
      widthPx: 512,
      heightPx: 512,
      keyframes: cap.keyframes,
      recordedAtIso: new Date().toISOString(),
    };

    // 5a. Empty video buffer -> 400
    const emptyRes = await uploadMultipartEvidence(
      harness.baseUrl,
      startData.runId,
      baseManifest,
      Buffer.alloc(0),
    );
    expect(emptyRes.status).toBe(400);
    expect(String(emptyRes.body.error)).toContain('empty video');

    // 5b. Mismatched captureId -> 400
    const wrongCapRes = await uploadMultipartEvidence(
      harness.baseUrl,
      startData.runId,
      { ...baseManifest, captureId: 'cap_wrong_id' },
      Buffer.from('VALID_VIDEO_BYTES'),
    );
    expect(wrongCapRes.status).toBe(400);
    expect(String(wrongCapRes.body.error)).toContain('Capture ID mismatch');

    // 5c. Mismatched sceneHash -> 400
    const wrongHashRes = await uploadMultipartEvidence(
      harness.baseUrl,
      startData.runId,
      { ...baseManifest, sceneHash: 'vp_wrong_hash_999' },
      Buffer.from('VALID_VIDEO_BYTES'),
    );
    expect(wrongHashRes.status).toBe(400);
    expect(String(wrongHashRes.body.error)).toContain('Scene hash mismatch');

    expect(call1Count).toBe(0);

    // 5d. Valid upload -> 200, deduplicated: false, triggers exactly 1 model call
    const validUpload1 = await uploadMultipartEvidence(
      harness.baseUrl,
      startData.runId,
      baseManifest,
      Buffer.from('VALID_VIDEO_BYTES'),
    );
    expect(validUpload1.status).toBe(200);
    expect(validUpload1.body.deduplicated).toBe(false);
    expect(call1Count).toBe(1);

    // 5e. Duplicate upload of the same (runId, captureId) -> 200, deduplicated: true, no extra model call
    const validUpload2 = await uploadMultipartEvidence(
      harness.baseUrl,
      startData.runId,
      baseManifest,
      Buffer.from('VALID_VIDEO_BYTES'),
    );
    expect(validUpload2.status).toBe(200);
    expect(validUpload2.body.deduplicated).toBe(true);
    expect(call1Count).toBe(1);
  });

  it('6. Deadline & interruption handling: when 110s deadline expires after patch verification but before revision inspection, outcome is "partial_incomplete", verified bestSnapshot is preserved, and subsequent POST /api/runs is not deadlocked by 409', async () => {
    let currentTimeMs = 1_700_000_000_000;

    const provider: ArgonProviderAdapter = {
      modelName: 'mock-argon',
      async critiqueAndProposePatch(input) {
        return {
          providerModel: 'mock-argon',
          providerRequestId: 'req_deadline_test',
          patch: {
            contractVersion: CONTRACT_VERSION,
            runId: input.runId,
            parentSceneHash: input.snapshot.sceneHash,
            diagnosis: [],
            operations: [
              {
                targetType: 'object',
                targetId: 'obj_prop_sign_01',
                deltaPositionM: [-0.55, 0, 0],
                deltaYawDeg: 0,
                reason: 'Shift sign.',
              },
            ],
            summary: 'Shift sign.',
          },
        };
      },
      async inspectRevision() {
        throw new Error('Should not reach Call 2 after deadline expiry');
      },
    };

    harness = await startTestServer({
      argonProvider: provider,
      runsDir: tempRunsDir,
      evaluator: createRealisticEvaluatorAdapter(),
      now: () => currentTimeMs,
    });

    // Start run 1 at t = 0
    const start1 = await fetch(`${harness.baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot: createDevFixtureSnapshot() }),
    });
    expect(start1.status).toBe(201);
    const run1Data = (await start1.json()) as CreateRunResponse;

    // While run 1 is active and within deadline, a second POST /api/runs returns 409
    const conflictRes = await fetch(`${harness.baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot: createDevFixtureSnapshot() }),
    });
    expect(conflictRes.status).toBe(409);

    // Advance time to t = 25s and upload baseline evidence -> patch is verified and accepted
    currentTimeMs += 25_000;
    const cap1 = run1Data.pendingCapture!;
    const manifest1: EvidenceManifest = {
      contractVersion: CONTRACT_VERSION,
      captureId: cap1.captureId,
      runId: run1Data.runId,
      phase: 'baseline',
      sceneHash: cap1.sceneHash,
      mimeType: 'video/webm',
      byteLength: 32,
      durationSec: cap1.totalDurationSec,
      widthPx: 512,
      heightPx: 512,
      keyframes: cap1.keyframes,
      recordedAtIso: new Date(currentTimeMs).toISOString(),
    };

    const upload1 = await uploadMultipartEvidence(
      harness.baseUrl,
      run1Data.runId,
      manifest1,
      Buffer.from('BASELINE_VIDEO'),
    );
    expect(upload1.status).toBe(200);
    expect(upload1.body.state).toBe('rendering_revision');

    // Now advance clock past the 110-second live deadline before revision inspection completes
    currentTimeMs += RUN_TIMING.liveDeadlineMs + 5_000;

    // Poll GET /api/runs/:id -> should auto-expire with outcome: 'partial_incomplete' and preserve bestSnapshot
    const statusAfterDeadline = await fetch(
      `${harness.baseUrl}/api/runs/${run1Data.runId}`,
    );
    expect(statusAfterDeadline.status).toBe(200);
    const expiredRun = ((await statusAfterDeadline.json()) as GetRunResponse).run;
    expect(expiredRun.state).toBe('finished');
    expect(expiredRun.outcome).toBe('partial_incomplete');
    expect(expiredRun.bestSnapshot.sceneHash).not.toBe(
      expiredRun.baselineSnapshot.sceneHash,
    );
    expect(expiredRun.bestEvaluation.allModeledRequirementsMet).toBe(true);
    expect(expiredRun.pendingCapture).toBeUndefined();

    // Subsequent POST /api/runs must NOT be deadlocked by 409
    const start2 = await fetch(`${harness.baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot: createDevFixtureSnapshot() }),
    });
    expect(start2.status).toBe(201);
    const run2Data = (await start2.json()) as CreateRunResponse;
    expect(run2Data.runId).not.toBe(run1Data.runId);
  });

  it('7. Live adapter fails honestly with outcome="failure" and exact missing-key message when GEMINI_API_KEY is absent', async () => {
    const savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const liveAdapter = createGeminiArgonAdapter({ apiKey: '' });
      harness = await startTestServer({
        argonProvider: liveAdapter,
        runsDir: tempRunsDir,
      });

      const startRes = await fetch(`${harness.baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot: createDevFixtureSnapshot() }),
      });
      const startData = (await startRes.json()) as CreateRunResponse;
      const cap = startData.pendingCapture!;

      const manifest: EvidenceManifest = {
        contractVersion: CONTRACT_VERSION,
        captureId: cap.captureId,
        runId: startData.runId,
        phase: 'baseline',
        sceneHash: cap.sceneHash,
        mimeType: 'video/webm',
        byteLength: 16,
        durationSec: cap.totalDurationSec,
        widthPx: 512,
        heightPx: 512,
        keyframes: cap.keyframes,
        recordedAtIso: new Date().toISOString(),
      };

      const uploadRes = await uploadMultipartEvidence(
        harness.baseUrl,
        startData.runId,
        manifest,
        Buffer.from('LIVE_VIDEO_BYTES'),
      );
      expect(uploadRes.status).toBe(200);
      expect(uploadRes.body.state).toBe('finished');
      expect(uploadRes.body.outcome).toBe('failure');

      const statusRes = await fetch(
        `${harness.baseUrl}/api/runs/${startData.runId}`,
      );
      const { run } = (await statusRes.json()) as GetRunResponse;
      expect(run.outcome).toBe('failure');
      expect(run.terminalReason).toContain('Missing GEMINI_API_KEY');
    } finally {
      if (savedKey !== undefined) {
        process.env.GEMINI_API_KEY = savedKey;
      }
    }
  });

  it('8. buildCaptureTourSpec generates matching attendee view sequences across baseline and revision tours', () => {
    const baselineSnap = createDevFixtureSnapshot();
    const evaluator = createRealisticEvaluatorAdapter();
    const baselineEval = evaluator.evaluateScene(baselineSnap);

    const baselineTour = buildCaptureTourSpec({
      runId: 'run_tour_test',
      phase: 'baseline',
      snapshot: baselineSnap,
      evaluation: baselineEval,
      deadlineIso: new Date().toISOString(),
    });

    expect(baselineTour.keyframes[0]?.kind).toBe('overview');
    const baselinePovIds = baselineTour.keyframes
      .filter((k) => k.kind === 'attendee_pov')
      .map((k) => k.attendeeId!);
    expect(baselinePovIds[0]).toBe('att_shorter_01');
    expect(baselinePovIds).toContain('att_adult_01');

    // Modify chair position for att_shorter_01 in revised snapshot and verify camera pose updates
    const revisedSnap = structuredClone(baselineSnap);
    const chairR2 = revisedSnap.objects.find((o) => o.id === 'obj_chair_r2_c1')!;
    chairR2.transform.position = [0.25, 0.0, 0.5];
    const hashedRevised = withUpdatedSceneHash(revisedSnap);

    const revisionTour = buildCaptureTourSpec({
      runId: 'run_tour_test',
      phase: 'revision',
      snapshot: hashedRevised,
      orderedAttendeeIds: baselinePovIds,
      deadlineIso: new Date().toISOString(),
    });

    expect(revisionTour.keyframes.map((k) => k.viewId)).toEqual(
      baselineTour.keyframes.map((k) => k.viewId),
    );
    const revShorterKf = revisionTour.keyframes.find(
      (k) => k.attendeeId === 'att_shorter_01',
    )!;
    expect(revShorterKf.cameraPosition[0]).toBeCloseTo(0.25, 4);
    expect(revShorterKf.fovDeg).toBe(90);
    expect(revShorterKf.aspect).toBe(1.0);
  });

  it('9. Adversarial hardening: rejects structurally invalid baseline on POST /api/runs, returns structured JSON on malformed body, and aborts hung Call 2 with partial_incomplete', async () => {
    let currentTimeMs = 1_700_500_000_000;
    let call2Aborted = false;

    const provider: ArgonProviderAdapter = {
      modelName: 'mock-argon',
      async critiqueAndProposePatch(input) {
        return {
          providerModel: 'mock-argon',
          providerRequestId: 'req_hardening_1',
          patch: {
            contractVersion: CONTRACT_VERSION,
            runId: input.runId,
            parentSceneHash: input.snapshot.sceneHash,
            diagnosis: [],
            operations: [
              {
                targetType: 'object',
                targetId: 'obj_prop_sign_01',
                deltaPositionM: [-0.55, 0, 0],
                deltaYawDeg: 0,
                reason: 'Shift sign.',
              },
            ],
            summary: 'Shift sign.',
          },
        };
      },
      async inspectRevision(input) {
        return await new Promise((_resolve, reject) => {
          input.abortSignal?.addEventListener('abort', () => {
            call2Aborted = true;
            currentTimeMs += 200_000;
            reject(new Error('Aborted by controller deadline'));
          });
        });
      },
    };

    const baseEvalAdapter = createRealisticEvaluatorAdapter();
    harness = await startTestServer({
      argonProvider: provider,
      runsDir: tempRunsDir,
      now: () => currentTimeMs,
      evaluator: {
        ...baseEvalAdapter,
        evaluateScene(snap) {
          if (snap.sceneId === 'broken_baseline') {
            return {
              ...baseEvalAdapter.evaluateScene(snap),
              isValidStructure: false,
              structuralErrors: [
                {
                  code: 'DUPLICATE_ASSIGNMENT',
                  message: 'Two attendees assigned to the same place.',
                },
              ],
            };
          }
          return baseEvalAdapter.evaluateScene(snap);
        },
      },
    });

    // 9a. Malformed JSON body -> HTTP 400 JSON
    const badJsonRes = await fetch(`${harness.baseUrl}/api/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ invalid json',
    });
    expect(badJsonRes.status).toBe(400);
    const badJsonBody = (await badJsonRes.json()) as { error: string };
    expect(badJsonBody.error).toContain('Malformed JSON');

    // 9b. Structurally invalid baseline -> HTTP 400
    const brokenSnap = withUpdatedSceneHash({
      ...createDevFixtureSnapshot(),
      sceneId: 'broken_baseline',
    });
    const brokenStartRes = await fetch(`${harness.baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot: brokenSnap }),
    });
    expect(brokenStartRes.status).toBe(400);
    const brokenBody = (await brokenStartRes.json()) as {
      error: string;
      structuralErrors: unknown[];
    };
    expect(brokenBody.error).toContain('structurally invalid');
    expect(brokenBody.structuralErrors).toHaveLength(1);

    // 9c. Start valid run and verify hung Call 2 is aborted when remaining deadline expires, preserving partial_incomplete
    const startRes = await fetch(`${harness.baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot: createDevFixtureSnapshot() }),
    });
    expect(startRes.status).toBe(201);
    const startData = (await startRes.json()) as CreateRunResponse;
    const baseCap = startData.pendingCapture!;

    const baseManifest: EvidenceManifest = {
      contractVersion: CONTRACT_VERSION,
      captureId: baseCap.captureId,
      runId: startData.runId,
      phase: 'baseline',
      sceneHash: baseCap.sceneHash,
      mimeType: 'video/mp4',
      byteLength: 24,
      durationSec: baseCap.totalDurationSec,
      widthPx: 512,
      heightPx: 512,
      keyframes: baseCap.keyframes,
      recordedAtIso: new Date(currentTimeMs).toISOString(),
    };

    const baseUpload = await uploadMultipartEvidence(
      harness.baseUrl,
      startData.runId,
      baseManifest,
      Buffer.from('MP4_BASELINE_CLIP_DATA'),
    );
    expect(baseUpload.status).toBe(200);

    // Verify .mp4 extension persisted on disk
    const mp4Path = path.join(
      tempRunsDir,
      startData.runId,
      `${baseCap.captureId}.mp4`,
    );
    const savedMp4 = await fs.readFile(mp4Path);
    expect(savedMp4.toString()).toBe('MP4_BASELINE_CLIP_DATA');

    // Leave only 40ms remaining before the 110s deadline, then upload revision evidence
    currentTimeMs += RUN_TIMING.liveDeadlineMs - 40;

    const midStatus = (await (
      await fetch(`${harness.baseUrl}/api/runs/${startData.runId}`)
    ).json()) as GetRunResponse;
    const revCap = midStatus.run.pendingCapture!;

    const revManifest: EvidenceManifest = {
      contractVersion: CONTRACT_VERSION,
      captureId: revCap.captureId,
      runId: startData.runId,
      phase: 'revision',
      sceneHash: revCap.sceneHash,
      mimeType: 'video/webm',
      byteLength: 24,
      durationSec: revCap.totalDurationSec,
      widthPx: 512,
      heightPx: 512,
      keyframes: revCap.keyframes,
      recordedAtIso: new Date(currentTimeMs).toISOString(),
    };

    const revUpload = await uploadMultipartEvidence(
      harness.baseUrl,
      startData.runId,
      revManifest,
      Buffer.from('WEBM_REVISION_CLIP_DATA'),
    );
    expect(revUpload.status).toBe(200);
    expect(call2Aborted).toBe(true);
    expect(revUpload.body.state).toBe('finished');
    expect(revUpload.body.outcome).toBe('partial_incomplete');
  });

  it.skipIf(process.env.RUN_LIVE_GEMINI_TEST !== '1')(
    '10. Live Gemini E2E: executes real Call 1 and Call 2 video review against configured Gemini API within 110s deadline',
    async () => {
      if (typeof process.loadEnvFile === 'function') {
        try {
          process.loadEnvFile('.env');
        } catch {
          // ignore if .env not present
        }
      }

      const videoBuffer = await fs.readFile(
        '/Users/oskarherlitz/.gemini/tmp/toughgeminihackathon/smoke.mp4',
      );
      expect(videoBuffer.byteLength).toBeGreaterThan(100);

      const liveAdapter = createGeminiArgonAdapter();
      harness = await startTestServer({
        argonProvider: liveAdapter,
        runsDir: tempRunsDir,
        evaluator: createRealisticEvaluatorAdapter(),
      });

      const t0 = Date.now();
      const startRes = await fetch(`${harness.baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot: createDevFixtureSnapshot() }),
      });
      expect(startRes.status).toBe(201);
      const startData = (await startRes.json()) as CreateRunResponse;
      const baseCap = startData.pendingCapture!;

      const baseManifest: EvidenceManifest = {
        contractVersion: CONTRACT_VERSION,
        captureId: baseCap.captureId,
        runId: startData.runId,
        phase: 'baseline',
        sceneHash: baseCap.sceneHash,
        mimeType: 'video/mp4',
        byteLength: videoBuffer.byteLength,
        durationSec: baseCap.totalDurationSec,
        widthPx: 512,
        heightPx: 512,
        keyframes: baseCap.keyframes,
        recordedAtIso: new Date().toISOString(),
      };

      const baseUpload = await uploadMultipartEvidence(
        harness.baseUrl,
        startData.runId,
        baseManifest,
        videoBuffer,
      );
      expect(baseUpload.status).toBe(200);

      const midStatus = (await (
        await fetch(`${harness.baseUrl}/api/runs/${startData.runId}`)
      ).json()) as GetRunResponse;

      console.log(
        '[Live Gemini Call 1]',
        'state:',
        midStatus.run.state,
        'outcome:',
        midStatus.run.outcome,
        'terminalReason:',
        midStatus.run.terminalReason,
        'elapsedMs:',
        midStatus.run.elapsedMs,
        'summary:',
        midStatus.run.attempts[0]?.patch?.summary,
        'operations:',
        JSON.stringify(midStatus.run.attempts[0]?.patch?.operations),
      );

      expect(midStatus.run.attempts).toHaveLength(1);
      expect(midStatus.run.attempts[0]!.patch.diagnosis.length).toBeGreaterThan(
        0,
      );

      if (
        midStatus.run.state === 'rendering_revision' &&
        midStatus.run.pendingCapture
      ) {
        const revCap = midStatus.run.pendingCapture;
        const revManifest: EvidenceManifest = {
          contractVersion: CONTRACT_VERSION,
          captureId: revCap.captureId,
          runId: startData.runId,
          phase: 'revision',
          sceneHash: revCap.sceneHash,
          mimeType: 'video/mp4',
          byteLength: videoBuffer.byteLength,
          durationSec: revCap.totalDurationSec,
          widthPx: 512,
          heightPx: 512,
          keyframes: revCap.keyframes,
          recordedAtIso: new Date().toISOString(),
        };

        const revUpload = await uploadMultipartEvidence(
          harness.baseUrl,
          startData.runId,
          revManifest,
          videoBuffer,
        );
        expect(revUpload.status).toBe(200);
      }

      const finalStatus = (await (
        await fetch(`${harness.baseUrl}/api/runs/${startData.runId}`)
      ).json()) as GetRunResponse;

      console.log(
        '[Live Gemini Final]',
        'state:',
        finalStatus.run.state,
        'outcome:',
        finalStatus.run.outcome,
        'totalSec:',
        ((Date.now() - t0) / 1000).toFixed(1),
        'providerModel:',
        finalStatus.run.providerModel,
        'requestIds:',
        finalStatus.run.providerRequestIds,
        'finalInspection:',
        finalStatus.run.finalInspection?.remainingIssuesSummary,
      );

      expect(finalStatus.run.state).toBe('finished');
      expect(['improved', 'no_improvement']).toContain(finalStatus.run.outcome);
      expect(finalStatus.run.elapsedMs).toBeLessThan(
        RUN_TIMING.liveDeadlineMs,
      );
    },
    115_000,
  );
});
