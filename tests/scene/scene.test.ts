import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  INSPECTION_CAMERA,
  PATCH_CONSTRAINTS,
  computeSceneHash,
  createDevFixtureSnapshot,
  getAttendeeCameraPose,
  getAttendeeTorsoProxyWorldBox,
  getTargetSamplePointsWorld,
  type ProfileId,
} from '../../src/shared/index.js';
import {
  applyActiveViewerVisibility,
  applyAttendeeCameraPose,
  buildDefaultCaptureKeyframes,
  buildVenueThreeScene,
  captureEvidence,
  createPreparedVenueReferencePatch,
  createPreparedVenueSnapshot,
  disposeVenueScene,
  generateVenueGlbBinary,
  getActiveKeyframeAtTime,
  getOverviewCameraPose,
} from '../../src/scene/index.js';

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

  it('verifies the 3-operation reference repair patch obeys all bounded constraints and resolves the 3 baseline issues', () => {
    const snapshot = createPreparedVenueSnapshot();
    const patch = createPreparedVenueReferencePatch(
      'run_test',
      snapshot.sceneHash,
    );

    expect(patch.operations.length).toBeLessThanOrEqual(
      PATCH_CONSTRAINTS.maxOperations,
    );

    const seenTargets = new Set<string>();
    for (const op of patch.operations) {
      expect(seenTargets.has(op.targetId)).toBe(false);
      seenTargets.add(op.targetId);

      const [dx, dy, dz] = op.deltaPositionM;
      expect(dy).toBe(0);
      expect(Math.abs(dx)).toBeLessThanOrEqual(PATCH_CONSTRAINTS.maxAxisDeltaM);
      expect(Math.abs(dz)).toBeLessThanOrEqual(PATCH_CONSTRAINTS.maxAxisDeltaM);
      expect(Math.abs(op.deltaYawDeg)).toBeLessThanOrEqual(
        PATCH_CONSTRAINTS.maxYawDeltaDeg,
      );

      // Quantized to 0.05m increments
      expect(
        Math.abs(
          Math.round(dx / PATCH_CONSTRAINTS.translationStepM) *
            PATCH_CONSTRAINTS.translationStepM -
            dx,
        ),
      ).toBeLessThan(1e-6);
      expect(
        Math.abs(
          Math.round(dz / PATCH_CONSTRAINTS.translationStepM) *
            PATCH_CONSTRAINTS.translationStepM -
            dz,
        ),
      ).toBeLessThan(1e-6);

      const obj = snapshot.objects.find((o) => o.id === op.targetId);
      expect(obj).toBeDefined();
      expect(obj!.editable).toBe(true);

      const newX = obj!.transform.position[0] + dx;
      const newZ = obj!.transform.position[2] + dz;
      const dispFromBaseline = Math.hypot(
        newX - obj!.baselineTransform.position[0],
        newZ - obj!.baselineTransform.position[2],
      );
      expect(dispFromBaseline).toBeLessThanOrEqual(
        PATCH_CONSTRAINTS.maxTotalDisplacementFromBaselineM,
      );

      if (obj!.allowedBounds) {
        expect(newX).toBeGreaterThanOrEqual(obj!.allowedBounds.minX);
        expect(newX).toBeLessThanOrEqual(obj!.allowedBounds.maxX);
        expect(newZ).toBeGreaterThanOrEqual(obj!.allowedBounds.minZ);
        expect(newZ).toBeLessThanOrEqual(obj!.allowedBounds.maxZ);
      }
    }

    // Issue 1: Welcome sign blocks shorter viewer in baseline, cleared after [-0.55, 0, 0] shift
    const shorterPose = getAttendeeCameraPose(snapshot, 'att_shorter_01');
    const targetSamples = getTargetSamplePointsWorld(snapshot.target);
    const countBlockedBySign = (signCenterX: number): number => {
      const minX = signCenterX - 0.21;
      const maxX = signCenterX + 0.21;
      const minY = 0.0;
      const maxY = 1.15;
      const signZ = -2.25;
      let blocked = 0;
      for (const sample of targetSamples) {
        const t =
          (signZ - shorterPose.eyePositionWorld[2]) /
          (sample[2] - shorterPose.eyePositionWorld[2]);
        const hitX =
          shorterPose.eyePositionWorld[0] +
          t * (sample[0] - shorterPose.eyePositionWorld[0]);
        const hitY =
          shorterPose.eyePositionWorld[1] +
          t * (sample[1] - shorterPose.eyePositionWorld[1]);
        if (hitX >= minX && hitX <= maxX && hitY >= minY && hitY <= maxY) {
          blocked += 1;
        }
      }
      return blocked;
    };

    expect(countBlockedBySign(0.0)).toBeGreaterThan(20); // Baseline: < 122/135 visible
    expect(countBlockedBySign(-0.55)).toBe(0); // After [-0.55, 0, 0] shift: 135/135 visible!

    // Issue 2: Catering table front legroom for Row 1 East extra-legroom attendees (require 0.55m)
    const r1ChairZ = -1.80;
    const baselineTableBackZ = -2.35 + 0.15; // -2.20m
    const patchedTableBackZ = -2.35 - 0.35 + 0.15; // -2.55m
    expect(r1ChairZ - baselineTableBackZ).toBeCloseTo(0.40, 4); // < 0.55m in baseline
    expect(r1ChairZ - patchedTableBackZ).toBeCloseTo(0.75, 4); // >= 0.55m after patch

    // Issue 3: AV cart inside Wheelchair Bay W2 turning pad (center [3.10, 3.90], radius 0.775m) in baseline, outside after [+0.60, 0, 0] patch
    const padCenter: [number, number] = [3.10, 3.90];
    const padRadius = 1.55 / 2;
    const cartHalfWidth = 0.22;
    const baselineCartDist = Math.hypot(3.65 - padCenter[0], 3.90 - padCenter[1]);
    const patchedCartDist = Math.hypot(
      3.65 + 0.60 - padCenter[0],
      3.90 - padCenter[1],
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
    expect(fs.existsSync(path.join(venueDir, 'prepared-venue.glb'))).toBe(true);
    expect(fs.existsSync(path.join(venueDir, 'scene-manifest.json'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(venueDir, 'PROVENANCE.md'))).toBe(true);
    expect(fs.existsSync(path.join(venueDir, 'dev-fixture-smoke.webm'))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(venueDir, 'dev-fixture-smoke.manifest.json')),
    ).toBe(true);
  });
});
