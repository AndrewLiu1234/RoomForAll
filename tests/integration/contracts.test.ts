import { describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSION,
  PATCH_CONSTRAINTS,
  VISIBILITY_CLEAR_MIN_SAMPLES,
  VISIBILITY_GRID_COLS,
  VISIBILITY_GRID_ROWS,
  VISIBILITY_TOTAL_SAMPLES,
  applyGroupDeltaToMemberTransform,
  computeSceneHash,
  createBlindCritiquePayload,
  createDevFixtureSnapshot,
  getAttendeeCameraPose,
  getAttendeeTorsoProxyWorldBox,
  getTargetSamplePointsWorld,
  yawDegToForwardVector,
  yawDegToRightVector,
} from '../../src/shared/index.js';

describe('Stream D — Shared Integration Contracts', () => {
  it('enforces PRD coordinate conventions (0° yaw faces -Z, right-handed about +Y)', () => {
    expect(yawDegToForwardVector(0)).toEqual([0, 0, -1]);
    expect(yawDegToRightVector(0)).toEqual([1, 0, 0]);
    expect(yawDegToForwardVector(90)).toEqual([-1, 0, 0]);
    expect(yawDegToForwardVector(-90)).toEqual([1, 0, 0]);
    expect(yawDegToForwardVector(180)).toEqual([0, 0, 1]);
  });

  it('freezes PRD visibility and patch constants', () => {
    expect(VISIBILITY_GRID_COLS * VISIBILITY_GRID_ROWS).toBe(
      VISIBILITY_TOTAL_SAMPLES,
    );
    expect(VISIBILITY_TOTAL_SAMPLES).toBe(135);
    expect(VISIBILITY_CLEAR_MIN_SAMPLES).toBe(122);
    expect(PATCH_CONSTRAINTS.maxOperations).toBe(6);
    expect(PATCH_CONSTRAINTS.translationStepM).toBe(0.05);
    expect(PATCH_CONSTRAINTS.maxAxisDeltaM).toBe(0.6);
    expect(PATCH_CONSTRAINTS.maxYawDeltaDeg).toBe(10);
    expect(PATCH_CONSTRAINTS.maxTotalDisplacementFromBaselineM).toBe(1.5);
  });

  it('produces identical deterministic scene hashes for identical snapshots', () => {
    const snap1 = createDevFixtureSnapshot();
    const snap2 = createDevFixtureSnapshot();
    expect(snap1.sceneHash).toBe(snap2.sceneHash);
    expect(computeSceneHash(snap1)).toBe(snap1.sceneHash);
  });

  it('ensures every assigned place in devFixture satisfies profile required footprint', () => {
    const snapshot = createDevFixtureSnapshot();
    for (const member of snapshot.roster) {
      const profile = snapshot.profiles[member.profileId];
      const place = snapshot.places.find((p) => p.id === member.assignedPlaceId);
      expect(place).toBeDefined();
      expect(place!.widthM).toBeGreaterThanOrEqual(
        profile.requiredFootprintWidthM,
      );
      expect(place!.depthM).toBeGreaterThanOrEqual(
        profile.requiredFootprintDepthM,
      );
    }
  });

  it('computes 135 target sample points and sanitized blind critique payload', () => {
    const snapshot = createDevFixtureSnapshot();
    const samples = getTargetSamplePointsWorld(snapshot.target);
    expect(samples).toHaveLength(135);

    const pose = getAttendeeCameraPose(snapshot, 'att_shorter_01');
    expect(pose.eyePositionWorld).toEqual([0, 0.97, 0.5]);
    expect(pose.fovDeg).toBe(90);
    expect(pose.aspect).toBe(1.0);

    const torso = getAttendeeTorsoProxyWorldBox(snapshot, 'att_adult_01');
    expect(torso.centerWorld[1]).toBeCloseTo(0.45 + 0.85 / 2, 4);

    const groupUpdated = applyGroupDeltaToMemberTransform(
      { position: [-1.2, 0, -0.8], yawDeg: 0 },
      [0, 0, -0.8],
      [0.15, 0, -0.1],
      0,
    );
    expect(groupUpdated.position[0]).toBeCloseTo(-1.05, 4);
    expect(groupUpdated.position[2]).toBeCloseTo(-0.9, 4);

    const blindPayload = createBlindCritiquePayload(snapshot, {
      contractVersion: CONTRACT_VERSION,
      captureId: 'cap_1',
      runId: 'run_1',
      phase: 'baseline',
      sceneHash: snapshot.sceneHash,
      mimeType: 'video/webm',
      byteLength: 1024,
      durationSec: 3,
      widthPx: 512,
      heightPx: 512,
      keyframes: [],
      recordedAtIso: new Date().toISOString(),
    });
    expect('evaluation' in blindPayload).toBe(false);
    expect(blindPayload.editableObjects.length).toBeGreaterThan(0);
  });
});
