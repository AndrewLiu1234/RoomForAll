/**
 * Stream A — Scene & Evidence Capture (`src/scene/index.ts`)
 * Exclusive ownership: Workstream A (`public/venue/`, `scripts/prepare-venue.*`, `src/scene/`, `tests/scene/`).
 *
 * Required exports per PRD §10 Step 2 & ARGON_MVP_PROMPT.md §2:
 * - `VenueViewport` component & `VenueViewportProps`
 * - `captureEvidence(snapshot, tourSpec)` returning `{ videoBlob, manifest }`
 * - `createPreparedVenueSnapshot()` & `createPreparedVenueReferencePatch()`
 * - Camera & Three.js scene helpers (`buildDefaultCaptureKeyframes`, `buildVenueThreeScene`, `applyActiveViewerVisibility`, etc.)
 */
export {
  VenueViewport,
  computeInitialOrbit,
  type VenueViewportProps,
} from './VenueViewport.js';

export {
  captureEvidence,
  normalizeContainerMimeType,
  selectSupportedMediaMimeType,
} from './captureEvidence.js';

export {
  PREPARED_VENUE_GLB_PATH,
  PREPARED_VENUE_MANIFEST_PATH,
  PREPARED_VENUE_SCENE_ID,
  createPreparedVenueReferencePatch,
  createPreparedVenueSnapshot,
  generateVenueGlbBinary,
  loadPreparedVenueManifest,
  parseVenueGlbBinary,
} from './preparedVenue.js';

export {
  generateSampleCustomAuditoriumGlb,
  parseAndLabelGlbVenue,
  type AutoLabeledGlbNode,
  type AutoLabeledNodeRole,
  type GlbVenueParseReport,
} from './glbAutoLabeler.js';

export {
  applyAttendeeCameraPose,
  applyKeyframeToCamera,
  applyOverviewCameraPose,
  buildDefaultCaptureKeyframes,
  getActiveKeyframeAtTime,
  getOverviewCameraPose,
  type OverviewCameraPose,
  type OverviewCameraPreset,
} from './cameraSystem.js';

export {
  applyActiveViewerVisibility,
  buildVenueThreeScene,
  disposeVenueScene,
  getProxyWorldTransform,
  type BuildVenueSceneOptions,
  type BuiltVenueScene,
} from './sceneBuilder.js';

export { createDeterministicWebmBytes } from './webmCodec.js';
