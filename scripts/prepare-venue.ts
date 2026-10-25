/**
 * Stream A — Venue Preparation Script (`scripts/prepare-venue.ts`)
 * Owned by Workstream A.
 *
 * Prepares and annotates the venue GLB + scene manifest in `public/venue/`.
 */
import { createDevFixtureSnapshot } from '../src/shared/index.js';

export function getPreparedOrDevSnapshot() {
  return createDevFixtureSnapshot();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const snapshot = getPreparedOrDevSnapshot();
  console.log(
    `[Stream A] Baseline snapshot hash=${snapshot.sceneHash} places=${snapshot.places.length}`,
  );
}
