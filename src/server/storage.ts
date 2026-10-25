/**
 * Stream C — Local Disk Persistence (`src/server/storage.ts`)
 * Exclusive ownership: Workstream C (`src/server/`, `tests/server/`).
 *
 * Persists each run's `RunRecord` JSON (`runs/<runId>/run.json`) and
 * uploaded baseline/revision video clips (`runs/<runId>/<captureId>.webm` or `.mp4`)
 * under `process.env.RUNS_DIR || './runs'`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunRecord } from '../shared/index.js';

function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function resolveVideoExtension(mimeType?: string): '.webm' | '.mp4' {
  if (!mimeType) return '.webm';
  const base = mimeType.split(';')[0]?.trim().toLowerCase();
  if (base === 'video/mp4') return '.mp4';
  return '.webm';
}

export interface RunStorage {
  readonly baseDir: string;
  saveRunRecord(record: RunRecord): Promise<string>;
  loadRunRecord(runId: string): Promise<RunRecord | null>;
  saveEvidenceVideo(
    runId: string,
    captureId: string,
    videoBuffer: Buffer,
    mimeType?: string,
  ): Promise<string>;
}

export function resolveRunsDir(customDir?: string): string {
  const raw = customDir ?? process.env.RUNS_DIR ?? './runs';
  return path.resolve(raw);
}

export function createRunStorage(customDir?: string): RunStorage {
  const baseDir = resolveRunsDir(customDir);

  function getRunDir(runId: string): string {
    return path.join(baseDir, sanitizePathSegment(runId));
  }

  return {
    baseDir,

    async saveRunRecord(record: RunRecord): Promise<string> {
      const runDir = getRunDir(record.runId);
      await fs.mkdir(runDir, { recursive: true });
      const filePath = path.join(runDir, 'run.json');
      const tmpPath = path.join(
        runDir,
        `run.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
      );
      const serialized = JSON.stringify(record, null, 2);
      await fs.writeFile(tmpPath, serialized, 'utf-8');
      await fs.rename(tmpPath, filePath);
      return filePath;
    },

    async loadRunRecord(runId: string): Promise<RunRecord | null> {
      const runDir = getRunDir(runId);
      const filePath = path.join(runDir, 'run.json');
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(raw) as RunRecord;
      } catch {
        return null;
      }
    },

    async saveEvidenceVideo(
      runId: string,
      captureId: string,
      videoBuffer: Buffer,
      mimeType?: string,
    ): Promise<string> {
      const runDir = getRunDir(runId);
      await fs.mkdir(runDir, { recursive: true });
      const safeCaptureId = sanitizePathSegment(captureId);
      const ext = resolveVideoExtension(mimeType);
      const hasKnownExt =
        safeCaptureId.endsWith('.webm') || safeCaptureId.endsWith('.mp4');
      const fileName = hasKnownExt ? safeCaptureId : `${safeCaptureId}${ext}`;
      const filePath = path.join(runDir, fileName);
      await fs.writeFile(filePath, videoBuffer);
      return filePath;
    },
  };
}
