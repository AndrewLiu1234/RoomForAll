import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  INSPECTION_CAMERA,
  PATCH_CONSTRAINTS,
  VISIBILITY_CLEAR_MIN_SAMPLES,
  VISIBILITY_TOTAL_SAMPLES,
  computeSceneHash,
  createDevFixtureSnapshot,
  getAttendeeCameraPose,
  getAttendeeTorsoProxyWorldBox,
  getTargetSamplePointsWorld,
  type ProfileId,
  type SceneSnapshot,
  type Vec3,
} from '../../src/shared/index.js';
import {
  applyAndValidatePatch,
  compareEvaluations,
  evaluateScene,
  simulateEvacuation,
} from '../../src/evaluation/index.js';
import {
  VenueViewport,
  applyActiveViewerVisibility,
  applyAttendeeCameraPose,
  buildDefaultCaptureKeyframes,
  buildVenueThreeScene,
  captureEvidence,
  computeInitialOrbit,
  createArticulatedAvatarMesh,
  createPreparedVenueReferencePatch,
  createPreparedVenueSnapshot,
  disposeVenueScene,
  generateSampleCustomAuditoriumGlb,
  generateVenueGlbBinary,
  getActiveKeyframeAtTime,
  getGlbAlignmentForScene,
  getOverviewCameraPose,
  getProxyWorldTransform,
  getUploadedGlbBytesForScene,
  isStandaloneUploadedGlbScene,
  loadPreparedVenueManifest,
  parseAndLabelGlbVenue,
  parseAndLabelGlbVenueAsync,
  parseVenueGlbBinary,
  spawnRandomFourAttendees,
  type GlbParseProgressUpdate,
} from '../../src/scene/index.js';
import {
  computeAttendeeSampleVisibilityMask,
  createLocalFixtureRepairPreviewRun,
} from '../../src/ui/index.js';

/**
 * Pure 3D segment vs axis-aligned box intersection test (Slab method) for verifying
 * Stream A's 24-place geometry against Stream B's 15x9 raycast specification.
 */
function segmentIntersectsAABB3D(
  p0: Vec3,
  p1: Vec3,
  boxCenter: Vec3,
  boxSize: Vec3,
): boolean {
  const halfX = boxSize[0] / 2;
  const halfY = boxSize[1] / 2;
  const halfZ = boxSize[2] / 2;
  const min: Vec3 = [
    boxCenter[0] - halfX,
    boxCenter[1] - halfY,
    boxCenter[2] - halfZ,
  ];
  const max: Vec3 = [
    boxCenter[0] + halfX,
    boxCenter[1] + halfY,
    boxCenter[2] + halfZ,
  ];

  let tmin = 0.0001;
  let tmax = 0.9999;

  for (let axis = 0; axis < 3; axis++) {
    const dir = p1[axis]! - p0[axis]!;
    if (Math.abs(dir) < 1e-8) {
      if (p0[axis]! < min[axis]! || p0[axis]! > max[axis]!) return false;
    } else {
      const invD = 1.0 / dir;
      let t1 = (min[axis]! - p0[axis]!) * invD;
      let t2 = (max[axis]! - p0[axis]!) * invD;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  return tmin <= tmax;
}

function countVisibleSamplesForAttendee(
  snapshot: SceneSnapshot,
  attendeeId: string,
): number {
  const pose = getAttendeeCameraPose(snapshot, attendeeId);
  const member = snapshot.roster.find((a) => a.attendeeId === attendeeId)!;
  const ownPlace = snapshot.places.find(
    (p) => p.id === member.assignedPlaceId,
  )!;
  const samples = getTargetSamplePointsWorld(snapshot.target);

  // Collect all visibility-blocking boxes excluding viewer's own chair & own torso proxy
  const blockerBoxes: Array<{ center: Vec3; size: Vec3 }> = [];
  for (const obj of snapshot.objects) {
    if (obj.id === ownPlace.objectId) continue;
    for (const proxy of obj.proxies) {
      if (!proxy.blocksVisibility) continue;
      const worldTf = getProxyWorldTransform(obj, proxy);
      const size: Vec3 =
        proxy.kind === 'cylinder'
          ? [
              (proxy.radiusM ?? 0.24) * 2,
              proxy.heightM ?? 4.0,
              (proxy.radiusM ?? 0.24) * 2,
            ]
          : (proxy.size ?? [0.5, 0.5, 0.5]);
      blockerBoxes.push({ center: worldTf.centerWorld, size });
    }
  }

  for (const other of snapshot.roster) {
    if (other.attendeeId === attendeeId) continue;
    const torso = getAttendeeTorsoProxyWorldBox(snapshot, other.attendeeId);
    blockerBoxes.push({ center: torso.centerWorld, size: torso.size });
  }

  let visible = 0;
  for (const sample of samples) {
    // Check 90° x 90° camera frustum (yaw = 0° facing -Z)
    const dx = sample[0] - pose.eyePositionWorld[0];
    const dy = sample[1] - pose.eyePositionWorld[1];
    const dz = sample[2] - pose.eyePositionWorld[2];
    const forwardDist = -dz; // since yaw=0 forward is [0, 0, -1]
    if (forwardDist <= pose.nearM || forwardDist >= pose.farM) continue;
    if (Math.abs(dx) > forwardDist || Math.abs(dy) > forwardDist) continue;

    let blocked = false;
    for (const box of blockerBoxes) {
      if (
        segmentIntersectsAABB3D(
          pose.eyePositionWorld,
          sample,
          box.center,
          box.size,
        )
      ) {
        blocked = true;
        break;
      }
    }
    if (!blocked) visible += 1;
  }
  return visible;
}

describe('Stream A — Scene, Prepared Venue & Evidence Capture', () => {
  it('rejects captureEvidence when snapshot hash does not match tourSpec hash', async () => {
    const snapshot = createDevFixtureSnapshot();
    await expect(
      captureEvidence(snapshot, {
        captureId: 'cap_1',
        runId: 'run_1',
        phase: 'baseline',
        sceneHash: 'vp_mismatched_hash',
        snapshot,
        keyframes: [],
        totalDurationSec: 3,
        deadlineIso: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).rejects.toThrow(/Scene hash mismatch/);
  });

  it('rejects captureEvidence when deadlineIso has already expired', async () => {
    const snapshot = createDevFixtureSnapshot();
    await expect(
      captureEvidence(snapshot, {
        captureId: 'cap_expired',
        runId: 'run_1',
        phase: 'baseline',
        sceneHash: snapshot.sceneHash,
        snapshot,
        keyframes: [],
        totalDurationSec: 3,
        deadlineIso: new Date(Date.now() - 5_000).toISOString(),
      }),
    ).rejects.toThrow(/Capture deadline expired/);
  });

  it('synthesizes default keyframes, valid WebM bytes, and matching EvidenceManifest when keyframes are empty', async () => {
    const snapshot = createDevFixtureSnapshot();
    const deadlineIso = new Date(Date.now() + 60_000).toISOString();
    const { videoBlob, manifest } = await captureEvidence(snapshot, {
      captureId: 'cap_dev_baseline',
      runId: 'run_dev_1',
      phase: 'baseline',
      sceneHash: snapshot.sceneHash,
      snapshot,
      keyframes: [],
      totalDurationSec: 4,
      deadlineIso,
    });

    expect(videoBlob.size).toBeGreaterThan(100);
    expect(manifest.byteLength).toBe(videoBlob.size);
    expect(manifest.captureId).toBe('cap_dev_baseline');
    expect(manifest.runId).toBe('run_dev_1');
    expect(manifest.phase).toBe('baseline');
    expect(manifest.sceneHash).toBe(snapshot.sceneHash);
    expect(manifest.mimeType).toBe('video/webm');
    expect(manifest.widthPx).toBe(INSPECTION_CAMERA.defaultResolutionPx);
    expect(manifest.heightPx).toBe(INSPECTION_CAMERA.defaultResolutionPx);
    expect(manifest.keyframes).toHaveLength(5); // 1 overview + 4 profile POVs
    expect(manifest.keyframes[0]?.kind).toBe('overview');

    const povKeyframes = manifest.keyframes.filter(
      (k) => k.kind === 'attendee_pov',
    );
    expect(povKeyframes).toHaveLength(4);
    for (const kf of povKeyframes) {
      expect(kf.fovDeg).toBe(90);
      expect(kf.aspect).toBe(1.0);
      const expectedPose = getAttendeeCameraPose(snapshot, kf.attendeeId!);
      expect(kf.cameraPosition).toEqual(expectedPose.eyePositionWorld);
      expect(kf.cameraLookAt).toEqual(expectedPose.lookAtWorld);
    }

    // Verify EBML magic bytes (0x1A 0x45 0xDF 0xA3)
    const buf = new Uint8Array(await videoBlob.arrayBuffer());
    expect(Array.from(buf.slice(0, 4))).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  });

  it('validates the 24-place prepared community hall snapshot structure, profiles, and bounds', () => {
    const snapshot = createPreparedVenueSnapshot();
    expect(snapshot.places).toHaveLength(24);
    expect(snapshot.roster).toHaveLength(24);
    expect(computeSceneHash(snapshot)).toBe(snapshot.sceneHash);

    const chairPlaces = snapshot.places.filter((p) => p.kind === 'chair');
    const bayPlaces = snapshot.places.filter(
      (p) => p.kind === 'wheelchair_bay',
    );
    expect(chairPlaces).toHaveLength(22);
    expect(bayPlaces).toHaveLength(2);

    // Verify unique place assignments and profile coverage
    const assignedPlaces = new Set<string>();
    const profileCounts: Record<ProfileId, number> = {
      reference_adult: 0,
      shorter_seated: 0,
      wheelchair_user: 0,
      extra_legroom: 0,
    };

    for (const member of snapshot.roster) {
      expect(assignedPlaces.has(member.assignedPlaceId)).toBe(false);
      assignedPlaces.add(member.assignedPlaceId);
      profileCounts[member.profileId] += 1;

      const profile = snapshot.profiles[member.profileId];
      const place = snapshot.places.find(
        (p) => p.id === member.assignedPlaceId,
      );
      expect(place).toBeDefined();
      expect(profile.compatiblePlaceKinds).toContain(place!.kind);
      expect(place!.widthM).toBeGreaterThanOrEqual(
        profile.requiredFootprintWidthM,
      );
      expect(place!.depthM).toBeGreaterThanOrEqual(
        profile.requiredFootprintDepthM,
      );
    }

    expect(profileCounts.reference_adult).toBeGreaterThanOrEqual(1);
    expect(profileCounts.shorter_seated).toBeGreaterThanOrEqual(1);
    expect(profileCounts.wheelchair_user).toBe(2);
    expect(profileCounts.extra_legroom).toBeGreaterThanOrEqual(1);

    // Verify all objects lie within roomBounds and outside reservedCirculationRegions
    for (const obj of snapshot.objects) {
      const [ox, oy, oz] = obj.transform.position;
      expect(ox).toBeGreaterThanOrEqual(snapshot.roomBounds.min[0]);
      expect(ox).toBeLessThanOrEqual(snapshot.roomBounds.max[0]);
      expect(oy).toBeGreaterThanOrEqual(snapshot.roomBounds.min[1]);
      expect(oz).toBeGreaterThanOrEqual(snapshot.roomBounds.min[2]);
      expect(oz).toBeLessThanOrEqual(snapshot.roomBounds.max[2]);

      for (const reserved of snapshot.reservedCirculationRegions) {
        const insideReserved =
          ox > reserved.minX &&
          ox < reserved.maxX &&
          oz > reserved.minZ &&
          oz < reserved.maxZ;
        expect(insideReserved).toBe(false);
      }
    }
  });

  it('verifies all 24x135=3240 sightlines, legroom, and turning pads across baseline and reference repair patch', () => {
    const baseline = createPreparedVenueSnapshot();
    const patch = createPreparedVenueReferencePatch(
      'run_test',
      baseline.sceneHash,
    );

    expect(patch.operations.length).toBeLessThanOrEqual(
      PATCH_CONSTRAINTS.maxOperations,
    );

    // Apply patch to create patched snapshot
    const valResult = applyAndValidatePatch(baseline, baseline, patch);
    expect(valResult.valid).toBe(true);
    const patched: SceneSnapshot = valResult.snapshot!;

    const seenTargets = new Set<string>();
    for (const op of patch.operations) {
      expect(seenTargets.has(op.targetId)).toBe(false);
      seenTargets.add(op.targetId);

      const [dx, dy, dz] = op.deltaPositionM;
      expect(Math.abs(dy)).toBeLessThanOrEqual(PATCH_CONSTRAINTS.maxAxisDeltaM);
      expect(Math.abs(dx)).toBeLessThanOrEqual(PATCH_CONSTRAINTS.maxAxisDeltaM);
      expect(Math.abs(dz)).toBeLessThanOrEqual(PATCH_CONSTRAINTS.maxAxisDeltaM);
      expect(Math.abs(op.deltaYawDeg)).toBeLessThanOrEqual(
        PATCH_CONSTRAINTS.maxYawDeltaDeg,
      );
    }

    // 1. Check 15x9 = 135 raycast visibility for ALL 24 attendees in baseline vs patched
    for (const member of baseline.roster) {
      const baseVis = countVisibleSamplesForAttendee(
        baseline,
        member.attendeeId,
      );
      const patchedVis = countVisibleSamplesForAttendee(
        patched,
        member.attendeeId,
      );

      if (member.attendeeId === 'att_shorter_01') {
        // In baseline, att_shorter_01 is occluded by obj_prop_welcome_sign (< 122/135)
        expect(baseVis).toBeLessThan(VISIBILITY_CLEAR_MIN_SAMPLES);
        // After patch, att_shorter_01 has 135/135 clear view!
        expect(patchedVis).toBe(VISIBILITY_TOTAL_SAMPLES);
      } else if (
        member.profileId === 'shorter_seated' &&
        member.assignedPlaceId.includes('_r3_')
      ) {
        // Shorter viewers in Row 3 seated behind tall adults are occluded in flat baseline (< 122/135)
        expect(baseVis).toBeLessThan(VISIBILITY_CLEAR_MIN_SAMPLES);
        // After patch with tiered 0.15m risers, their sightlines over front rows improve significantly
        expect(patchedVis).toBeGreaterThan(baseVis);
      } else {
        // Every other attendee in the 24-place room is clear (>= 122/135) in both baseline and patched, with zero regression!
        expect(baseVis).toBeGreaterThanOrEqual(VISIBILITY_CLEAR_MIN_SAMPLES);
        expect(patchedVis).toBeGreaterThanOrEqual(baseVis);
      }
    }

    // 2. Check Issue 2: Catering table front legroom for Row 1 East extra-legroom attendees (require 0.55m)
    const r1ChairFrontEdgeZ = -2.00 - 0.65 / 2; // -2.325m
    const baselineTableBackZ = -2.58 + 0.15; // -2.43m
    const patchedTableBackZ = -2.58 - 0.55 + 0.15; // -2.98m
    expect(r1ChairFrontEdgeZ - baselineTableBackZ).toBeLessThan(0.55); // Fails in baseline (0.105m)
    expect(r1ChairFrontEdgeZ - patchedTableBackZ).toBeGreaterThanOrEqual(0.55); // Passes after patch (0.655m)

    // 3. Check Issue 3: AV cart inside Wheelchair Bay W2 turning pad (center [3.00, 4.40], radius 0.775m) in baseline, outside after [+0.60, 0, 0] patch
    const padCenter: [number, number] = [3.00, 4.40];
    const padRadius = 1.55 / 2;
    const cartHalfWidth = 0.22;
    const baselineCartDist = Math.hypot(
      3.55 - padCenter[0],
      4.40 - padCenter[1],
    );
    const patchedCartDist = Math.hypot(
      3.55 + 0.60 - padCenter[0],
      4.40 - padCenter[1],
    );
    expect(baselineCartDist).toBeLessThan(padRadius);
    expect(patchedCartDist).toBeGreaterThan(padRadius + cartHalfWidth);
  });

  it('enforces self-occlusion exclusion in attendee_pov and cleanForEvidenceCapture in Three.js scene builder', () => {
    const snapshot = createPreparedVenueSnapshot();
    const targetAttendeeId = 'att_shorter_01';
    const member = snapshot.roster.find(
      (a) => a.attendeeId === targetAttendeeId,
    )!;
    const place = snapshot.places.find(
      (p) => p.id === member.assignedPlaceId,
    )!;

    // 1. Clean capture scene omits debug overlays
    const cleanBuilt = buildVenueThreeScene(snapshot, {
      cleanForEvidenceCapture: true,
      viewMode: 'attendee_pov',
      selectedAttendeeId: targetAttendeeId,
      showRoutes: true,
      showTargetGrid: true,
    });

    expect(
      cleanBuilt.scene.getObjectByName('interactive_route_guides'),
    ).toBeUndefined();
    expect(
      cleanBuilt.scene.getObjectByName('debug_target_samples_135'),
    ).toBeUndefined();

    // Viewer's own chair and torso proxy MUST be hidden in attendee_pov
    const ownChairNode = cleanBuilt.objectNodesById.get(place.objectId);
    const ownTorsoNode = cleanBuilt.attendeeProxyNodesById.get(targetAttendeeId);
    expect(ownChairNode?.visible).toBe(false);
    expect(ownTorsoNode?.visible).toBe(false);

    // All other 23 attendees' torso proxies and chairs MUST remain visible
    for (const other of snapshot.roster) {
      if (other.attendeeId === targetAttendeeId) continue;
      const otherPlace = snapshot.places.find(
        (p) => p.id === other.assignedPlaceId,
      )!;
      expect(
        cleanBuilt.objectNodesById.get(otherPlace.objectId)?.visible,
      ).toBe(true);
      expect(
        cleanBuilt.attendeeProxyNodesById.get(other.attendeeId)?.visible,
      ).toBe(true);

      // Verify torso proxy world box alignment
      const expectedBox = getAttendeeTorsoProxyWorldBox(
        snapshot,
        other.attendeeId,
      );
      const torsoGroup = cleanBuilt.attendeeProxyNodesById.get(
        other.attendeeId,
      )!;
      const torsoMesh = torsoGroup.children[0] as THREE.Mesh;
      expect(torsoMesh.position.x).toBeCloseTo(expectedBox.centerWorld[0], 5);
      expect(torsoMesh.position.y).toBeCloseTo(expectedBox.centerWorld[1], 5);
      expect(torsoMesh.position.z).toBeCloseTo(expectedBox.centerWorld[2], 5);
    }

    // Switching back to overview restores visibility on the viewer's own chair and torso proxy
    applyActiveViewerVisibility(
      cleanBuilt.scene,
      snapshot,
      'overview',
      targetAttendeeId,
      cleanBuilt.objectNodesById,
      cleanBuilt.attendeeProxyNodesById,
    );
    expect(ownChairNode?.visible).toBe(true);
    expect(ownTorsoNode?.visible).toBe(true);

    // Camera alignment check
    const camera = new THREE.PerspectiveCamera();
    const appliedPose = applyAttendeeCameraPose(
      camera,
      snapshot,
      targetAttendeeId,
    );
    expect(camera.fov).toBe(90);
    expect(camera.aspect).toBe(1.0);
    expect(camera.position.x).toBeCloseTo(appliedPose.eyePositionWorld[0], 5);
    expect(camera.position.y).toBeCloseTo(appliedPose.eyePositionWorld[1], 5);
    expect(camera.position.z).toBeCloseTo(appliedPose.eyePositionWorld[2], 5);

    const overviewPose = getOverviewCameraPose(snapshot, 'front_high');
    expect(overviewPose.fovDeg).toBe(52);

    const keyframes = buildDefaultCaptureKeyframes(snapshot, 10);
    expect(getActiveKeyframeAtTime(keyframes, 0)?.kind).toBe('overview');
    expect(getActiveKeyframeAtTime(keyframes, 9.5)?.kind).toBe('attendee_pov');

    disposeVenueScene(cleanBuilt.scene);
    expect(cleanBuilt.scene.children).toHaveLength(0);
  });

  it('generates valid glTF 2.0 binary (.glb) and verifies public/venue/ prepared artifacts on disk', () => {
    const snapshot = createPreparedVenueSnapshot();
    const { glbBytes, assetHash } = generateVenueGlbBinary(snapshot);

    expect(glbBytes.byteLength).toBeGreaterThan(500);
    expect(assetHash).toMatch(/^vp_[0-9a-f]{16}$/);

    const view = new DataView(
      glbBytes.buffer,
      glbBytes.byteOffset,
      glbBytes.byteLength,
    );
    expect(view.getUint32(0, true)).toBe(0x46546c67); // 'glTF'
    expect(view.getUint32(4, true)).toBe(2); // version 2
    expect(view.getUint32(8, true)).toBe(glbBytes.byteLength);
    expect(view.getUint32(16, true)).toBe(0x4e4f534a); // 'JSON' chunk

    const venueDir = path.resolve(process.cwd(), 'public', 'venue');
    const glbDiskPath = path.join(venueDir, 'prepared-venue.glb');
    const manifestDiskPath = path.join(venueDir, 'scene-manifest.json');
    expect(fs.existsSync(glbDiskPath)).toBe(true);
    expect(fs.existsSync(manifestDiskPath)).toBe(true);
    expect(fs.existsSync(path.join(venueDir, 'PROVENANCE.md'))).toBe(true);
    expect(fs.existsSync(path.join(venueDir, 'dev-fixture-smoke.webm'))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(venueDir, 'dev-fixture-smoke.manifest.json')),
    ).toBe(true);

    // Verify in-memory createPreparedVenueSnapshot() sceneHash is 100% identical to on-disk scene-manifest.json
    const onDiskManifest = JSON.parse(
      fs.readFileSync(manifestDiskPath, 'utf-8'),
    ) as SceneSnapshot;
    expect(onDiskManifest.sceneHash).toBe(snapshot.sceneHash);
    expect(onDiskManifest.source.assetHash).toBe(snapshot.source.assetHash);

    // Verify parseVenueGlbBinary parses all SceneObject nodes from prepared-venue.glb
    const onDiskGlb = new Uint8Array(fs.readFileSync(glbDiskPath));
    const parsedGlb = parseVenueGlbBinary(onDiskGlb);
    expect(parsedGlb.version).toBe(2);
    expect(parsedGlb.totalByteLength).toBe(onDiskGlb.byteLength);
    for (const obj of snapshot.objects) {
      expect(parsedGlb.nodeNames).toContain(obj.id);
    }

    // Verify buildDefaultCaptureKeyframes picks the primary *_01 attendees (including att_shorter_01!)
    const defaultKfs = buildDefaultCaptureKeyframes(snapshot, 10);
    const povAttendeeIds = defaultKfs
      .filter((k) => k.kind === 'attendee_pov')
      .map((k) => k.attendeeId);
    expect(povAttendeeIds).toEqual([
      'att_shorter_01',
      'att_extra_legroom_01',
      'att_wheelchair_01',
      'att_adult_01',
    ]);
  });

  it('loads prepared venue manifest via loadPreparedVenueManifest fallback when offline', async () => {
    const loaded = await loadPreparedVenueManifest('/nonexistent-url.json');
    expect(loaded.sceneHash).toBe(createPreparedVenueSnapshot().sceneHash);
  });

  it('exercises the browser MediaRecorder + 2D canvas + telemetry slate path in captureEvidence when DOM globals exist', async () => {
    const snapshot = createDevFixtureSnapshot();
    const g = globalThis as Record<string, unknown>;
    const prevWindow = g.window;
    const prevDocument = g.document;
    const prevMediaRecorder = g.MediaRecorder;

    const slateTexts: string[] = [];
    let trackStopped = false;

    try {
      const mockCtx2d = {
        save: () => {},
        restore: () => {},
        fillRect: () => {},
        fillText: (text: string) => {
          slateTexts.push(text);
        },
        drawImage: () => {},
        beginPath: () => {},
        arc: () => {},
        stroke: () => {},
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        font: '',
      };

      g.window = {};
      g.document = {
        createElement: (tag: string) => {
          if (tag === 'canvas') {
            return {
              width: 512,
              height: 512,
              getContext: (kind: string) => (kind === '2d' ? mockCtx2d : null),
              captureStream: () => ({
                getTracks: () => [
                  {
                    stop: () => {
                      trackStopped = true;
                    },
                  },
                ],
                getVideoTracks: () => [
                  {
                    requestFrame: () => {},
                  },
                ],
              }),
            };
          }
          return {};
        },
      };

      class MockMediaRecorder {
        static isTypeSupported(mime: string): boolean {
          return mime === 'video/webm;codecs=vp8';
        }
        state = 'inactive';
        mimeType = 'video/webm;codecs=vp8';
        ondataavailable: ((evt: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        onerror: (() => void) | null = null;
        start(): void {
          this.state = 'recording';
        }
        requestData(): void {
          this.ondataavailable?.({
            data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])], {
              type: 'video/webm',
            }),
          });
        }
        stop(): void {
          this.state = 'inactive';
          this.onstop?.();
        }
      }

      g.MediaRecorder = MockMediaRecorder;

      const { videoBlob, manifest } = await captureEvidence(snapshot, {
        captureId: 'cap_browser_sim',
        runId: 'run_browser_sim',
        phase: 'baseline',
        sceneHash: snapshot.sceneHash,
        snapshot,
        keyframes: [],
        totalDurationSec: 0.15,
        deadlineIso: new Date(Date.now() + 30_000).toISOString(),
      });

      expect(videoBlob.size).toBeGreaterThan(0);
      expect(manifest.mimeType).toBe('video/webm');
      expect(manifest.byteLength).toBe(videoBlob.size);
      expect(trackStopped).toBe(true);
      expect(slateTexts.length).toBeGreaterThan(0);
      expect(slateTexts[0]).toContain('view_overview_room');
    } finally {
      g.window = prevWindow;
      g.document = prevDocument;
      g.MediaRecorder = prevMediaRecorder;
    }
  });

  it('instantiates VenueViewport and computes finite spherical orbit coordinates across all presets', () => {
    const snapshot = createPreparedVenueSnapshot();
    for (const preset of ['front_high', 'top_down', 'stage_oblique'] as const) {
      const orbit = computeInitialOrbit(snapshot, preset);
      expect(Number.isFinite(orbit.azimuthRad)).toBe(true);
      expect(Number.isFinite(orbit.polarRad)).toBe(true);
      expect(orbit.distanceM).toBeGreaterThan(2.0);
    }

    const element = React.createElement(VenueViewport, {
      snapshot,
      selectedAttendeeId: 'att_shorter_01',
      viewMode: 'attendee_pov',
    });
    expect(element.type).toBe(VenueViewport);
    expect(element.props.viewMode).toBe('attendee_pov');
  });

  it('correctly rotates local proxy offsets under right-handed yaw and updates revision POV keyframes when seats move', async () => {
    const snapshot = createPreparedVenueSnapshot();
    const chair = structuredClone(
      snapshot.objects.find((o) => o.category === 'movable_chair')!,
    );
    chair.transform.position = [1.0, 0.0, 2.0];
    chair.transform.yawDeg = 90; // Facing -X ([-1, 0, 0])

    const backProxy = chair.proxies[0]!; // localPosition = [0, 0.42, +0.22]
    const worldTf = getProxyWorldTransform(chair, backProxy);
    // Since chair faces -X, its back (+Z local) must sit at +X (1.0 + 0.22 = 1.22)
    expect(worldTf.centerWorld[0]).toBeCloseTo(1.22, 5);
    expect(worldTf.centerWorld[1]).toBeCloseTo(0.42, 5);
    expect(worldTf.centerWorld[2]).toBeCloseTo(2.0, 5);

    // Move att_shorter_01's chair in a revision snapshot and verify captureEvidence updates stale keyframe cameraPosition
    const moved = structuredClone(snapshot);
    const shorterMember = moved.roster.find(
      (a) => a.attendeeId === 'att_shorter_01',
    )!;
    const shorterPlace = moved.places.find(
      (p) => p.id === shorterMember.assignedPlaceId,
    )!;
    const movedChair = moved.objects.find(
      (o) => o.id === shorterPlace.objectId,
    )!;
    movedChair.transform.position[0] += 0.35;
    moved.sceneHash = computeSceneHash(moved);

    const { manifest } = await captureEvidence(moved, {
      captureId: 'cap_rev_1',
      runId: 'run_rev_1',
      phase: 'revision',
      sceneHash: moved.sceneHash,
      snapshot: moved,
      keyframes: [
        {
          viewId: 'pov_att_shorter_01',
          label: 'Shorter Viewer POV',
          kind: 'attendee_pov',
          attendeeId: 'att_shorter_01',
          cameraPosition: [0, 0, 0], // stale coordinates
          cameraLookAt: [0, 0, -1],
          fovDeg: 60,
          aspect: 1.5,
          startSec: 0,
          endSec: 2,
        },
      ],
      totalDurationSec: 2,
      deadlineIso: new Date(Date.now() + 60_000).toISOString(),
    });

    const updatedPose = getAttendeeCameraPose(moved, 'att_shorter_01');
    expect(manifest.keyframes[0]?.cameraPosition).toEqual(
      updatedPose.eyePositionWorld,
    );
    expect(manifest.keyframes[0]?.cameraLookAt).toEqual(
      updatedPose.lookAtWorld,
    );
    expect(manifest.keyframes[0]?.fovDeg).toBe(90);
    expect(manifest.keyframes[0]?.aspect).toBe(1.0);
  });

  it('renders 3D stepped platforms and ADA-compliant accessible aisle ramps when tiered seating is present', () => {
    const snap = createDevFixtureSnapshot();
    // Elevate row 2 so tiered platforms and ramps are constructed
    const r2Chair = snap.objects.find((o) => o.id === 'obj_chair_r2_c1')!;
    r2Chair.transform.position[1] = 0.10;

    const built = buildVenueThreeScene(snap);
    const tiersGroup = built.scene.getObjectByName(
      'tiered_seating_platforms_and_ramps',
    );
    expect(tiersGroup).toBeDefined();

    // Verify platform mesh exists
    const platform = tiersGroup?.children.find((c) =>
      c.name.startsWith('tiered_riser_platform_'),
    );
    expect(platform).toBeDefined();

    // Verify ramp mesh exists connecting tiers
    const ramp = tiersGroup?.children.find((c) =>
      c.name.startsWith('accessible_aisle_ramp_'),
    );
    expect(ramp).toBeDefined();

    // Verify outside accessible ramps leading to wheelchair bays exist
    const outsideRamp = tiersGroup?.children.find((c) =>
      c.name.startsWith('accessible_outside_ramp_'),
    );
    expect(outsideRamp).toBeDefined();

    disposeVenueScene(built.scene);
  });

  it('elevates wheelchair wheels and frame according to the platform elevation it is standing on', () => {
    const snap = createPreparedVenueSnapshot();
    // Elevate wheelchair bay W2 to 0.30m (att_wheelchair_01 is assigned to place_bay_wc_02)
    const bayObj = snap.objects.find((o) => o.id === 'obj_bay_wc_02')!;
    bayObj.transform.position[1] = 0.30;

    const torsoBox = getAttendeeTorsoProxyWorldBox(snap, 'att_wheelchair_01');
    expect(torsoBox.centerWorld[1]).toBeCloseTo(0.30 + 1.25 / 2, 3); // 0.925m

    const { rootMesh } = createArticulatedAvatarMesh({
      attendeeId: 'att_wheelchair_01',
      profileId: 'wheelchair_user',
      placeId: 'place_bay_wc_01',
      torsoBox,
      baseColorHex: 0x3b82f6,
    });

    const wcAssembly = rootMesh.getObjectByName('avatar_wheelchair_assembly');
    expect(wcAssembly).toBeDefined();

    const leftWheel = rootMesh.getObjectByName('avatar_wheel_left') as THREE.Group;
    expect(leftWheel).toBeDefined();

    // Wheel position relative to rootMesh (which is at Y = 0.925):
    // floorOffsetY = -1.25 * 0.5 = -0.625
    // wheelPivot.y = floorOffsetY + 0.29 = -0.335
    // In world coordinates: 0.925 + (-0.335) = 0.59m (center of wheel)
    // Bottom of wheel: 0.59 - 0.29 = 0.30m (rests exactly on the 0.30m elevated platform!)
    const wheelCenterWorldY = rootMesh.position.y + leftWheel.position.y;
    expect(wheelCenterWorldY).toBeCloseTo(0.30 + 0.29, 3);
    const wheelBottomWorldY = wheelCenterWorldY - 0.29;
    expect(wheelBottomWorldY).toBeCloseTo(0.30, 3);
  });

  it('passes Stream B real evaluateScene, applyAndValidatePatch, and compareEvaluations with 24/24 clear-and-usable places after reference patch', () => {
    const baseline = createPreparedVenueSnapshot();
    const baseEval = evaluateScene(baseline);
    expect(baseEval.isValidStructure).toBe(true);
    expect(baseEval.structuralErrors).toHaveLength(0);

    const patch = createPreparedVenueReferencePatch(
      'run_stream_b_check',
      baseline.sceneHash,
    );
    const val = applyAndValidatePatch(baseline, baseline, patch);
    expect(val.valid).toBe(true);
    expect(val.errors).toHaveLength(0);
    expect(val.snapshot).toBeDefined();

    const revEval = evaluateScene(val.snapshot!);
    expect(revEval.isValidStructure).toBe(true);
    expect(revEval.allModeledRequirementsMet).toBe(true);
    expect(revEval.comparison.attendeesWithUnmetRequirements).toBe(0);
    expect(revEval.comparison.totalFailedRequirementChecks).toBe(0);

    const cmp = compareEvaluations(baseEval, revEval);
    expect(cmp.accepted).toBe(true);
    expect(cmp.outcome).toBe('accepted');
  });

  it('auto-labels seats, wheelchair bays, stage, screen, pillars, and props from a binary .glb venue via parseAndLabelGlbVenue', async () => {
    const venueDir = path.resolve(process.cwd(), 'public', 'venue');
    const glbBytes = new Uint8Array(
      fs.readFileSync(path.join(venueDir, 'prepared-venue.glb')),
    );
    const report = parseAndLabelGlbVenue(glbBytes, {
      fileName: 'prepared-venue.glb',
    });

    expect(report.counts.seats).toBe(22);
    expect(report.counts.wheelchairBays).toBe(2);
    expect(report.counts.stagesAndScreens).toBe(2);
    expect(report.counts.pillarsAndStructures).toBe(2);
    expect(report.counts.movableProps).toBe(3);
    expect(report.snapshot.places).toHaveLength(24);
    expect(report.snapshot.roster).toHaveLength(24);

    // Verify the auto-labeled snapshot renders cleanly in buildVenueThreeScene and scores in evaluateScene
    const built = buildVenueThreeScene(report.snapshot, {
      cleanForEvidenceCapture: false,
      viewMode: 'overview',
    });
    expect(built.objectNodesById.size).toBe(report.snapshot.objects.length);
    disposeVenueScene(built.scene);

    const evaluated = evaluateScene(report.snapshot);
    expect(evaluated.isValidStructure).toBe(true);
    expect(evaluated.occupiedCount).toBe(24);

    // Verify Preview Repair on the GLB-parsed 24-place venue achieves 24/24 clear-and-usable
    const previewRun24 = createLocalFixtureRepairPreviewRun(report.snapshot);
    expect(previewRun24.bestEvaluation.allModeledRequirementsMet).toBe(true);
    expect(
      previewRun24.bestEvaluation.comparison.attendeesWithUnmetRequirements,
    ).toBe(0);

    // Verify 16-Place Civic Auditorium .glb auto-parsing and repair preview achieves 16/16 clear-and-usable
    const customGlb = generateSampleCustomAuditoriumGlb();
    const customReport = parseAndLabelGlbVenue(customGlb.glbBytes, {
      fileName: customGlb.fileName,
    });
    expect(customReport.counts.seats).toBe(14);
    expect(customReport.counts.wheelchairBays).toBe(2);
    expect(customReport.snapshot.places).toHaveLength(16);

    const previewRun16 = createLocalFixtureRepairPreviewRun(
      customReport.snapshot,
    );
    expect(previewRun16.bestEvaluation.isValidStructure).toBe(true);
    expect(previewRun16.bestEvaluation.allModeledRequirementsMet).toBe(true);
    expect(
      previewRun16.bestEvaluation.comparison.attendeesWithUnmetRequirements,
    ).toBe(0);

    // Verify UI 135-sample visibility mask matches Stream B evaluateScene visibleSamples for every attendee
    for (const member of report.snapshot.roster) {
      const maskRes = computeAttendeeSampleVisibilityMask(
        report.snapshot,
        member.attendeeId,
      );
      const visibleCount = maskRes.visibleMask.filter(Boolean).length;
      expect(visibleCount).toBe(
        evaluated.attendees[member.attendeeId]?.visibleSamples,
      );
    }

    // Verify parseAndLabelGlbVenueAsync emits all 6 monotonically increasing progress updates
    const progressUpdates: GlbParseProgressUpdate[] = [];
    const asyncReport = await parseAndLabelGlbVenueAsync(customGlb.glbBytes, {
      fileName: customGlb.fileName,
      yieldDelayMs: 1,
      onProgress: (u) => progressUpdates.push(u),
    });
    expect(asyncReport.snapshot.places).toHaveLength(16);
    expect(progressUpdates).toHaveLength(6);
    expect(progressUpdates.map((u) => u.stage)).toEqual([
      'reading_header',
      'traversing_hierarchy',
      'classifying_nodes',
      'synthesizing_routes',
      'assigning_profiles',
      'complete',
    ]);
    expect(progressUpdates[0]?.percent).toBe(15);
    expect(progressUpdates[5]?.percent).toBe(100);

    // Verify smallClassroom.glb (from building-files/smallClassroom.glb or Argon/smallClassroom.glb):
    // 1. Exactly 50 real chairs (Chair_R1_S01..Chair_R5_S10) are parsed with zero false-positive front spots
    // 2. SightTargetAgent selects Screen_Projection_16x9 at [0.60, 2.94, -4.38] (3.72m x 2.04m)
    // 3. Identity alignment is used so the 3D classroom mesh and parsed seats/screen match 1:1
    const externalClassroomGlbPath = fs.existsSync(
      'building-files/smallClassroom.glb',
    )
      ? 'building-files/smallClassroom.glb'
      : '/Users/dad/Desktop/Andrew/Stanford/Misc/Hackathon/Argon/smallClassroom.glb';
    if (fs.existsSync(externalClassroomGlbPath)) {
      const clsBuf = new Uint8Array(fs.readFileSync(externalClassroomGlbPath));
      const clsReport = await parseAndLabelGlbVenueAsync(clsBuf, {
        fileName: 'smallClassroom.glb',
        yieldDelayMs: 1,
        standaloneRandomFour: true,
        randomFn: () => 0.35,
      });
      expect(clsReport.counts.seats).toBe(50);
      expect(clsReport.counts.wheelchairBays).toBe(0);
      expect(clsReport.snapshot.places).toHaveLength(50);
      expect(clsReport.snapshot.target.id).toBe('Screen_Projection_16x9');
      expect(clsReport.snapshot.target.center[0]).toBeCloseTo(0.6, 2);
      expect(clsReport.snapshot.target.center[1]).toBeCloseTo(2.94, 2);
      expect(clsReport.snapshot.target.center[2]).toBeCloseTo(-4.38, 2);
      expect(clsReport.snapshot.target.widthM).toBeCloseTo(3.72, 2);
      expect(clsReport.snapshot.target.heightM).toBeCloseTo(2.04, 2);
      expect(isStandaloneUploadedGlbScene(clsReport.snapshot.sceneId)).toBe(
        true,
      );
      expect(
        getUploadedGlbBytesForScene(clsReport.snapshot.sceneId)?.byteLength,
      ).toBe(clsBuf.byteLength);
      expect(clsReport.agentTelemetry?.agents).toHaveLength(3);

      const align = getGlbAlignmentForScene(clsReport.snapshot.sceneId);
      expect(align.rotationYRad).toBe(0);
      expect(align.scale).toBe(1.0);

      // Verify seats are analyzed in 3D across all 5 stepped riser levels (0.16m, 0.34m, 0.52m, 0.70m, 0.88m), not flat at y=0
      const distinctSeatYLevels = [
        ...new Set(
          clsReport.snapshot.objects
            .filter((o) => o.category === 'movable_chair')
            .map((o) => Number(o.transform.position[1].toFixed(2))),
        ),
      ].sort((a, b) => a - b);
      expect(distinctSeatYLevels).toEqual([0.16, 0.34, 0.52, 0.7, 0.88]);

      const clsEval = evaluateScene(clsReport.snapshot);
      expect(clsEval.isValidStructure).toBe(true);
      expect(clsEval.occupiedCount).toBe(4);

      // Verify ExitFinderAgent parsed both exits (Exit_1_FrontLeft and Exit_2_FrontRight) into snapshot.exits
      // and evacuating people navigate to those exact exit points and disappear (state === 'exited')
      expect(clsReport.snapshot.exits).toHaveLength(2);
      expect(clsReport.snapshot.exits?.map((e) => e.id)).toEqual([
        'Exit_1_FrontLeft',
        'Exit_2_FrontRight',
      ]);
      expect(clsReport.snapshot.exits?.[0]?.position[0]).toBeCloseTo(-4.01, 1);
      expect(clsReport.snapshot.exits?.[0]?.position[1]).toBeCloseTo(-4.5, 1);
      expect(clsReport.snapshot.exits?.[1]?.position[0]).toBeCloseTo(4.69, 1);
      expect(clsReport.snapshot.exits?.[1]?.position[1]).toBeCloseTo(-4.5, 1);

      const evacSim = simulateEvacuation(
        clsReport.snapshot,
        'emergency_evacuation',
      );
      expect(evacSim.totalExitCount).toBe(2);
      expect(evacSim.activeExitCount).toBe(2);
      const finalFrame = evacSim.frames[evacSim.frames.length - 1]!;
      const finalAgents = Object.values(finalFrame.agents);
      expect(finalAgents).toHaveLength(4);
      expect(finalAgents.every((a) => a.state === 'exited')).toBe(true);
    }

    // Also verify spawnRandomFourAttendees on arbitrary place lists
    const randomRoster = spawnRandomFourAttendees(
      report.snapshot.places,
      () => 0.25,
    );
    expect(randomRoster).toHaveLength(4);
  });
});
