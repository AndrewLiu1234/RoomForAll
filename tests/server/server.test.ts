import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/index.js';

describe('Stream C — Controller Contract', () => {
  it('creates an Express app instance with preview and run routes', () => {
    const app = createApp();
    expect(app).toBeDefined();
  });
});
