import { describe, expect, it } from 'vitest';
import { combineRequestSignals, requestSignalFor, withAbortSignal, withDispatcher } from '../client';

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

  it('pairs the dispatcher with the fetch that understands it', () => {
    const config = { method: 'GET', url: '/user' } as never;
    const agent = { fake: true };
    const fetchImpl = (() => Promise.resolve(new Response())) as never;
    const merged = withDispatcher(config, agent, fetchImpl) as { dispatcher?: unknown; fetchImpl?: unknown };
    expect(merged.dispatcher).toBe(agent);
    expect(merged.fetchImpl).toBe(fetchImpl);
  });

  it('returns the same config when there is no dispatcher', () => {
    const config = { method: 'GET', url: '/user' } as never;
    expect(withDispatcher(config, undefined)).toBe(config);
  });
});

describe('combineRequestSignals', () => {
  it('keeps every signal able to abort the request', () => {
    // The MCP cancel signal used to be overwritten by the request timeout, so a
    // cancelled tool call kept its HTTP request running.
    const cancel = new AbortController();
    const timeout = new AbortController();
    const combined = combineRequestSignals([undefined, cancel.signal, timeout.signal]);
    expect(combined?.aborted).toBe(false);
    cancel.abort();
    expect(combined?.aborted).toBe(true);
  });

  it('returns the signal itself when it is the only one and nothing when there are none', () => {
    const controller = new AbortController();
    expect(combineRequestSignals([undefined, controller.signal])).toBe(controller.signal);
    expect(combineRequestSignals([undefined, undefined])).toBeUndefined();
  });
});

describe('requestSignalFor', () => {
  it('lets a caller signal replace the default timeout', () => {
    // The timeout bounds requests nobody bounded; a caller that passes its own
    // signal (long artifact or log downloads) must not be cut off at 30 s.
    const long = AbortSignal.timeout(300_000);
    expect(requestSignalFor(long, undefined)).toBe(long);
  });

  it('always keeps the client-level signal able to abort', () => {
    // The MCP cancel signal used to be overwritten by the request timeout.
    const cancel = new AbortController();
    const combined = requestSignalFor(undefined, cancel.signal);
    expect(combined).not.toBe(cancel.signal);
    expect(combined.aborted).toBe(false);
    cancel.abort();
    expect(combined.aborted).toBe(true);
  });

  it('bounds a request nobody bounded with the default timeout', () => {
    const signal = requestSignalFor(undefined, undefined);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });
});
