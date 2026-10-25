import { describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSION,
  createDevFixtureSnapshot,
} from '../../src/shared/index.js';
import {
  applyAndValidatePatch,
  evaluateScene,
} from '../../src/evaluation/index.js';

describe('Stream B — Evaluation & Patch Contract', () => {
  it('derives chair eye height from seatHeightM + eyeOffsetAboveSeatM and wheelchair eye height independently', () => {
    const snapshot = createDevFixtureSnapshot();
    const evaluation = evaluateScene(snapshot);

    expect(evaluation.sceneHash).toBe(snapshot.sceneHash);
    expect(evaluation.capacityCount).toBe(4);
    expect(evaluation.occupiedCount).toBe(4);

    // Reference adult: seatHeightM (0.45) + eyeOffsetAboveSeatM (0.78) = 1.23
    expect(evaluation.attendees['att_adult_01']?.eyePositionWorld[1]).toBeCloseTo(
      1.23,
      4,
    );

    // Shorter seated viewer: seatHeightM (0.45) + eyeOffsetAboveSeatM (0.52) = 0.97
    expect(evaluation.attendees['att_shorter_01']?.eyePositionWorld[1]).toBeCloseTo(
      0.97,
      4,
    );

    // Wheelchair user: independentEyeHeightM (1.18), regardless of seatHeightM (0.0)
    expect(
      evaluation.attendees['att_wheelchair_01']?.eyePositionWorld[1],
    ).toBeCloseTo(1.18, 4);
  });

  it('rejects stale patches whose parentSceneHash mismatches the current snapshot', () => {
    const snapshot = createDevFixtureSnapshot();
    const res = applyAndValidatePatch(snapshot, snapshot, {
      contractVersion: CONTRACT_VERSION,
      runId: 'run_test',
      parentSceneHash: 'vp_stale_hash',
      diagnosis: [],
      operations: [],
      summary: 'stale patch test',
    });

    expect(res.valid).toBe(false);
    expect(res.errors[0]?.code).toBe('STALE_SCENE_HASH');
  });
});
