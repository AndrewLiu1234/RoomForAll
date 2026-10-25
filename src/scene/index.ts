/**
 * Stream A — Scene & Evidence Capture (`src/scene/index.ts`)
 * Exclusive ownership: Workstream A (`public/venue/`, `scripts/prepare-venue.*`, `src/scene/`, `tests/scene/`).
 *
 * Required exports per PRD §10 Step 2 & ARGON_MVP_PROMPT.md §2:
 * - `VenueViewport` component / controller
 * - `captureEvidence(snapshot, tourSpec)` returning `{ videoBlob, manifest }`
 */
import type {
  CapturedEvidencePayload,
  CaptureTourSpec,
  SceneSnapshot,
} from '../shared/index.js';

export interface VenueViewportProps {
  snapshot: SceneSnapshot;
  selectedAttendeeId?: string;
  viewMode: 'overview' | 'attendee_pov';
  onSelectAttendee?: (attendeeId: string) => void;
}

/**
 * Stream A entrypoint for recording real browser media for a `CaptureTourSpec`.
 * Stream A implements the dedicated WebGL capture canvas + MediaRecorder pipeline here.
 */
export async function captureEvidence(
  snapshot: SceneSnapshot,
  tourSpec: CaptureTourSpec,
): Promise<CapturedEvidencePayload> {
  if (snapshot.sceneHash !== tourSpec.sceneHash) {
    throw new Error(
      `Scene hash mismatch: snapshot=${snapshot.sceneHash} vs tourSpec=${tourSpec.sceneHash}`,
    );
  }
  throw new Error(
    'Not yet implemented: Stream A owns captureEvidence(snapshot, tourSpec) in src/scene/',
  );
}
