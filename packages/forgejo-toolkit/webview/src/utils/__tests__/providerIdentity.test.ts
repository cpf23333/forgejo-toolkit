import { describe, expect, it } from 'vitest';
import {
  AI_PROVIDER_GENERATED_ID_FALLBACK,
  AI_PROVIDER_GENERATED_ID_MAX_LENGTH,
  generateAiProviderId,
  generateAiProviderName,
  uniqueAiProviderId,
} from '../providerIdentity';

/**
 * The identity a new AI endpoint gets from its address
 * (`docs/design/settings-page.md` §5.1, §5.2).
 *
 * The two rules are the record's, and the examples are its own table: the id is
 * the host reduced to the characters a `SecretStorage` key segment may hold (the
 * class comes from the shared `AI_PROVIDER_SEGMENT_PATTERN`, so an id this module
 * produces is always one the host accepts), and the display name is the host with
 * its port, lowercased. A collision is resolved by suffix rather than silently
 * reusing a name that already holds another endpoint's keys.
 *
 * The addresses are placeholder domains and loopback addresses, the two forms
 * `AGENTS.md`'s code-content rule allows.
 */
describe('generated endpoint id', () => {
  it('reduces the host to a legal key segment', () => {
    expect(generateAiProviderId('https://api.example.com/v1')).toBe('api-example-com');
    expect(generateAiProviderId('http://localhost:11434/v1')).toBe('localhost');
    expect(generateAiProviderId('https://www.example.com/openai')).toBe('example-com');
    expect(generateAiProviderId('http://127.0.0.1:8080/v1')).toBe('127-0-0-1');
  });

  it('strips the port, the leading www. and the case', () => {
    expect(generateAiProviderId('https://API.Example.COM:8443/v1')).toBe('api-example-com');
    // The `www.` is stripped once, from the front, and only there.
    expect(generateAiProviderId('https://www.www.example.com/v1')).toBe('www-example-com');
  });

  it('collapses the characters it replaces rather than keeping a run of them', () => {
    // `a..b` is two forbidden characters in a row: one `-`, not two.
    expect(generateAiProviderId('https://a..b.example.com/v1')).toBe('a-b-example-com');
    expect(generateAiProviderId('https://-leading.example.com/v1')).toBe('leading-example-com');
  });

  it('caps the id at 48 characters and never ends it on a separator', () => {
    const host = `${'a'.repeat(60)}.example.com`;
    const id = generateAiProviderId(`https://${host}/v1`);
    expect(id).toHaveLength(AI_PROVIDER_GENERATED_ID_MAX_LENGTH);
    expect(id.endsWith('-')).toBe(false);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('falls back to "endpoint" for an address that yields nothing usable', () => {
    expect(generateAiProviderId('not a url')).toBe(AI_PROVIDER_GENERATED_ID_FALLBACK);
    // An IPv6 literal keeps no alphanumeric character once the brackets and
    // colons are replaced in the `::`-only case; the fallback is what is left.
    expect(generateAiProviderId('')).toBe(AI_PROVIDER_GENERATED_ID_FALLBACK);
  });
});

describe('generated endpoint display name', () => {
  it('keeps the port and reads like a name a user would type', () => {
    expect(generateAiProviderName('https://api.example.com/v1')).toBe('api.example.com');
    expect(generateAiProviderName('http://localhost:11434/v1')).toBe('localhost:11434');
    // The name is deliberately not the id: `www.` is part of what the user typed.
    expect(generateAiProviderName('https://www.example.com/openai')).toBe('www.example.com');
    expect(generateAiProviderName('http://127.0.0.1:8080/v1')).toBe('127.0.0.1:8080');
  });

  it('answers nothing for an address that is not a URL', () => {
    expect(generateAiProviderName('forgejo.example.com')).toBe('');
  });
});

describe('endpoint id collisions', () => {
  it('keeps the suggested id when nothing uses it', () => {
    expect(uniqueAiProviderId('api-example-com', [])).toBe('api-example-com');
    expect(uniqueAiProviderId('api-example-com', ['other', '  '])).toBe('api-example-com');
  });

  it('adds -2, -3 ... until the id is free, case-insensitively', () => {
    expect(uniqueAiProviderId('api-example-com', ['api-example-com'])).toBe('api-example-com-2');
    expect(uniqueAiProviderId('api-example-com', ['api-example-com', 'API-EXAMPLE-COM-2'])).toBe('api-example-com-3');
    // `SecretStorage` keys are case-sensitive and the user is not: a name
    // differing only in case still holds the same keys.
    expect(uniqueAiProviderId('API-Example-Com', ['api-example-com'])).toBe('API-Example-Com-2');
  });

  it('counts the suffix against the 48-character cap', () => {
    const long = 'a'.repeat(AI_PROVIDER_GENERATED_ID_MAX_LENGTH);
    const resolved = uniqueAiProviderId(long, [long]);
    expect(resolved).toHaveLength(AI_PROVIDER_GENERATED_ID_MAX_LENGTH);
    expect(resolved.endsWith('-2')).toBe(true);
    // The base is shortened to make room, so the id cannot overflow the cap by
    // being disambiguated.
    expect(resolved).toBe(`${'a'.repeat(AI_PROVIDER_GENERATED_ID_MAX_LENGTH - 2)}-2`);
  });
});
