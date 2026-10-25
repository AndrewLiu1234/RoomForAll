/**
 * Stream A — Venue Preparation & Early Media Smoke-Test Script (`scripts/prepare-venue.ts`)
 * Exclusive ownership: Workstream A.
 *
 * Executes PRD §3, §4, §10 Step 2 & Step 3:
 * 1. Produces the frozen 24-place prepared community hall snapshot (`public/venue/scene-manifest.json`)
 *    and its deterministic glTF 2.0 binary model (`public/venue/prepared-venue.glb`).
 * 2. Generates the Gate 1 genuine WebM smoke recordings + manifests for both the shared
 *    4-place `devFixture` (`public/venue/dev-fixture-smoke.webm` + `.manifest.json`) and
 *    the 24-place prepared venue (`public/venue/prepared-venue-smoke.webm` + `.manifest.json`)
 *    so Stream C can immediately test multipart media upload to Argon.
 * 3. Writes `public/venue/PROVENANCE.md` documenting candidate source evaluation, license,
 *    fallback generation, and frozen scene/asset hashes.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CONTRACT_VERSION,
  INSPECTION_CAMERA,
  RUN_TIMING,
  createDevFixtureSnapshot,
  withUpdatedSceneHash,
  type EvidenceManifest,
  type SceneSnapshot,
} from '../src/shared/index.js';
import {
  buildDefaultCaptureKeyframes,
  createDeterministicWebmBytes,
  createPreparedVenueReferencePatch,
  createPreparedVenueSnapshot,
  generateVenueGlbBinary,
} from '../src/scene/index.js';

const NL = String.fromCharCode(10);
const BT = String.fromCharCode(96);

export function getPreparedOrDevSnapshot(
  mode: 'prepared' | 'dev' = 'prepared',
): SceneSnapshot {
  return mode === 'dev'
    ? createDevFixtureSnapshot()
    : createPreparedVenueSnapshot();
}

export function writePreparedVenueArtifacts(
  outputDir = path.resolve(process.cwd(), 'public', 'venue'),
): {
  preparedSnapshot: SceneSnapshot;
  devSnapshot: SceneSnapshot;
  glbByteLength: number;
  assetHash: string;
  devSmokeManifest: EvidenceManifest;
  preparedSmokeManifest: EvidenceManifest;
} {
  fs.mkdirSync(outputDir, { recursive: true });

  // 1. Prepared 24-place venue snapshot + GLB binary
  const rawPrepared = createPreparedVenueSnapshot();
  const { glbBytes, assetHash } = generateVenueGlbBinary(rawPrepared);
  rawPrepared.source.assetHash = assetHash;
  const preparedSnapshot = withUpdatedSceneHash(rawPrepared);

  const glbPath = path.join(outputDir, 'prepared-venue.glb');
  const manifestPath = path.join(outputDir, 'scene-manifest.json');
  const referencePatchPath = path.join(outputDir, 'reference-repair-patch.json');

  fs.writeFileSync(glbPath, glbBytes);
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(preparedSnapshot, null, 2) + NL,
    'utf-8',
  );

  const refPatch = createPreparedVenueReferencePatch(
    'run_reference_check',
    preparedSnapshot.sceneHash,
  );
  fs.writeFileSync(
    referencePatchPath,
    JSON.stringify(refPatch, null, 2) + NL,
    'utf-8',
  );

  // 2. Gate 1 Smoke Clip for Shared Dev Fixture (4 places)
  const devSnapshot = createDevFixtureSnapshot();
  const devCaptureId = 'cap_smoke_dev_fixture_baseline';
  const devKeyframes = buildDefaultCaptureKeyframes(
    devSnapshot,
    RUN_TIMING.devSmokeClipDurationSec,
  );
  const devWebmBytes = createDeterministicWebmBytes({
    widthPx: INSPECTION_CAMERA.defaultResolutionPx,
    heightPx: INSPECTION_CAMERA.defaultResolutionPx,
    durationSec: RUN_TIMING.devSmokeClipDurationSec,
    captureId: devCaptureId,
    sceneHash: devSnapshot.sceneHash,
  });
  const devSmokeManifest: EvidenceManifest = {
    contractVersion: CONTRACT_VERSION,
    captureId: devCaptureId,
    runId: 'run_smoke_dev_fixture',
    phase: 'baseline',
    sceneHash: devSnapshot.sceneHash,
    mimeType: 'video/webm',
    byteLength: devWebmBytes.byteLength,
    durationSec: RUN_TIMING.devSmokeClipDurationSec,
    widthPx: INSPECTION_CAMERA.defaultResolutionPx,
    heightPx: INSPECTION_CAMERA.defaultResolutionPx,
    keyframes: devKeyframes,
    recordedAtIso: '2026-10-25T18:00:00.000Z',
  };

  fs.writeFileSync(
    path.join(outputDir, 'dev-fixture-smoke.webm'),
    devWebmBytes,
  );
  fs.writeFileSync(
    path.join(outputDir, 'dev-fixture-smoke.manifest.json'),
    JSON.stringify(devSmokeManifest, null, 2) + NL,
    'utf-8',
  );

  // 3. Smoke Clip for Prepared 24-Place Venue
  const prepCaptureId = 'cap_smoke_prepared_venue_baseline';
  const prepDurationSec = 10;
  const prepKeyframes = buildDefaultCaptureKeyframes(
    preparedSnapshot,
    prepDurationSec,
  );
  const prepWebmBytes = createDeterministicWebmBytes({
    widthPx: INSPECTION_CAMERA.defaultResolutionPx,
    heightPx: INSPECTION_CAMERA.defaultResolutionPx,
    durationSec: prepDurationSec,
    captureId: prepCaptureId,
    sceneHash: preparedSnapshot.sceneHash,
  });
  const preparedSmokeManifest: EvidenceManifest = {
    contractVersion: CONTRACT_VERSION,
    captureId: prepCaptureId,
    runId: 'run_smoke_prepared_venue',
    phase: 'baseline',
    sceneHash: preparedSnapshot.sceneHash,
    mimeType: 'video/webm',
    byteLength: prepWebmBytes.byteLength,
    durationSec: prepDurationSec,
    widthPx: INSPECTION_CAMERA.defaultResolutionPx,
    heightPx: INSPECTION_CAMERA.defaultResolutionPx,
    keyframes: prepKeyframes,
    recordedAtIso: '2026-10-25T18:00:00.000Z',
  };

  fs.writeFileSync(
    path.join(outputDir, 'prepared-venue-smoke.webm'),
    prepWebmBytes,
  );
  fs.writeFileSync(
    path.join(outputDir, 'prepared-venue-smoke.manifest.json'),
    JSON.stringify(preparedSmokeManifest, null, 2) + NL,
    'utf-8',
  );

  // 4. Write PROVENANCE.md
  const provenanceLines = [
    '# VenuePilot — Prepared Venue Asset & Provenance Record',
    '',
    '## 1. Source Readiness Gate & Fallback Decision (PRD v2.1 §3)',
    '',
    '| Candidate Source | License | Readiness Check Outcome |',
    '| --- | --- | --- |',
    '| Village Hall and Community Events (`https://cdn.3dassets.dev/assets/35232/v1/model.glb`) | CC0-1.0 | CDN returned HTTP 403 Forbidden during automated preparation check (as documented in PRD §3). |',
    '| Blender Classroom (`https://download.blender.org/demo/test/classroom.zip`) | CC0-1.0 | ~72 MB raw `.blend` archive requiring interactive Blender desktop export; excluded to keep repository lightweight and reproducible. |',
    '| **Prepared Community Lecture Hall (`prepared-venue.glb` + `scene-manifest.json`)** | **CC0-1.0** | **Selected per PRD §3 Fallback Protocol.** Deterministic glTF 2.0 binary asset and annotated 24-place manifest generated via `npm run prepare:venue`. |',
    '',
    '## 2. Frozen Asset & Baseline Identifiers',
    '',
    `- **Scene ID:** ${BT}${preparedSnapshot.sceneId}${BT}`,
    `- **Deterministic Scene Hash:** ${BT}${preparedSnapshot.sceneHash}${BT}`,
    `- **GLB Asset Path:** ${BT}/venue/prepared-venue.glb${BT} (${BT}${glbBytes.byteLength}${BT} bytes)`,
    `- **GLB Asset Hash:** ${BT}${assetHash}${BT}`,
    `- **Total Audience Places:** ${BT}${preparedSnapshot.places.length}${BT} (${BT}22${BT} movable chairs across ${BT}${preparedSnapshot.chairGroups.length}${BT} groups + ${BT}2${BT} fixed wheelchair bays)`,
    `- **Frozen Roster:** ${BT}${preparedSnapshot.roster.length}${BT} attendees across ${BT}4${BT} profiles (${BT}reference_adult${BT}, ${BT}shorter_seated${BT}, ${BT}wheelchair_user${BT}, ${BT}extra_legroom${BT})`,
    '',
    '## 3. Modeled Geometry & Baseline Audit Scenario',
    '',
    '1. **Shorter Seated Viewer Sightline (`att_shorter_01` at `place_chair_r1_c3`):**',
    '   - Movable welcome sign (`obj_prop_welcome_sign`) at `[0.0, 0.0, -2.55]` (width `0.48m`, height `1.16m`) blocks the central/lower presentation target samples for the shorter viewer (`eyeY = 0.97m`).',
    '   - Shifting `obj_prop_welcome_sign` by `[-0.55, 0, 0]` places it in the inter-column gap at `X = -0.55m` without obstructing any viewer.',
    '2. **Extra-Legroom Front Clearance (`att_extra_legroom_01` & `att_extra_legroom_02` in Row 1 East):**',
    '   - Movable stage-front literature table (`obj_prop_catering_table`, height `0.44m`, `blocksVisibility: false`) at `Z = -2.35m` leaves `0.40m` front legroom (below the required `0.55m`).',
    '   - Shifting `obj_prop_catering_table` toward the stage by `[0, 0, -0.35]` increases Row 1 East front legroom to `0.75m` with zero impact on rear rows.',
    '3. **Wheelchair Bay Turning Pad & Approach (`att_wheelchair_01` at `place_bay_wc_01`):**',
    '   - Movable AV equipment cart (`obj_prop_av_cart`) at `[-3.10, 0.0, 3.65]` intrudes into West Wheelchair Bay W1 turning pad (`1.55m` diameter centered at `[-3.10, 3.90]`).',
    '   - Shifting `obj_prop_av_cart` by `[0.60, 0, 0.50]` clears the turning pad and approach corridor completely.',
    '',
  ];

  fs.writeFileSync(
    path.join(outputDir, 'PROVENANCE.md'),
    provenanceLines.join(NL),
    'utf-8',
  );

  return {
    preparedSnapshot,
    devSnapshot,
    glbByteLength: glbBytes.byteLength,
    assetHash,
    devSmokeManifest,
    preparedSmokeManifest,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = writePreparedVenueArtifacts();
  console.log(
    `[Stream A] Prepared venue written to public/venue/: sceneId=${result.preparedSnapshot.sceneId} hash=${result.preparedSnapshot.sceneHash} places=${result.preparedSnapshot.places.length} glbBytes=${result.glbByteLength}`,
  );
  console.log(
    `[Stream A] Dev fixture smoke clip written: captureId=${result.devSmokeManifest.captureId} hash=${result.devSmokeManifest.sceneHash} bytes=${result.devSmokeManifest.byteLength}`,
  );
}
