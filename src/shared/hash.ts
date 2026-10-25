import type { SceneSnapshot } from './types.js';

/**
 * Normalizes a value recursively for deterministic canonical JSON serialization:
 * - Rounds finite numbers to 4 decimal places via toFixed(4)
 * - Normalizes -0 to 0
 * - Sorts object keys lexicographically
 * - Excludes `sceneHash` at root when hashing a SceneSnapshot
 */
export function canonicalizeValue(value: unknown, isRoot = false): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const rounded = Number(value.toFixed(4));
    return Object.is(rounded, -0) ? 0 : rounded;
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item, false));
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      if (isRoot && key === 'sceneHash') continue;
      const v = record[key];
      if (v !== undefined) {
        out[key] = canonicalizeValue(v, false);
      }
    }
    return out;
  }
  return null;
}

/**
 * Dual-lane 32-bit FNV-1a / Cyrb53-style deterministic string hash (pure TS,
 * identical output in browser and Node without external dependencies).
 */
export function hashStringDeterministic(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `vp_${hex1}${hex2}`;
}

/**
 * Computes a deterministic `sceneHash` for a `SceneSnapshot`.
 * Ignores any existing `snapshot.sceneHash` field so re-hashing is idempotent.
 */
export function computeSceneHash(
  snapshot: Omit<SceneSnapshot, 'sceneHash'> | SceneSnapshot,
): string {
  const canonical = canonicalizeValue(snapshot, true);
  const serialized = JSON.stringify(canonical);
  return hashStringDeterministic(serialized);
}

/**
 * Returns a deep clone of `snapshot` with an up-to-date `sceneHash`.
 */
export function withUpdatedSceneHash(
  snapshot: Omit<SceneSnapshot, 'sceneHash'> | SceneSnapshot,
): SceneSnapshot {
  const cloned = structuredClone(snapshot);
  const sceneHash = computeSceneHash(cloned);
  return {
    ...cloned,
    sceneHash,
  };
}
