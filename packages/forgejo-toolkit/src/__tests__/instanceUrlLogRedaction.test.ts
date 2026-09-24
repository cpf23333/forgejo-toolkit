import { afterEach, describe, expect, it, vi } from 'vitest';

const clientMocks = vi.hoisted(() => ({ getServerVersion: vi.fn() }));

// The probe is exercised without the network: a credentials-bearing instance URL
// is refused by fetch itself, so a real request could never reach the success
// log line that is under test here.
vi.mock('../api/client', () => ({
  ForgejoClient: class {
    getServerVersion = clientMocks.getServerVersion;
  },
}));

import { probeServerVersion, redactInstanceUrl } from '../api/versionProbe';
import { clearServerVersions } from '../api/serverVersion';
import { logger } from '../logger';

describe('redactInstanceUrl', () => {
  it('removes a password from an http(s) instance URL', () => {
    const redacted = redactInstanceUrl('https://user:secret-token@forgejo.example.com');
    expect(redacted).not.toContain('secret-token');
    expect(redacted).toContain('forgejo.example.com');
  });

  it('removes the username of an http(s) URL that carries no password', () => {
    // A token is commonly written in the username position.
    const redacted = redactInstanceUrl('https://secret-token@forgejo.example.com');
    expect(redacted).not.toContain('secret-token');
    expect(redacted).toContain('forgejo.example.com');
  });

  it('leaves a URL without credentials untouched', () => {
    expect(redactInstanceUrl('https://forgejo.example.com')).toBe('https://forgejo.example.com');
  });

  it('leaves an ssh login visible, which names no secret', () => {
    expect(redactInstanceUrl('ssh://git@forgejo.example.com')).toBe('ssh://git@forgejo.example.com');
  });

  it('handles an scp-like remote without trying to parse it', () => {
    expect(redactInstanceUrl('git@forgejo.example.com:owner/repo.git')).toBe('git@forgejo.example.com:owner/repo.git');
  });

  it('does not throw for a value that is not an absolute URL', () => {
    expect(redactInstanceUrl('forgejo.example.com')).toBe('forgejo.example.com');
  });
});

describe('probeServerVersion log redaction', () => {
  afterEach(() => {
    clearServerVersions();
    clientMocks.getServerVersion.mockReset();
    vi.restoreAllMocks();
  });

  it('redacts credentials when it logs the probed version', async () => {
    // The line reaches the extension output channel and the MCP server's stderr;
    // the configured instance URL may embed the access token.
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    clientMocks.getServerVersion.mockResolvedValue('17.0.0');

    await probeServerVersion('https://user:secret-token@forgejo.example.com', 'secret-token', logger);

    const lines = debug.mock.calls.map((call) => String(call[0]));
    const versionLine = lines.find((line) => line.includes('Server version for'));
    expect(versionLine).toBeDefined();
    expect(versionLine).not.toContain('secret-token');
    expect(versionLine).toContain('forgejo.example.com');
  });

  it('redacts credentials echoed by the failure detail', async () => {
    // fetch refuses a URL that carries credentials and quotes it back, so the
    // error message — not just the URL prefix — would leak the token.
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const url = 'https://user:secret-token@failed.example.com';
    clientMocks.getServerVersion.mockRejectedValue(
      new Error(`Request cannot be constructed from a URL that includes credentials: ${url}/api/v1/version`),
    );

    await probeServerVersion(url, 'secret-token', logger);

    const lines = debug.mock.calls.map((call) => String(call[0]));
    const failureLine = lines.find((line) => line.includes('Server version probe failed'));
    expect(failureLine).toBeDefined();
    expect(failureLine).not.toContain('secret-token');
    expect(failureLine).toContain('failed.example.com');
  });
});
