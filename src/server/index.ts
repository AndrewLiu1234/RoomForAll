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
import express, { type Express } from 'express';
import multer from 'multer';
import {
  CONTRACT_VERSION,
  RUN_TIMING,
  createDevFixtureSnapshot,
  withUpdatedSceneHash,
  type CreateRunRequest,
  type CreateRunResponse,
  type EvidenceManifest,
  type GetRunResponse,
  type PreviewRequest,
  type PreviewResponse,
  type RunRecord,
  type UploadEvidenceResponse,
} from '../shared/index.js';
import { evaluateScene } from '../evaluation/index.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

function refreshDeadlineIfNeeded(record: RunRecord): void {
  if (record.state === 'finished') return;
  const nowMs = Date.now();
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
  }
}

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  const runs = new Map<string, RunRecord>();
  const uploadedCaptures = new Set<string>();
  let activeRunId: string | null = null;

  app.post('/api/preview', (req, res) => {
    const body = (req.body ?? {}) as PreviewRequest;
    const baseSnapshot = body.snapshot ?? createDevFixtureSnapshot();
    const mergedSnapshot = withUpdatedSceneHash({
      ...baseSnapshot,
      profiles: body.profiles
        ? { ...baseSnapshot.profiles, ...body.profiles }
        : baseSnapshot.profiles,
      roster: body.roster ?? baseSnapshot.roster,
    });
    const evaluation = evaluateScene(mergedSnapshot);
    const payload: PreviewResponse = {
      snapshot: mergedSnapshot,
      evaluation,
    };
    res.json(payload);
  });

  app.post('/api/runs', (req, res) => {
    if (activeRunId) {
      const existing = runs.get(activeRunId);
      if (existing) {
        refreshDeadlineIfNeeded(existing);
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
    const evaluation = evaluateScene(snapshot);
    const now = new Date();
    const deadline = new Date(now.getTime() + RUN_TIMING.liveDeadlineMs);
    const runId = `run_${now.getTime()}`;
    const captureId = `cap_${runId}_baseline`;

    const record: RunRecord = {
      contractVersion: CONTRACT_VERSION,
      runId,
      state: 'capturing_baseline',
      outcome: 'in_progress',
      createdAtIso: now.toISOString(),
      updatedAtIso: now.toISOString(),
      deadlineIso: deadline.toISOString(),
      elapsedMs: 0,
      baselineSnapshot: structuredClone(snapshot),
      baselineEvaluation: structuredClone(evaluation),
      bestSnapshot: structuredClone(snapshot),
      bestEvaluation: structuredClone(evaluation),
      pendingCapture: {
        captureId,
        runId,
        phase: 'baseline',
        sceneHash: snapshot.sceneHash,
        snapshot: structuredClone(snapshot),
        keyframes: [],
        totalDurationSec: RUN_TIMING.devSmokeClipDurationSec,
        deadlineIso: deadline.toISOString(),
      },
      attempts: [],
      providerRequestIds: [],
    };

    runs.set(runId, record);
    activeRunId = runId;

    const response: CreateRunResponse = {
      runId,
      state: record.state,
      sceneHash: snapshot.sceneHash,
      deadlineIso: record.deadlineIso,
      pendingCapture: record.pendingCapture,
    };
    res.status(201).json(response);
  });

  app.get('/api/runs/:id', (req, res) => {
    const record = runs.get(req.params.id);
    if (!record) {
      res.status(404).json({ error: `Run ${req.params.id} not found.` });
      return;
    }
    refreshDeadlineIfNeeded(record);
    const payload: GetRunResponse = { run: record };
    res.json(payload);
  });

  app.post(
    '/api/runs/:id/evidence',
    upload.single('video'),
    (req, res) => {
      const rawId = req.params.id;
      const runId = Array.isArray(rawId) ? (rawId[0] ?? '') : (rawId ?? '');
      const record = runs.get(runId);
      if (!record) {
        res.status(404).json({ error: `Run ${runId} not found.` });
        return;
      }

      refreshDeadlineIfNeeded(record);
      if (record.state === 'finished') {
        res.status(409).json({
          error: `Run ${runId} is already finished (${record.outcome}).`,
        });
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

      const dedupKey = `${runId}:${manifest.captureId}`;
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

      if (!req.file || req.file.size === 0) {
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

      uploadedCaptures.add(dedupKey);
      if (manifest.phase === 'revision') {
        record.revisionEvidence = manifest;
      } else {
        record.baselineEvidence = manifest;
      }
      record.pendingCapture = undefined;
      record.updatedAtIso = new Date().toISOString();

      const okResponse: UploadEvidenceResponse = {
        runId,
        captureId: manifest.captureId,
        deduplicated: false,
        state: record.state,
        outcome: record.outcome,
      };
      res.json(okResponse);
    },
  );

  return app;
}
