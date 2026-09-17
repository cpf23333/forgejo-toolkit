import { afterEach, describe, expect, it } from 'vitest';
import {
  assertActionsSupported,
  clearServerVersion,
  clearServerVersions,
  getServerVersion,
  isVersionAtLeast,
  MIN_ACTIONS_VERSION,
  parseServerVersion,
  setServerVersion,
} from '../serverVersion';

afterEach(() => {
  clearServerVersions();
});

describe('parseServerVersion', () => {
  it('parses plain semver strings', () => {
    expect(parseServerVersion('1.21.5')).toEqual({ major: 1, minor: 21, patch: 5 });
    expect(parseServerVersion('7.0.1')).toEqual({ major: 7, minor: 0, patch: 1 });
  });

  it('tolerates a leading v and suffixes', () => {
    expect(parseServerVersion('v1.19.2')).toEqual({ major: 1, minor: 19, patch: 2 });
    expect(parseServerVersion('1.21.5+gitea-1.21')).toEqual({ major: 1, minor: 21, patch: 5 });
  });

  it('defaults a missing patch component to 0', () => {
    expect(parseServerVersion('1.19')).toEqual({ major: 1, minor: 19, patch: 0 });
  });

  it('returns undefined for unparseable input', () => {
    expect(parseServerVersion('')).toBeUndefined();
    expect(parseServerVersion('devel')).toBeUndefined();
    expect(parseServerVersion('1')).toBeUndefined();
  });
});

describe('isVersionAtLeast', () => {
  const min = { major: 1, minor: 19, patch: 0 };

  it('accepts equal and newer versions', () => {
    expect(isVersionAtLeast({ major: 1, minor: 19, patch: 0 }, min)).toBe(true);
    expect(isVersionAtLeast({ major: 1, minor: 21, patch: 5 }, min)).toBe(true);
    expect(isVersionAtLeast({ major: 7, minor: 0, patch: 0 }, min)).toBe(true);
  });

  it('rejects older versions', () => {
    expect(isVersionAtLeast({ major: 1, minor: 18, patch: 9 }, min)).toBe(false);
    expect(isVersionAtLeast({ major: 0, minor: 99, patch: 0 }, min)).toBe(false);
  });
});

describe('server version registry', () => {
  it('keys versions by normalized URL', () => {
    setServerVersion('https://forgejo.example.com/', '1.21.0');
    expect(getServerVersion('https://forgejo.example.com')).toBe('1.21.0');
    expect(getServerVersion('https://forgejo.example.com/')).toBe('1.21.0');
  });

  it('returns undefined for unknown instances', () => {
    expect(getServerVersion('https://unknown.example.com')).toBeUndefined();
  });

  it('clearServerVersion drops only the entry for the given URL', () => {
    setServerVersion('https://forgejo.example.com', '1.18.0');
    setServerVersion('https://other.example.com', '1.21.0');

    clearServerVersion('https://forgejo.example.com/');

    expect(getServerVersion('https://forgejo.example.com')).toBeUndefined();
    expect(getServerVersion('https://other.example.com')).toBe('1.21.0');
  });

  it('clearServerVersion re-enables the Actions gate after a server upgrade', () => {
    setServerVersion('https://old.example.com', '1.18.3');
    expect(() => assertActionsSupported('https://old.example.com')).toThrow(/requires Forgejo .* or newer/);

    clearServerVersion('https://old.example.com');
    // Unknown versions fail open again until the next probe records one.
    expect(() => assertActionsSupported('https://old.example.com')).not.toThrow();
  });
});

describe('assertActionsSupported', () => {
  it('throws a localized error for servers older than the Actions API', () => {
    setServerVersion('https://old.example.com', '1.18.3');
    expect(() => assertActionsSupported('https://old.example.com')).toThrow(/requires Forgejo .* or newer/);
  });

  it('passes for servers new enough', () => {
    setServerVersion('https://new.example.com', '1.21.0');
    expect(() => assertActionsSupported('https://new.example.com')).not.toThrow();
    setServerVersion('https://newer.example.com', '7.0.1');
    expect(() => assertActionsSupported('https://newer.example.com')).not.toThrow();
  });

  it('fails open for unknown or unparseable versions', () => {
    expect(() => assertActionsSupported('https://unprobed.example.com')).not.toThrow();
    setServerVersion('https://weird.example.com', 'custom-build');
    expect(() => assertActionsSupported('https://weird.example.com')).not.toThrow();
  });

  it('uses 1.19.0 as the Actions threshold', () => {
    expect(MIN_ACTIONS_VERSION).toEqual({ major: 1, minor: 19, patch: 0 });
  });
});
