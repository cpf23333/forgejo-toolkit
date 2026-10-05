import { describe, expect, it } from 'vitest';
import { AI_PROVIDER_SEGMENT_PATTERN, inspectAiProviderBaseUrl, isAiProviderSegment } from '../providerPolicy';

/**
 * The two pure rules the extension host and the webview settings page share
 * (`docs/design/ai-model-transport.md` §6.2, §8.2).
 *
 * The host's own suite exercises them through `src/ai/modelSettings.ts`, which
 * re-exports them; this file is here so the shared package's own suite covers the
 * exports it publishes, and it stays deliberately small — the two copies assert
 * the same behaviour, and the host's is the fuller one.
 *
 * The addresses below are placeholder domains.
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

    const plain = inspectAiProviderBaseUrl('http://gateway.example.com/v1');
    expect(plain.ok && plain.insecure).toBe(true);
    expect(plain.ok && plain.warning).toContain('http://');

    expect(inspectAiProviderBaseUrl('file:///tmp/v1')).toEqual({ ok: false, reason: expect.stringContaining('file:') });
    expect(inspectAiProviderBaseUrl('not a url').ok).toBe(false);
    expect(inspectAiProviderBaseUrl('https://user:token@models.example.com/v1').ok).toBe(false);
  });
});
