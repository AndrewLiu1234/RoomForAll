/**
 * Stream C — Gemini / Argon Provider Adapter (`src/server/argonClient.ts`)
 * Exclusive ownership: Workstream C (`src/server/`, `tests/server/`).
 *
 * Implements the two real video-backed Argon calls required by PRD §7:
 * 1. `critiqueAndProposePatch`:
 *    - Builds sanitized input solely via `createBlindCritiquePayload(snapshot, manifest)`.
 *    - NEVER includes `Evaluation`, pass/fail flags, `sampledVisibility`,
 *      `failedRequirements`, or `primaryBlockerIds`.
 *    - Sends actual uploaded video bytes (`video/webm` or `video/mp4`) via inline base64
 *      or the Gemini Files API (`ACTIVE` state polling + cleanup).
 *    - Requests structured JSON matching `LayoutPatch` (`diagnosis`, `operations`, `summary`)
 *      enforcing `PATCH_CONSTRAINTS`.
 * 2. `inspectRevision`:
 *    - Supplies the revised video bytes, revised `EvidenceManifest`, and verified
 *      before/after `Evaluation` metrics to Argon.
 *    - Requests structured JSON matching `FinalInspectionReport`.
 *
 * Supports injectable provider interfaces for deterministic testing in `tests/server/`
 * while failing honestly (throwing an explicit error recorded in `terminalReason`) if a
 * live model call is attempted without `GEMINI_API_KEY`.
 */
import { GoogleGenAI, Type, type Part, type Schema } from '@google/genai';
import {
  CONTRACT_VERSION,
  PATCH_CONSTRAINTS,
  createBlindCritiquePayload,
  type BlindCritiquePayload,
  type Evaluation,
  type EvidenceFinding,
  type EvidenceManifest,
  type FinalInspectionReport,
  type LayoutPatch,
  type PatchOperation,
  type SceneSnapshot,
} from '../shared/index.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-4-argon';
const INLINE_VIDEO_MAX_BYTES = 18 * 1024 * 1024; // 18 MB threshold for fast inline base64 submission

export interface CritiqueAndProposePatchInput {
  runId: string;
  snapshot: SceneSnapshot;
  manifest: EvidenceManifest;
  videoBuffer: Buffer;
  /** Injected by `critiqueAndProposePatch` using `createBlindCritiquePayload(snapshot, manifest)` */
  blindPayload: BlindCritiquePayload;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

export interface CritiqueAndProposePatchResult {
  patch: LayoutPatch;
  providerRequestId: string;
  providerModel: string;
}

export interface InspectRevisionInput {
  runId: string;
  revisedSnapshot: SceneSnapshot;
  revisedManifest: EvidenceManifest;
  revisedVideoBuffer: Buffer;
  baselineEvaluation: Evaluation;
  revisedEvaluation: Evaluation;
  acceptedPatch: LayoutPatch;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

export interface InspectRevisionResult {
  report: FinalInspectionReport;
  providerRequestId: string;
  providerModel: string;
}

export interface ArgonProviderAdapter {
  readonly modelName: string;
  critiqueAndProposePatch(
    input: Omit<CritiqueAndProposePatchInput, 'blindPayload'> & {
      blindPayload?: BlindCritiquePayload;
    },
  ): Promise<CritiqueAndProposePatchResult>;
  inspectRevision(input: InspectRevisionInput): Promise<InspectRevisionResult>;
}

const EVIDENCE_FINDING_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    attendeeId: {
      type: Type.STRING,
      description: 'Optional attendeeId if finding applies to a specific attendee view.',
    },
    viewId: {
      type: Type.STRING,
      description: 'Required viewId from evidenceManifest.keyframes.',
    },
    timestampSec: {
      type: Type.NUMBER,
      description: 'Timestamp in seconds within the video clip where this observation occurs.',
    },
    observation: {
      type: Type.STRING,
      description: 'Concise visual observation tied to the recorded clip.',
    },
    isUnmeasuredVisualNote: {
      type: Type.BOOLEAN,
      description: 'Set true for unmeasured visual notes such as glare or lighting.',
    },
  },
  required: ['viewId', 'timestampSec', 'observation'],
};

const LAYOUT_PATCH_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    diagnosis: {
      type: Type.ARRAY,
      items: EVIDENCE_FINDING_SCHEMA,
      description: 'Visual findings from the baseline inspection clip.',
    },
    operations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          targetType: {
            type: Type.STRING,
            enum: ['object', 'group'],
          },
          targetId: {
            type: Type.STRING,
          },
          deltaPositionM: {
            type: Type.ARRAY,
            items: { type: Type.NUMBER },
            description:
              '[dx, dy, dz] in 0.05m increments. |dx|<=0.60, |dy|<=0.60, |dz|<=0.60. For chairGroups, dy adjusts row elevation for tiered seating.',
          },
          deltaYawDeg: {
            type: Type.NUMBER,
            description: 'Yaw change in degrees, |deltaYawDeg| <= 10.',
          },
          reason: {
            type: Type.STRING,
          },
        },
        required: [
          'targetType',
          'targetId',
          'deltaPositionM',
          'deltaYawDeg',
          'reason',
        ],
      },
      description: `Up to ${PATCH_CONSTRAINTS.maxOperations} bounded non-overlapping operations on editable objects or chairGroups.`,
    },
    summary: {
      type: Type.STRING,
      description: 'Concise summary of the proposed layout repair.',
    },
  },
  required: ['diagnosis', 'operations', 'summary'],
};

const FINAL_INSPECTION_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    findings: {
      type: Type.ARRAY,
      items: EVIDENCE_FINDING_SCHEMA,
      description: 'Evidence-linked findings from the revised video clip.',
    },
    remainingIssuesSummary: {
      type: Type.STRING,
      description:
        'Summary of verified improvements and any remaining issues after the revision.',
    },
  },
  required: ['findings', 'remainingIssuesSummary'],
};

/**
 * Runtime guard verifying that a Call 1 payload contains zero forbidden evaluation fields.
 * Enforces PRD §7 blind critique invariant.
 */
export function assertBlindCritiquePayloadClean(payload: unknown): void {
  const serialized = JSON.stringify(payload);
  const forbiddenKeys = [
    '"sampledVisibility"',
    '"failedRequirements"',
    '"primaryBlockerIds"',
    '"isViewClear"',
    '"clearAndUsable"',
    '"baselineEvaluation"',
    '"bestEvaluation"',
    '"allModeledRequirementsMet"',
  ];
  for (const forbidden of forbiddenKeys) {
    if (serialized.includes(forbidden)) {
      throw new Error(
        `CRITICAL PRD §7 VIOLATION: Blind critique payload contains forbidden evaluation field ${forbidden}.`,
      );
    }
  }
}

function normalizeMimeType(rawMimeType: string | undefined): string {
  if (!rawMimeType) return 'video/webm';
  const base = rawMimeType.split(';')[0]?.trim().toLowerCase();
  if (base === 'video/mp4' || base === 'video/webm') {
    return base;
  }
  return 'video/webm';
}

interface PreparedVideoPart {
  part: Part;
  cleanup: () => Promise<void>;
}

async function buildVideoMediaPart(
  ai: GoogleGenAI,
  videoBuffer: Buffer,
  mimeType: string,
  pollTimeoutMs = 30_000,
  abortSignal?: AbortSignal,
): Promise<PreparedVideoPart> {
  if (!videoBuffer || videoBuffer.byteLength === 0) {
    throw new Error('Cannot submit empty video buffer to Argon provider.');
  }

  const normalizedMime = normalizeMimeType(mimeType);

  if (videoBuffer.byteLength <= INLINE_VIDEO_MAX_BYTES) {
    return {
      part: {
        inlineData: {
          mimeType: normalizedMime,
          data: videoBuffer.toString('base64'),
        },
      },
      cleanup: async () => {},
    };
  }

  // Fallback to Gemini Files API with ACTIVE state polling for large clips
  const blob = new Blob([new Uint8Array(videoBuffer)], { type: normalizedMime });
  const uploaded = await ai.files.upload({
    file: blob,
    config: { mimeType: normalizedMime, abortSignal },
  });

  if (!uploaded.name) {
    throw new Error('Gemini Files API upload did not return a file name.');
  }

  const uploadedName = uploaded.name;
  const cleanup = async (): Promise<void> => {
    try {
      await ai.files.delete({ name: uploadedName });
    } catch {
      // Ignore cleanup errors
    }
  };

  try {
    let fileRecord = uploaded;
    const startMs = Date.now();
    while (fileRecord.state === 'PROCESSING') {
      if (abortSignal?.aborted) {
        throw new Error('Aborted while waiting for Gemini File processing.');
      }
      if (Date.now() - startMs > pollTimeoutMs) {
        throw new Error(
          `Timed out waiting for Gemini File ${uploadedName} to become ACTIVE.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      fileRecord = await ai.files.get({
        name: uploadedName,
        config: { abortSignal },
      });
    }

    if (fileRecord.state && fileRecord.state !== 'ACTIVE') {
      throw new Error(
        `Gemini File ${uploadedName} entered non-ACTIVE state: ${fileRecord.state}`,
      );
    }

    if (!fileRecord.uri) {
      throw new Error(`Gemini File ${uploadedName} is missing a fileUri.`);
    }

    return {
      part: {
        fileData: {
          fileUri: fileRecord.uri,
          mimeType: fileRecord.mimeType ?? normalizedMime,
        },
      },
      cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

function parseFindings(
  rawFindings: unknown,
  fallbackViewId: string,
): EvidenceFinding[] {
  if (!Array.isArray(rawFindings)) return [];
  const findings: EvidenceFinding[] = [];
  for (const item of rawFindings) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const viewId =
      typeof rec.viewId === 'string' && rec.viewId.trim().length > 0
        ? rec.viewId.trim()
        : fallbackViewId;
    const timestampSec =
      typeof rec.timestampSec === 'number' && Number.isFinite(rec.timestampSec)
        ? Math.max(0, Number(rec.timestampSec.toFixed(2)))
        : 0;
    const observation =
      typeof rec.observation === 'string' && rec.observation.trim().length > 0
        ? rec.observation.trim()
        : 'Visual observation noted.';
    const finding: EvidenceFinding = {
      viewId,
      timestampSec,
      observation,
    };
    if (typeof rec.attendeeId === 'string' && rec.attendeeId.trim().length > 0) {
      finding.attendeeId = rec.attendeeId.trim();
    }
    if (typeof rec.isUnmeasuredVisualNote === 'boolean') {
      finding.isUnmeasuredVisualNote = rec.isUnmeasuredVisualNote;
    }
    findings.push(finding);
  }
  return findings;
}

function parseOperations(rawOperations: unknown): PatchOperation[] {
  if (!Array.isArray(rawOperations)) return [];
  const operations: PatchOperation[] = [];
  for (const item of rawOperations) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const targetType =
      rec.targetType === 'group' ? 'group' : rec.targetType === 'object' ? 'object' : null;
    const targetId =
      typeof rec.targetId === 'string' && rec.targetId.trim().length > 0
        ? rec.targetId.trim()
        : null;
    if (!targetType || !targetId) continue;

    if (!Array.isArray(rec.deltaPositionM) || rec.deltaPositionM.length !== 3) {
      continue;
    }
    const dx =
      typeof rec.deltaPositionM[0] === 'number' &&
      Number.isFinite(rec.deltaPositionM[0])
        ? rec.deltaPositionM[0]
        : 0;
    const dy =
      typeof rec.deltaPositionM[1] === 'number' &&
      Number.isFinite(rec.deltaPositionM[1])
        ? rec.deltaPositionM[1]
        : 0;
    const dz =
      typeof rec.deltaPositionM[2] === 'number' &&
      Number.isFinite(rec.deltaPositionM[2])
        ? rec.deltaPositionM[2]
        : 0;
    const deltaYawDeg =
      typeof rec.deltaYawDeg === 'number' && Number.isFinite(rec.deltaYawDeg)
        ? rec.deltaYawDeg
        : 0;
    const reason =
      typeof rec.reason === 'string' && rec.reason.trim().length > 0
        ? rec.reason.trim()
        : 'Proposed adjustment based on visual critique.';

    operations.push({
      targetType,
      targetId,
      deltaPositionM: [dx, dy, dz],
      deltaYawDeg,
      reason,
    });
  }
  return operations;
}

export function buildCall1Prompt(blindPayload: BlindCritiquePayload): string {
  const ceilingY = blindPayload.roomBounds?.max[1] ?? 3.8;
  const maxPlatformY = (ceilingY - 3.374).toFixed(2);

  return [
    'You are Argon, the visual accessibility, sightline, and emergency evacuation reviewer for VenuePilot (PRD v2.1).',
    'Inspect the attached baseline venue tour video clip (which includes an overhead seating & emergency evacuation flow view followed by attendee POVs) and the structured scene context below.',
    'Do NOT invent hidden structural changes. Diagnose sightline obstructions, route/clearance issues, seating comfort issues, AND emergency evacuation bottlenecks directly from the video and scene geometry.',
    '',
    'EMERGENCY EVACUATION & EGRESS GUIDANCE:',
    '- Check if seat rows or chairGroups are tightly bunched along Z (narrow inter-row clear gap < 0.45m slows down emergency row extrication and traps interior attendees). If rows or seats are bunched together, propose bounded translations on chairGroups or movable_chair objects to space the rows/seats out.',
    '- Check if any venue exit portal (listed in exits or route endpoints, such as exit_emergency_east) or aisle merge is blocked or narrowed by a movable barrier, cart, or prop (e.g., gateObjectId or movable_prop near the exit). If an emergency exit door or corridor is obstructed, move the blocking object clear so evacuees can escape through multiple exits without traffic jams.',
    '',
    'STRICT PATCH CONSTRAINTS:',
    `- Maximum ${PATCH_CONSTRAINTS.maxOperations} operations on non-overlapping targets (never target both a chairGroup and one of its memberObjectIds).`,
    `- Only target IDs listed in editableObjects (targetType: "object") or chairGroups (targetType: "group").`,
    `- Translation deltaPositionM must be [dx, dy, dz] in ${PATCH_CONSTRAINTS.translationStepM} m increments with |dx| <= ${PATCH_CONSTRAINTS.maxAxisDeltaM} m, |dy| <= ${PATCH_CONSTRAINTS.maxAxisDeltaM} m, and |dz| <= ${PATCH_CONSTRAINTS.maxAxisDeltaM} m.`,
    `- Yaw change |deltaYawDeg| <= ${PATCH_CONSTRAINTS.maxYawDeltaDeg} degrees.`,
    `- Total Euclidean horizontal displacement from baselineTransform must remain <= ${PATCH_CONSTRAINTS.maxTotalDisplacementFromBaselineM} m.`,
    `- Aisle Safety Rule: Do NOT shift chairGroups horizontally (dx or dz) into circulation corridors or toward the center aisle, as this blocks attendee approach routes and causes automatic patch rejection.`,
    `- Tiered Seating Priority: To improve sightlines across rows, elevate rear rows vertically using dy in deltaPositionM for chairGroups (e.g., group_row_2 = [0, 0.10, 0], group_row_3 = [0, 0.20, 0], group_row_4 = [0, 0.30, 0]):`,
    `  * Rear rows (further from stage/screen along +Z) must have strictly higher elevation than front rows: Y(Row 1) < Y(Row 2) < Y(Row 3) < Y(Row 4).`,
    `  * Elevation steps between successive rows should be approximately equal (e.g., +0.10m per row).`,
    `  * Maximum ADA ramp incline between successive rows must not exceed 1:12 (slope <= 0.083, dy <= dz / 12).`,
    `  * Headroom: Standing audience members (1.85m tall) must have at least 5 feet (1.52m) of headroom clearance below the ceiling on the highest platform (max platform Y <= ${maxPlatformY}m under ${ceilingY}m ceiling).`,
    `- Wheelchair & Prop Clearance: Relocate movable props (welcome sign, catering table, AV equipment cart) to clear obstructed sightlines and wheelchair turning circles.`,
    '- Every diagnosis item must reference a valid viewId and timestampSec from evidenceManifest.keyframes.',
    '',
    'BLIND CRITIQUE SCENE PAYLOAD (JSON):',
    JSON.stringify(blindPayload),
  ].join(String.fromCharCode(10));
}

export function buildCall2Prompt(input: InspectRevisionInput): string {
  const verificationContext = {
    contractVersion: CONTRACT_VERSION,
    runId: input.runId,
    revisedSceneHash: input.revisedSnapshot.sceneHash,
    revisedEvidenceManifest: input.revisedManifest,
    acceptedPatch: input.acceptedPatch,
    baselineEvaluation: {
      sceneHash: input.baselineEvaluation.sceneHash,
      allModeledRequirementsMet: input.baselineEvaluation.allModeledRequirementsMet,
      comparison: input.baselineEvaluation.comparison,
      evacuation: input.baselineEvaluation.evacuation,
      perProfile: input.baselineEvaluation.perProfile,
      attendees: input.baselineEvaluation.attendees,
    },
    revisedEvaluation: {
      sceneHash: input.revisedEvaluation.sceneHash,
      allModeledRequirementsMet: input.revisedEvaluation.allModeledRequirementsMet,
      comparison: input.revisedEvaluation.comparison,
      evacuation: input.revisedEvaluation.evacuation,
      perProfile: input.revisedEvaluation.perProfile,
      attendees: input.revisedEvaluation.attendees,
    },
  };

  return [
    'You are Argon performing the final visual reinspection for VenuePilot (PRD v2.1 §7).',
    'Inspect the attached revised venue tour video clip alongside the verified before/after evaluation and emergency evacuation metrics below.',
    'Provide evidence-linked findings tied to viewIds and timestamps in revisedEvidenceManifest.keyframes, and summarize verified improvements in sightlines, accessibility, and emergency evacuation flow (such as reduced totalEvacuationTimeSec, spaced-out rows, and cleared emergency exits) as well as any remaining issues.',
    '',
    'REVISED SCENE & VERIFIED EVALUATION CONTEXT (JSON):',
    JSON.stringify(verificationContext),
  ].join(String.fromCharCode(10));
}

export interface CreateGeminiArgonAdapterOptions {
  apiKey?: string;
  model?: string;
}

/**
 * Creates the official `@google/genai` Argon provider adapter.
 * Reads `process.env.GEMINI_API_KEY` and `process.env.GEMINI_MODEL` by default.
 * Fails honestly with an explicit error if invoked without credentials.
 */
export function createGeminiArgonAdapter(
  options: CreateGeminiArgonAdapterOptions = {},
): ArgonProviderAdapter {
  const envModel = process.env.GEMINI_MODEL?.trim();
  const resolvedEnvModel =
    envModel === 'gemini-2.5-pro' ? DEFAULT_GEMINI_MODEL : envModel;
  const modelName =
    options.model?.trim() || resolvedEnvModel || DEFAULT_GEMINI_MODEL;

  function getClient(): GoogleGenAI {
    const apiKey = options.apiKey?.trim() || process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        'Missing GEMINI_API_KEY environment variable; cannot execute live Argon model call.',
      );
    }
    return new GoogleGenAI({ apiKey });
  }

  return {
    modelName,

    async critiqueAndProposePatch(input): Promise<CritiqueAndProposePatchResult> {
      const blindPayload =
        input.blindPayload ??
        createBlindCritiquePayload(input.snapshot, input.manifest);

      assertBlindCritiquePayloadClean(blindPayload);

      const ai = getClient();
      const pollTimeout = input.timeoutMs
        ? Math.min(30_000, Math.max(1_000, input.timeoutMs))
        : 30_000;
      const prepared = await buildVideoMediaPart(
        ai,
        input.videoBuffer,
        input.manifest.mimeType,
        pollTimeout,
        input.abortSignal,
      );

      try {
        const promptText = buildCall1Prompt(blindPayload);

        const response = await ai.models.generateContent({
          model: modelName,
          contents: [
            {
              role: 'user',
              parts: [prepared.part, { text: promptText }],
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema: LAYOUT_PATCH_SCHEMA,
            temperature: 0.1,
            abortSignal: input.abortSignal,
          },
        });

        const rawText = response.text;
        if (!rawText) {
          throw new Error('Argon Call 1 returned an empty response body.');
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(rawText) as Record<string, unknown>;
        } catch (err) {
          throw new Error(
            `Argon Call 1 returned invalid JSON: ${(err as Error).message}`,
          );
        }

        const fallbackViewId =
          input.manifest.keyframes[0]?.viewId ?? 'view_overview_room';
        const patch: LayoutPatch = {
          contractVersion: CONTRACT_VERSION,
          runId: input.runId,
          parentSceneHash: input.snapshot.sceneHash,
          diagnosis: parseFindings(parsed.diagnosis, fallbackViewId),
          operations: parseOperations(parsed.operations),
          summary:
            typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
              ? parsed.summary.trim()
              : 'Proposed bounded layout adjustment from baseline video inspection.',
        };

        const providerRequestId =
          (response as unknown as { responseId?: string }).responseId ??
          `gemini_req_call1_${Date.now()}`;

        return {
          patch,
          providerRequestId,
          providerModel: modelName,
        };
      } finally {
        await prepared.cleanup();
      }
    },

    async inspectRevision(input): Promise<InspectRevisionResult> {
      const ai = getClient();
      const pollTimeout = input.timeoutMs
        ? Math.min(30_000, Math.max(1_000, input.timeoutMs))
        : 30_000;
      const prepared = await buildVideoMediaPart(
        ai,
        input.revisedVideoBuffer,
        input.revisedManifest.mimeType,
        pollTimeout,
        input.abortSignal,
      );

      try {
        const promptText = buildCall2Prompt(input);

        const response = await ai.models.generateContent({
          model: modelName,
          contents: [
            {
              role: 'user',
              parts: [prepared.part, { text: promptText }],
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema: FINAL_INSPECTION_SCHEMA,
            temperature: 0.1,
            abortSignal: input.abortSignal,
          },
        });

        const rawText = response.text;
        if (!rawText) {
          throw new Error('Argon Call 2 returned an empty response body.');
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(rawText) as Record<string, unknown>;
        } catch (err) {
          throw new Error(
            `Argon Call 2 returned invalid JSON: ${(err as Error).message}`,
          );
        }

        const fallbackViewId =
          input.revisedManifest.keyframes[0]?.viewId ?? 'view_overview_room';
        const providerRequestId =
          (response as unknown as { responseId?: string }).responseId ??
          `gemini_req_call2_${Date.now()}`;

        const report: FinalInspectionReport = {
          captureId: input.revisedManifest.captureId,
          sceneHash: input.revisedSnapshot.sceneHash,
          findings: parseFindings(parsed.findings, fallbackViewId),
          remainingIssuesSummary:
            typeof parsed.remainingIssuesSummary === 'string' &&
            parsed.remainingIssuesSummary.trim().length > 0
              ? parsed.remainingIssuesSummary.trim()
              : 'Completed visual reinspection of revised layout.',
          providerResponseId: providerRequestId,
        };

        return {
          report,
          providerRequestId,
          providerModel: modelName,
        };
      } finally {
        await prepared.cleanup();
      }
    },
  };
}
