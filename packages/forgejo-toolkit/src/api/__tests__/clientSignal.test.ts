import { describe, expect, it } from 'vitest';
import { withAbortSignal } from '../client';

describe('withAbortSignal', () => {
  it('adds the signal to the request config', () => {
    const controller = new AbortController();
    const config = { method: 'GET', url: '/user' } as never;
    const merged = withAbortSignal(config, controller.signal) as { signal?: AbortSignal };
    expect(merged.signal).toBe(controller.signal);
    // The original object is left alone.
    expect((config as { signal?: AbortSignal }).signal).toBeUndefined();
  });

  it('returns the same config when there is no signal', () => {
    const config = { method: 'GET', url: '/user' } as never;
    expect(withAbortSignal(config, undefined)).toBe(config);
  });
});
