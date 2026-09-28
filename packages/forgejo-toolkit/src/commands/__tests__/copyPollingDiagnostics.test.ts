import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { COPY_POLLING_DIAGNOSTICS_COMMAND } from '../../lease/leaseDegradedNotice';
import { logger } from '../../logger';
import { setServerVersionCacheStorage } from '../../api/serverVersionCache';
import {
  makeMemoryVersionCacheStore,
  type MemoryVersionCacheStore,
} from '../../api/__tests__/serverVersionCacheTestHelpers';
import {
  collectPollingDiagnostics,
  registerCopyPollingDiagnosticsCommand,
  type PollingDiagnosticsCommandSources,
} from '../copyPollingDiagnostics';
import {
  makeLeaseHarness,
  removeLeaseHarness,
  writeForeignLease,
  type LeaseHarness,
} from '../../__tests__/leaseSupervisorHarness';

/**
 * `forgejoToolkit.copyPollingDiagnostics` (§7.1, §11.1 stage 2): registered in
 * the contributed id, copying a valid payload, and never a secret — including
 * from the fallback path where no lease supervisor exists at all.
 */

const instance: ForgejoInstance = {
  id: 'instance-1',
  url: 'https://forgejo.example.com',
  // The token is the thing that must not reach the clipboard.
  token: 's3cr3t-token',
  name: 'forgejo.example.com',
  username: 'alice',
};

const harnesses: LeaseHarness[] = [];

function sources(overrides: Partial<PollingDiagnosticsCommandSources> = {}): PollingDiagnosticsCommandSources {
  return {
    lease: () => undefined,
    config: {
      getInstances: () => [instance],
      isNotificationPollingEnabled: () => true,
      getNotificationPollingInterval: () => 300,
    } as unknown as PollingDiagnosticsCommandSources['config'],
    pollingTiming: () => ({ lastSuccessfulPollAt: 1_000, nextScheduledPollAt: 301_000 }),
    extensionVersion: '0.0.1',
    globalStoragePath: '/storage',
    extensionHostStartedAt: 500,
    ...overrides,
  };
}

/** Registers the command against a throwaway context and returns its handler. */
function register(dependencies: PollingDiagnosticsCommandSources): {
  context: { subscriptions: { dispose(): unknown }[] };
  commandId: string;
  handler: () => Promise<void>;
} {
  const context = { subscriptions: [] as { dispose(): unknown }[] };
  registerCopyPollingDiagnosticsCommand(context as unknown as vscode.ExtensionContext, dependencies);
  const calls = (vscode.commands.registerCommand as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const [commandId, handler] = calls[calls.length - 1] as [string, () => Promise<void>];
  return { context, commandId, handler };
}

function clipboardWrite(): ReturnType<typeof vi.fn> {
  return vscode.env.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
}

function copiedPayload(): Record<string, unknown> {
  const call = clipboardWrite().mock.calls.at(-1) as [string];
  return JSON.parse(call[0]) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  clipboardWrite().mockResolvedValue(undefined);
  (vscode.window.showInformationMessage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await removeLeaseHarness(harness).catch(() => undefined);
  }
  vi.restoreAllMocks();
});

describe('the copy-polling-diagnostics command', () => {
  it('registers under the contributed id and keeps its disposable', () => {
    const { context, commandId } = register(sources());

    expect(commandId).toBe(COPY_POLLING_DIAGNOSTICS_COMMAND);
    expect(COPY_POLLING_DIAGNOSTICS_COMMAND).toBe('forgejoToolkit.copyPollingDiagnostics');
    expect(context.subscriptions).toHaveLength(1);
  });

  it('copies a valid payload with every group, and confirms it in the user’s language', async () => {
    const harness = await makeLeaseHarness({ clockStart: 1_000 });
    harnesses.push(harness);
    await writeForeignLease(harness, { pid: process.pid, heartbeatAt: 1_000 });
    await harness.start();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    const { handler } = register(sources({ lease: () => harness.supervisor }));
    await handler();

    const payload = copiedPayload();
    expect(payload.schemaVersion).toBe(1);
    expect(Object.keys(payload).sort()).toEqual([
      'env',
      'generatedAt',
      'handover',
      'lease',
      'polling',
      'schemaVersion',
      'versions',
      'visibleWindows',
      'window',
    ]);
    // The live state, not a default: this window is the follower of the lease
    // the foreign record describes.
    expect((payload.window as { role: string }).role).toBe('follower');
    expect((payload.lease as { parsed: { pid: number } | null }).parsed?.pid).toBe(process.pid);
    expect((payload.polling as { leaseEnabled: boolean }).leaseEnabled).toBe(true);

    // The payload never carries the access token, and the one-line summary is
    // what the existing View Log command shows.
    const json = clipboardWrite().mock.calls.at(-1)?.[0] as string;
    expect(json).not.toContain('s3cr3t-token');
    expect(info.mock.calls.map(([message]) => message).join('\n')).toContain('polling lease: role=follower');
    expect(info.mock.calls.map(([message]) => message).join('\n')).toContain('holder=pid=');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Polling diagnostics copied to the clipboard');
  });

  it('still produces the payload when no lease supervisor exists, and says so', async () => {
    const { handler } = register(sources({ lease: () => undefined }));
    await handler();

    const payload = copiedPayload();
    expect((payload.window as { role: string }).role).toBe('degraded');
    expect((payload.lease as { parsed: unknown }).parsed).toBeNull();
    expect((payload.polling as { degraded: boolean; degradedReason: string }).degraded).toBe(true);
    expect((payload.polling as { degradedReason: string }).degradedReason).toBe('lease-unavailable');
  });

  it('reports a failure with the localized message instead of rejecting', async () => {
    const { handler } = register(
      sources({
        lease: () => {
          throw new Error('boom');
        },
      }),
    );

    await handler();

    expect(clipboardWrite()).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Failed to copy polling diagnostics: boom', 'View Log');
  });

  it('collects the same payload the command copies, so the tests and the source cannot drift', async () => {
    const payload = await collectPollingDiagnostics(sources());
    expect(payload.schemaVersion).toBe(1);
    expect(payload.polling.nextScheduledPollAt).toBe(301_000);
    // §9 route 2 is implemented, so the report says so rather than describing
    // the pre-route-2 process-local cache.
    expect(payload.versions.followsInstanceConfig).toBe(true);
    expect(payload.versions.probeCache).toEqual([
      { instanceId: 'instance-1', url: 'https://forgejo.example.com', version: null, probedAt: null, stale: null },
    ]);
  });

  it('reports the shared probe cache’s timestamps and staleness, not this window’s own memory', async () => {
    // The store holds another window's results; this window never probed, and
    // the report must still show them — including the expired one, whose value
    // travels with `stale: true` so a reader can tell it may no longer gate.
    const now = Date.now();
    const store: MemoryVersionCacheStore = makeMemoryVersionCacheStore({
      'https://forgejo.example.com': { version: '16.0.1', writtenAt: now - 1_000 },
      'https://old.example.com': { version: '15.0.0', writtenAt: now - 120_000 },
    });
    setServerVersionCacheStorage(store.storage);
    try {
      const payload = await collectPollingDiagnostics(
        sources({
          config: {
            getInstances: () => [
              { ...instance, id: 'fresh', url: 'https://forgejo.example.com' },
              { ...instance, id: 'expired', url: 'https://old.example.com' },
            ],
            isNotificationPollingEnabled: () => true,
            getNotificationPollingInterval: () => 300,
          } as unknown as PollingDiagnosticsCommandSources['config'],
        }),
      );

      expect(payload.versions.followsInstanceConfig).toBe(true);
      expect(payload.versions.probeCache).toEqual([
        {
          instanceId: 'fresh',
          url: 'https://forgejo.example.com',
          version: '16.0.1',
          probedAt: now - 1_000,
          stale: false,
        },
        {
          instanceId: 'expired',
          url: 'https://old.example.com',
          version: '15.0.0',
          probedAt: now - 120_000,
          stale: true,
        },
      ]);
      // The rows never carry the token, shared cache or not.
      expect(JSON.stringify(payload)).not.toContain('s3cr3t-token');
    } finally {
      setServerVersionCacheStorage(undefined);
    }
  });
});
