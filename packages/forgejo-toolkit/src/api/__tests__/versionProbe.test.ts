import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { probeServerVersion } from '../versionProbe';
import { clearServerVersions, getServerVersion } from '../serverVersion';
import { startMockServer, stopMockServer, resetMockServer, mockServer } from '../../test/mocks/server';

describe('probeServerVersion', () => {
  beforeAll(() => {
    startMockServer();
  });

  afterAll(() => {
    stopMockServer();
  });

  afterEach(() => {
    resetMockServer();
    clearServerVersions();
  });

  it('caches the probed version in the registry', async () => {
    await probeServerVersion('https://forgejo.example.com', 'mock-token');
    expect(getServerVersion('https://forgejo.example.com')).toBe('1.21.5');
  });

  it('swallows probe failures and leaves the registry empty', async () => {
    mockServer.use(http.get('https://*/api/v1/version', () => new HttpResponse(null, { status: 500 })));
    await expect(probeServerVersion('https://forgejo.example.com', 'mock-token')).resolves.toBeUndefined();
    expect(getServerVersion('https://forgejo.example.com')).toBeUndefined();
  });
});
