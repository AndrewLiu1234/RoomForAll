/**
 * Stream C — Argon Controller & Backend (`src/server/index.ts`)
 * Exclusive ownership: Workstream C (`src/server/`, `tests/server/`).
 *
 * Required endpoints per PRD §10 Step 3 & ARGON_MVP_PROMPT.md §3:
 * - `POST /api/preview` -> normalized snapshot and independent evaluation, no paid model call
 * - `POST /api/runs` -> freeze setup, allow one active run, return run ID promptly
 * - `GET /api/runs/:id` -> status, last verified result, and any pending capture request
 * - `POST /api/runs/:id/evidence` -> multipart video + manifest; verify capture ID/hash, idempotent
 */
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import multer from 'multer';
import {
  CONTRACT_VERSION,
  RUN_TIMING,
  createBlindCritiquePayload,
  createDevFixtureSnapshot,
  withUpdatedSceneHash,
  type CaptureKeyframe,
  type ComparisonOutcome,
  type CreateRunRequest,
  type CreateRunResponse,
  type Evaluation,
  type EvaluationComparisonResult,
  type EvidenceManifest,
  type GetRunResponse,
  type LayoutPatch,
  type PatchAttemptRecord,
  type PatchValidationResult,
  type PreviewRequest,
  type PreviewResponse,
  type RunRecord,
  type RunState,
  type SceneSnapshot,
  type UploadEvidenceResponse,
} from '../shared/index.js';
import {
  applyAndValidatePatch,
  compareEvaluations,
  evaluateScene,
} from '../evaluation/index.js';
import {
  assertBlindCritiquePayloadClean,
  createGeminiArgonAdapter,
  type ArgonProviderAdapter,
} from './argonClient.js';
import {
  runParallelGeminiGlbAgents,
  type GlbSceneDescriptorInput,
} from './glbAgentParser.js';
import { createRunStorage, type RunStorage } from './storage.js';
import { buildCaptureTourSpec, extractTourAttendeeOrder } from './tour.js';

export * from './argonClient.js';
export * from './glbAgentParser.js';
export * from './storage.js';
export * from './tour.js';

export interface EvaluatorAdapter {
  evaluateScene(snapshot: SceneSnapshot): Evaluation;
  applyAndValidatePatch(
    baselineSnapshot: SceneSnapshot,
    currentSnapshot: SceneSnapshot,
    patch: LayoutPatch,
  ): PatchValidationResult;
  compareEvaluations(
    baselineEval: Evaluation,
    candidateEval: Evaluation,
  ): EvaluationComparisonResult;
}

export interface CreateAppOptions {
  argonProvider?: ArgonProviderAdapter;
  storage?: RunStorage;
  runsDir?: string;
  evaluator?: Partial<EvaluatorAdapter>;
  now?: () => number;
  onStateTransition?: (
    runId: string,
    state: RunState,
    record: RunRecord,
  ) => void;
}

const MAX_IN_MEMORY_RUNS = 50;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

function isRunFinished(record: RunRecord): boolean {
  return record.state === 'finished';
}

function refreshDeadlineIfNeeded(record: RunRecord, nowMs: number): boolean {
  if (isRunFinished(record)) return false;
  const createdMs = Date.parse(record.createdAtIso);
  const deadlineMs = Date.parse(record.deadlineIso);
  record.elapsedMs = Math.max(0, nowMs - createdMs);
  if (nowMs > deadlineMs) {
    record.state = 'finished';
    record.outcome =
      record.bestSnapshot.sceneHash !== record.baselineSnapshot.sceneHash
        ? 'partial_incomplete'
        : 'timeout';
    record.terminalReason = '110-second live deadline expired.';
    record.pendingCapture = undefined;
    record.updatedAtIso = new Date(nowMs).toISOString();
    return true;
  }
  return false;
}

function sanitizeEvidenceManifest(
  manifest: EvidenceManifest,
  authoritativeKeyframes: CaptureKeyframe[],
): EvidenceManifest {
  const safeKeyframes: CaptureKeyframe[] =
    authoritativeKeyframes.length > 0
      ? structuredClone(authoritativeKeyframes)
      : manifest.keyframes;
  return {
    contractVersion: CONTRACT_VERSION,
    captureId: manifest.captureId,
    runId: manifest.runId,
    phase: manifest.phase,
    sceneHash: manifest.sceneHash,
    mimeType:
      typeof manifest.mimeType === 'string' && manifest.mimeType.trim().length > 0
        ? manifest.mimeType
        : 'video/webm',
    byteLength:
      typeof manifest.byteLength === 'number' && Number.isFinite(manifest.byteLength)
        ? manifest.byteLength
        : 0,
    durationSec:
      typeof manifest.durationSec === 'number' && Number.isFinite(manifest.durationSec)
        ? manifest.durationSec
        : 0,
    widthPx:
      typeof manifest.widthPx === 'number' && Number.isFinite(manifest.widthPx)
        ? manifest.widthPx
        : 512,
    heightPx:
      typeof manifest.heightPx === 'number' && Number.isFinite(manifest.heightPx)
        ? manifest.heightPx
        : 512,
    keyframes: safeKeyframes,
    recordedAtIso:
      typeof manifest.recordedAtIso === 'string' &&
      manifest.recordedAtIso.trim().length > 0
        ? manifest.recordedAtIso
        : new Date().toISOString(),
  };
}

async function runWithRemainingDeadline<T>(
  remainingMs: number,
  work: (abortSignal: AbortSignal, timeoutMs: number) => Promise<T>,
): Promise<T> {
  if (remainingMs <= 0) {
    throw new Error('110-second live deadline expired.');
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('110-second live deadline expired.'));
    }, remainingMs);
  });

  try {
    return await Promise.race([
      work(controller.signal, remainingMs),
      timeoutPromise,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  const nowFn = options.now ?? (() => Date.now());
  const argonProvider = options.argonProvider ?? createGeminiArgonAdapter();
  const storage = options.storage ?? createRunStorage(options.runsDir);
  const evaluator: EvaluatorAdapter = {
    evaluateScene: options.evaluator?.evaluateScene ?? evaluateScene,
    applyAndValidatePatch:
      options.evaluator?.applyAndValidatePatch ?? applyAndValidatePatch,
    compareEvaluations:
      options.evaluator?.compareEvaluations ?? compareEvaluations,
  };

  const runs = new Map<string, RunRecord>();
  const uploadedCaptures = new Set<string>();
  const inFlightCaptures = new Map<string, Promise<UploadEvidenceResponse>>();
  let activeRunId: string | null = null;
  let runSeq = 0;

  function pruneRunsCacheIfNeeded(): void {
    if (runs.size <= MAX_IN_MEMORY_RUNS) return;
    for (const [id, rec] of runs.entries()) {
      if (runs.size <= MAX_IN_MEMORY_RUNS) break;
      if (id !== activeRunId && rec.state === 'finished') {
        runs.delete(id);
      }
    }
  }

  async function transitionState(
    record: RunRecord,
    nextState: RunState,
  ): Promise<void> {
    const currentMs = nowFn();
    const createdMs = Date.parse(record.createdAtIso);
    record.state = nextState;
    record.elapsedMs = Math.max(0, currentMs - createdMs);
    record.updatedAtIso = new Date(currentMs).toISOString();
    options.onStateTransition?.(
      record.runId,
      nextState,
      structuredClone(record),
    );
    await storage.saveRunRecord(record);
  }

  app.post('/api/parse-glb', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Partial<GlbSceneDescriptorInput>;
      if (!Array.isArray(body.nodes)) {
        res.status(400).json({ error: 'Missing nodes array in descriptor.' });
        return;
      }
      const result = await runParallelGeminiGlbAgents({
        fileName:
          typeof body.fileName === 'string'
            ? body.fileName
            : 'uploaded-venue.glb',
        byteLength:
          typeof body.byteLength === 'number' ? body.byteLength : 0,
        nodes: body.nodes,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: `Parallel Gemini GLB agent parser failed: ${(err as Error).message}`,
      });
    }
  });

  app.post('/api/preview', (req, res) => {
    try {
      const body = (req.body ?? {}) as PreviewRequest;
      const baseSnapshot = body.snapshot ?? createDevFixtureSnapshot();
      const mergedSnapshot = withUpdatedSceneHash({
        ...baseSnapshot,
        profiles: body.profiles
          ? { ...baseSnapshot.profiles, ...body.profiles }
          : baseSnapshot.profiles,
        roster: body.roster ?? baseSnapshot.roster,
      });
      const evaluation = evaluator.evaluateScene(mergedSnapshot);
      const payload: PreviewResponse = {
        snapshot: mergedSnapshot,
        evaluation,
      };
      res.json(payload);
    } catch (err) {
      res.status(400).json({
        error: `Preview evaluation failed: ${(err as Error).message}`,
      });
    }
  });

  app.post('/api/runs', async (req, res) => {
    try {
      const nowMs = nowFn();

      if (activeRunId) {
        const existing = runs.get(activeRunId);
        if (existing) {
          const expired = refreshDeadlineIfNeeded(existing, nowMs);
          if (expired) {
            await storage.saveRunRecord(existing);
          }
          if (existing.state !== 'finished') {
            res.status(409).json({
              error: 'An active run is already in progress.',
              activeRunId,
            });
            return;
          }
        }
        activeRunId = null;
      }

      const body = (req.body ?? {}) as Partial<CreateRunRequest>;
      const snapshot = withUpdatedSceneHash(
        body.snapshot ?? createDevFixtureSnapshot(),
      );
      const evaluation = evaluator.evaluateScene(snapshot);

      if (!evaluation.isValidStructure) {
        res.status(400).json({
          error:
            'Cannot start a live run on a structurally invalid baseline snapshot.',
          structuralErrors: evaluation.structuralErrors,
        });
        return;
      }

      const createdAtIso = new Date(nowMs).toISOString();
      const deadlineIso = new Date(
        nowMs + RUN_TIMING.liveDeadlineMs,
      ).toISOString();

      runSeq += 1;
      const runId = `run_${nowMs}_${runSeq}`;

      const baselineTour = buildCaptureTourSpec({
        runId,
        phase: 'baseline',
        snapshot,
        evaluation,
        deadlineIso,
      });

      const record: RunRecord = {
        contractVersion: CONTRACT_VERSION,
        runId,
        state: 'preparing',
        outcome: 'in_progress',
        createdAtIso,
        updatedAtIso: createdAtIso,
        deadlineIso,
        elapsedMs: 0,
        baselineSnapshot: snapshot,
        baselineEvaluation: evaluation,
        bestSnapshot: structuredClone(snapshot),
        bestEvaluation: structuredClone(evaluation),
        pendingCapture: baselineTour,
        attempts: [],
        providerModel: argonProvider.modelName,
        providerRequestIds: [],
      };

      runs.set(runId, record);
      activeRunId = runId;
      pruneRunsCacheIfNeeded();

      await transitionState(record, 'capturing_baseline');

      const response: CreateRunResponse = {
        runId,
        state: record.state,
        sceneHash: snapshot.sceneHash,
        deadlineIso: record.deadlineIso,
        pendingCapture: record.pendingCapture,
      };
      res.status(201).json(response);
    } catch (err) {
      res.status(500).json({
        error: `Failed to start run: ${(err as Error).message}`,
      });
    }
  });

  app.get('/api/runs/:id', async (req, res) => {
    try {
      const runId = req.params.id;
      let record = runs.get(runId);
      if (!record) {
        const loaded = await storage.loadRunRecord(runId);
        if (loaded) {
          record = loaded;
        }
      }
      if (!record) {
        res.status(404).json({ error: `Run ${runId} not found.` });
        return;
      }

      const expired = refreshDeadlineIfNeeded(record, nowFn());
      if (expired) {
        if (activeRunId === runId) {
          activeRunId = null;
        }
        await storage.saveRunRecord(record);
      }

      const payload: GetRunResponse = { run: record };
      res.json(payload);
    } catch (err) {
      res.status(500).json({
        error: `Failed to fetch run status: ${(err as Error).message}`,
      });
    }
  });

  app.post(
    '/api/runs/:id/evidence',
    upload.single('video'),
    async (req, res) => {
      try {
        const rawId = req.params.id;
        const runId = Array.isArray(rawId) ? (rawId[0] ?? '') : (rawId ?? '');
        const record = runs.get(runId);
        if (!record) {
          res.status(404).json({ error: `Run ${runId} not found.` });
          return;
        }

        const rawManifest = req.body?.manifest;
        if (!rawManifest || typeof rawManifest !== 'string') {
          res.status(400).json({ error: 'Missing manifest JSON field.' });
          return;
        }

        let manifest: EvidenceManifest;
        try {
          manifest = JSON.parse(rawManifest) as EvidenceManifest;
        } catch {
          res.status(400).json({ error: 'Invalid manifest JSON.' });
          return;
        }

        if (
          !manifest ||
          typeof manifest.captureId !== 'string' ||
          manifest.captureId.trim().length === 0
        ) {
          res.status(400).json({ error: 'Manifest is missing a valid captureId.' });
          return;
        }

        const dedupKey = `${runId}:${manifest.captureId}`;

        // If this exact (runId, captureId) is currently in flight, wait for it and return deduplicated: true
        const inFlight = inFlightCaptures.get(dedupKey);
        if (inFlight) {
          try {
            await inFlight;
          } catch {
            // State is reflected in record
          }
          const dupResponse: UploadEvidenceResponse = {
            runId,
            captureId: manifest.captureId,
            deduplicated: true,
            state: record.state,
            outcome: record.outcome,
          };
          res.json(dupResponse);
          return;
        }

        // If this exact (runId, captureId) was already processed, return deduplicated: true immediately
        if (uploadedCaptures.has(dedupKey)) {
          const dupResponse: UploadEvidenceResponse = {
            runId,
            captureId: manifest.captureId,
            deduplicated: true,
            state: record.state,
            outcome: record.outcome,
          };
          res.json(dupResponse);
          return;
        }

        const expired = refreshDeadlineIfNeeded(record, nowFn());
        if (expired) {
          if (activeRunId === runId) {
            activeRunId = null;
          }
          await storage.saveRunRecord(record);
        }

        if (isRunFinished(record)) {
          res.status(409).json({
            error: `Run ${runId} is already finished (${record.outcome}).`,
          });
          return;
        }

        if (!req.file || !req.file.buffer || req.file.size === 0) {
          res.status(400).json({
            error: 'Missing or empty video file in multipart upload.',
          });
          return;
        }

        if (
          !record.pendingCapture ||
          record.pendingCapture.captureId !== manifest.captureId
        ) {
          res.status(400).json({
            error: `Capture ID mismatch: expected ${record.pendingCapture?.captureId ?? 'none'}, received ${manifest.captureId}.`,
          });
          return;
        }

        if (record.pendingCapture.sceneHash !== manifest.sceneHash) {
          res.status(400).json({
            error: `Scene hash mismatch: expected ${record.pendingCapture.sceneHash}, received ${manifest.sceneHash}.`,
          });
          return;
        }

        if (record.pendingCapture.phase !== manifest.phase) {
          res.status(400).json({
            error: `Capture phase mismatch: expected ${record.pendingCapture.phase}, received ${manifest.phase}.`,
          });
          return;
        }

        const videoBuffer = req.file.buffer;
        const authoritativeKeyframes = structuredClone(
          record.pendingCapture.keyframes,
        );
        const sanitizedManifest = sanitizeEvidenceManifest(
          manifest,
          authoritativeKeyframes,
        );

        const processCapturePromise = (async (): Promise<UploadEvidenceResponse> => {
          await storage.saveEvidenceVideo(
            runId,
            sanitizedManifest.captureId,
            videoBuffer,
            sanitizedManifest.mimeType,
          );
          uploadedCaptures.add(dedupKey);

          if (sanitizedManifest.phase === 'baseline') {
            record.baselineEvidence = sanitizedManifest;
            record.pendingCapture = undefined;
            await transitionState(record, 'inspecting_baseline');

            if (refreshDeadlineIfNeeded(record, nowFn())) {
              if (activeRunId === runId) activeRunId = null;
              await storage.saveRunRecord(record);
              return {
                runId,
                captureId: sanitizedManifest.captureId,
                deduplicated: false,
                state: record.state,
                outcome: record.outcome,
              };
            }

            await transitionState(record, 'proposing');

            const blindPayload = createBlindCritiquePayload(
              record.baselineSnapshot,
              sanitizedManifest,
            );
            assertBlindCritiquePayloadClean(blindPayload);

            const remainingCall1Ms =
              Date.parse(record.deadlineIso) - nowFn();

            let call1Result;
            try {
              call1Result = await runWithRemainingDeadline(
                remainingCall1Ms,
                (abortSignal, timeoutMs) =>
                  argonProvider.critiqueAndProposePatch({
                    runId,
                    snapshot: structuredClone(record.baselineSnapshot),
                    manifest: sanitizedManifest,
                    videoBuffer,
                    blindPayload,
                    abortSignal,
                    timeoutMs,
                  }),
              );
            } catch (err) {
              const expiredDuringCall1 = refreshDeadlineIfNeeded(
                record,
                nowFn(),
              );
              if (expiredDuringCall1 || isRunFinished(record)) {
                if (activeRunId === runId) activeRunId = null;
                await storage.saveRunRecord(record);
              } else {
                record.outcome = 'failure';
                record.terminalReason = `Argon Call 1 failed: ${(err as Error).message}`;
                if (activeRunId === runId) activeRunId = null;
                await transitionState(record, 'finished');
              }
              return {
                runId,
                captureId: sanitizedManifest.captureId,
                deduplicated: false,
                state: record.state,
                outcome: record.outcome,
              };
            }

            record.providerModel = call1Result.providerModel;
            if (call1Result.providerRequestId) {
              record.providerRequestIds.push(call1Result.providerRequestId);
            }

            if (
              refreshDeadlineIfNeeded(record, nowFn()) ||
              isRunFinished(record)
            ) {
              if (activeRunId === runId) activeRunId = null;
              await storage.saveRunRecord(record);
              return {
                runId,
                captureId: sanitizedManifest.captureId,
                deduplicated: false,
                state: record.state,
                outcome: record.outcome,
              };
            }

            await transitionState(record, 'verifying');

            const proposedPatch = call1Result.patch;
            const validation = evaluator.applyAndValidatePatch(
              record.baselineSnapshot,
              record.bestSnapshot,
              proposedPatch,
            );

            let comparisonOutcome: ComparisonOutcome;
            let rejectionReasons: string[] = [];
            let candidateSnapshot: SceneSnapshot | undefined;
            let candidateEvaluation: Evaluation | undefined;

            if (!validation.valid || !validation.snapshot) {
              comparisonOutcome = 'rejected_structural';
              rejectionReasons =
                validation.errors.length > 0
                  ? validation.errors.map((e) => `${e.code}: ${e.message}`)
                  : ['Patch failed structural validation.'];
            } else {
              candidateSnapshot = withUpdatedSceneHash(validation.snapshot);
              candidateEvaluation = evaluator.evaluateScene(candidateSnapshot);
              const comparison = evaluator.compareEvaluations(
                record.baselineEvaluation,
                candidateEvaluation,
              );

              if (comparison.accepted) {
                comparisonOutcome = 'accepted';
              } else {
                comparisonOutcome = comparison.outcome;
                rejectionReasons =
                  comparison.reasons.length > 0
                    ? comparison.reasons
                    : [`Patch rejected (${comparison.outcome}).`];
              }
            }

            const attemptRecord: PatchAttemptRecord = {
              attemptIndex: record.attempts.length,
              patch: proposedPatch,
              candidateSceneHash: candidateSnapshot?.sceneHash,
              evaluation: candidateEvaluation,
              comparisonOutcome,
              rejectionReasons,
              timestampIso: new Date(nowFn()).toISOString(),
            };
            record.attempts.push(attemptRecord);

            if (
              comparisonOutcome === 'accepted' &&
              candidateSnapshot &&
              candidateEvaluation
            ) {
              record.bestSnapshot = candidateSnapshot;
              record.bestEvaluation = candidateEvaluation;

              // Check if the 110s deadline expired right after patch verification
              if (
                refreshDeadlineIfNeeded(record, nowFn()) ||
                isRunFinished(record)
              ) {
                if (activeRunId === runId) activeRunId = null;
                await storage.saveRunRecord(record);
                return {
                  runId,
                  captureId: sanitizedManifest.captureId,
                  deduplicated: false,
                  state: record.state,
                  outcome: record.outcome,
                };
              }

              const orderedAttendeeIds = extractTourAttendeeOrder(
                authoritativeKeyframes,
              );

              record.pendingCapture = buildCaptureTourSpec({
                runId,
                phase: 'revision',
                snapshot: record.bestSnapshot,
                evaluation: record.bestEvaluation,
                orderedAttendeeIds,
                deadlineIso: record.deadlineIso,
              });

              await transitionState(record, 'rendering_revision');
            } else {
              // Rejected patch: retain baselineSnapshot as bestSnapshot and finish with no_improvement
              record.bestSnapshot = structuredClone(record.baselineSnapshot);
              record.bestEvaluation = structuredClone(
                record.baselineEvaluation,
              );
              record.outcome = 'no_improvement';
              record.terminalReason =
                rejectionReasons.join('; ') ||
                'Proposed patch did not improve the venue layout.';
              record.pendingCapture = undefined;
              if (activeRunId === runId) activeRunId = null;
              await transitionState(record, 'finished');
            }
          } else {
            // phase === 'revision'
            record.revisionEvidence = sanitizedManifest;
            record.pendingCapture = undefined;
            await transitionState(record, 'inspecting_revision');

            if (
              refreshDeadlineIfNeeded(record, nowFn()) ||
              isRunFinished(record)
            ) {
              if (activeRunId === runId) activeRunId = null;
              await storage.saveRunRecord(record);
              return {
                runId,
                captureId: sanitizedManifest.captureId,
                deduplicated: false,
                state: record.state,
                outcome: record.outcome,
              };
            }

            const acceptedAttempt = [...record.attempts]
              .reverse()
              .find((a) => a.comparisonOutcome === 'accepted');
            const fallbackPatch: LayoutPatch = acceptedAttempt?.patch ?? {
              contractVersion: CONTRACT_VERSION,
              runId,
              parentSceneHash: record.baselineSnapshot.sceneHash,
              diagnosis: [],
              operations: [],
              summary: 'Accepted layout revision.',
            };

            const remainingCall2Ms =
              Date.parse(record.deadlineIso) - nowFn();

            try {
              const call2Result = await runWithRemainingDeadline(
                remainingCall2Ms,
                (abortSignal, timeoutMs) =>
                  argonProvider.inspectRevision({
                    runId,
                    revisedSnapshot: structuredClone(record.bestSnapshot),
                    revisedManifest: sanitizedManifest,
                    revisedVideoBuffer: videoBuffer,
                    baselineEvaluation: structuredClone(
                      record.baselineEvaluation,
                    ),
                    revisedEvaluation: structuredClone(record.bestEvaluation),
                    acceptedPatch: fallbackPatch,
                    abortSignal,
                    timeoutMs,
                  }),
              );

              record.providerModel = call2Result.providerModel;
              if (call2Result.providerRequestId) {
                record.providerRequestIds.push(call2Result.providerRequestId);
              }

              if (
                refreshDeadlineIfNeeded(record, nowFn()) ||
                isRunFinished(record)
              ) {
                if (activeRunId === runId) activeRunId = null;
                await storage.saveRunRecord(record);
                return {
                  runId,
                  captureId: sanitizedManifest.captureId,
                  deduplicated: false,
                  state: record.state,
                  outcome: record.outcome,
                };
              }

              record.finalInspection = call2Result.report;
              record.outcome = 'improved';
              if (activeRunId === runId) activeRunId = null;
              await transitionState(record, 'finished');
            } catch (err) {
              // Preserve verified bestSnapshot / bestEvaluation even if Call 2 fails or times out
              const expiredDuringCall2 = refreshDeadlineIfNeeded(
                record,
                nowFn(),
              );
              if (expiredDuringCall2 || isRunFinished(record)) {
                if (activeRunId === runId) activeRunId = null;
                await storage.saveRunRecord(record);
              } else {
                record.outcome =
                  record.bestSnapshot.sceneHash !==
                  record.baselineSnapshot.sceneHash
                    ? 'partial_incomplete'
                    : 'failure';
                record.terminalReason = `Argon Call 2 failed after verified layout improvement: ${(err as Error).message}`;
                if (activeRunId === runId) activeRunId = null;
                await transitionState(record, 'finished');
              }
            }
          }

          return {
            runId,
            captureId: sanitizedManifest.captureId,
            deduplicated: false,
            state: record.state,
            outcome: record.outcome,
          };
        })();

        inFlightCaptures.set(dedupKey, processCapturePromise);
        try {
          const result = await processCapturePromise;
          res.json(result);
        } finally {
          inFlightCaptures.delete(dedupKey);
        }
      } catch (err) {
        res.status(500).json({
          error: `Evidence processing failed: ${(err as Error).message}`,
        });
      }
    },
  );

  // Structured JSON error handler for Multer & body-parser errors
  app.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      _next: NextFunction,
    ): void => {
      if (err instanceof multer.MulterError) {
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        res.status(status).json({
          error: `Multipart upload error (${err.code}): ${err.message}`,
        });
        return;
      }
      if (
        err instanceof SyntaxError &&
        'status' in err &&
        typeof (err as { status?: unknown }).status === 'number'
      ) {
        res.status(400).json({
          error: `Malformed JSON request body: ${err.message}`,
        });
        return;
      }
      const message =
        err instanceof Error ? err.message : 'Unexpected server error.';
      res.status(500).json({ error: message });
    },
  );

  return app;
}
