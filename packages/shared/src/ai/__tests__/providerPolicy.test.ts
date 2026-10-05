import { describe, expect, it } from 'vitest';
import {
  AI_PROVIDER_SEGMENT_PATTERN,
  inspectAiProviderBaseUrl,
  isAiProviderSegment,
  isLocalAiEndpointHost,
} from '../providerPolicy';

/**
 * The three pure rules the extension host and the webview settings page share
 * (`docs/design/ai-model-transport.md` §6.2, §8.2, §8.8).
 *
 * The host's own suite exercises them through `src/ai/modelSettings.ts`, which
 * re-exports them; this file is here so the shared package's own suite covers the
 * exports it publishes, and it stays deliberately small — the two copies assert
 * the same behaviour, and the host's is the fuller one.
 *
 * The addresses below are placeholders and the loopback/private ranges the policy
 * itself defines, the two forms `AGENTS.md`'s code-content rule allows.
 */
describe('the provider segment rule', () => {
  it('accepts letters, digits, "_" and "-" only', () => {
    expect(isAiProviderSegment('ollama-local_2')).toBe(true);
    expect(isAiProviderSegment('')).toBe(false);
    expect(isAiProviderSegment('a.b')).toBe(false);
    expect(isAiProviderSegment('a b')).toBe(false);
    expect(AI_PROVIDER_SEGMENT_PATTERN.source).toBe('^[A-Za-z0-9_-]+$');
  });
});

describe('the base-URL verdict', () => {
  it('accepts https, names http as usable but unencrypted, and refuses the rest', () => {
    const secure = inspectAiProviderBaseUrl('https://models.example.com/v1');
    expect(secure.ok && secure.insecure).toBe(false);

    const plain = inspectAiProviderBaseUrl('http://localhost:11434/v1');
    expect(plain.ok && plain.insecure).toBe(true);
    expect(plain.ok && plain.warning).toContain('http://');

    expect(inspectAiProviderBaseUrl('file:///tmp/v1')).toEqual({ ok: false, reason: expect.stringContaining('file:') });
    expect(inspectAiProviderBaseUrl('not a url').ok).toBe(false);
    expect(inspectAiProviderBaseUrl('https://user:token@models.example.com/v1').ok).toBe(false);
  });
});

describe('the local-only host rule', () => {
  it('names this machine and the private ranges, and nothing else', () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '172.16.3.1', '192.168.1.10', 'host.local', '::1']) {
      expect(isLocalAiEndpointHost(host), host).toBe(true);
    }
    for (const host of ['models.example.com', '172.32.0.1', '8.8.8.8', '']) {
      expect(isLocalAiEndpointHost(host), host).toBe(false);
    }
  });
});
