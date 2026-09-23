import { describe, expect, it } from 'vitest';
import { withAbortSignal, withDispatcher } from '../client';

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

describe('withDispatcher', () => {
  it('adds the dispatcher to the request config', () => {
    const config = { method: 'GET', url: '/user' } as never;
    const agent = { fake: true };
    expect((withDispatcher(config, agent) as { dispatcher?: unknown }).dispatcher).toBe(agent);
    expect((config as { dispatcher?: unknown }).dispatcher).toBeUndefined();
  });

  it('returns the same config when there is no dispatcher', () => {
    const config = { method: 'GET', url: '/user' } as never;
    expect(withDispatcher(config, undefined)).toBe(config);
  });
});
