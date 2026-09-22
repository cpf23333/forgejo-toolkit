import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import * as vscode from 'vscode';
import { probeServerVersion } from '../versionProbe';
import { clearServerVersions, getServerVersion } from '../serverVersion';
import { startMockServer, stopMockServer, resetMockServer, mockServer } from '../../test/mocks/server';
import { MOCK_SERVER_VERSION } from '../../test/mocks/handlers';

const showWarningMessage = vi.mocked(vscode.window.showWarningMessage);

function mockVersion(version: string): void {
  mockServer.use(http.get('https://*/api/v1/version', () => HttpResponse.json({ version })));
}

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
    showWarningMessage.mockClear();
  });

  it('caches the probed version in the registry', async () => {
    await probeServerVersion('https://forgejo.example.com', 'mock-token');
    expect(getServerVersion('https://forgejo.example.com')).toBe(MOCK_SERVER_VERSION);
  });

  it('swallows probe failures and leaves the registry empty', async () => {
    mockServer.use(http.get('https://*/api/v1/version', () => new HttpResponse(null, { status: 500 })));
    await expect(probeServerVersion('https://forgejo.example.com', 'mock-token')).resolves.toBeUndefined();
    expect(getServerVersion('https://forgejo.example.com')).toBeUndefined();
  });

  it.each(['16.0.0', '16.0.5', '17.0.0'])('does not warn for supported version %s', async (version) => {
    mockVersion(version);
    await probeServerVersion(`https://supported-${version}.example.com`, 'mock-token');
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it.each(['1.21.0', '7.0.0', '14.9.9', '15.0.0', '15.0.1'])(
    'warns once for unsupported version %s',
    async (version) => {
      mockVersion(version);
      await probeServerVersion(`https://unsupported-${version}.example.com`, 'mock-token');
      expect(showWarningMessage).toHaveBeenCalledTimes(1);
      const message = showWarningMessage.mock.calls[0][0] as string;
      expect(message).toContain(version);
      expect(message).toContain('16.0.0');
    },
  );

  it('does not warn when the probe fails and the version stays unknown', async () => {
    mockServer.use(http.get('https://*/api/v1/version', () => new HttpResponse(null, { status: 500 })));
    await probeServerVersion('https://unprobed.example.com', 'mock-token');
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('dedupes the warning per instance URL for the session', async () => {
    mockVersion('7.0.0');
    await probeServerVersion('https://dup.example.com', 'mock-token');
    await probeServerVersion('https://dup.example.com', 'mock-token');
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
  });
});
