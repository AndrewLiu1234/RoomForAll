import { describe, expect, it } from 'vitest';
import { createDevFixtureSnapshot } from '../../src/shared/index.js';
import { captureEvidence } from '../../src/scene/index.js';

describe('Stream A — Scene & Evidence Contract', () => {
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
        deadlineIso: new Date().toISOString(),
      }),
    ).rejects.toThrow(/Scene hash mismatch/);
  });
});
