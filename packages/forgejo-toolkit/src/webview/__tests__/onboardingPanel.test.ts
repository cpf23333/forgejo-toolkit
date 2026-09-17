import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../api/client', () => ({
  ForgejoClient: vi.fn().mockImplementation(function () {
    return {
      getCurrentUser: vi.fn().mockResolvedValue({ login: 'user' }),
      renderMarkdown: vi.fn().mockResolvedValue('<p>hi</p>'),
    };
  }),
}));

vi.mock('../../worktree/gitOperations', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../worktree/gitOperations')>();
  return { ...original, clearLinkedRepositoryCache: vi.fn() };
});

import { OnboardingWebviewPanel } from '../onboardingPanel';
import { ConfigManager } from '../../config';
import { ReadmeContentProvider } from '../../readmeProvider';
import { clearServerVersions, getServerVersion, setServerVersion } from '../../api/serverVersion';
import { clearLinkedRepositoryCache } from '../../worktree/gitOperations';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

type MessageListener = (message: unknown) => void;

function createFakeContext() {
  const store = new Map<string, unknown>();
  const secretStore = new Map<string, string>();
  return {
    subscriptions: [] as Array<{ dispose(): void }>,
    globalState: {
      get: (key: string, fallback?: unknown) => store.get(key) ?? fallback,
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
    secrets: {
      get: async (key: string) => secretStore.get(key),
      store: async (key: string, value: string) => {
        secretStore.set(key, value);
      },
      delete: async (key: string) => {
        secretStore.delete(key);
      },
    },
    globalStorageUri: { fsPath: '/global-storage' },
    extensionUri: { fsPath: '/ext' },
  };
}

function createFakePanel() {
  const posted: unknown[] = [];
  let listener: MessageListener | undefined;
  const panel = {
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidDispose: () => ({ dispose: vi.fn() }),
    webview: {
      html: '',
      cspSource: '',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: (message: unknown) => {
        posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (l: MessageListener) => {
        listener = l;
        return { dispose: vi.fn() };
      },
    },
  };
  return {
    panel,
    posted,
    send: (message: unknown) => listener?.(message),
  };
}

function postedMessages(posted: unknown[]): Array<Record<string, unknown>> {
  return posted as Array<Record<string, unknown>>;
}

async function flushDispatches() {
  // Dispatch is fire-and-forget; let the handler promise chain settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Flush macrotasks until the predicate holds. Flows that cross real `fs`
 * promises (threadpool) need more than a fixed number of ticks.
 */
async function flushUntil(predicate: () => boolean, attempts = 50) {
  for (let i = 0; i < attempts && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const testInstance: ForgejoInstance = {
  id: 'forgejo.example.com-user',
  url: 'https://forgejo.example.com',
  token: 'secret-token',
  name: 'user@forgejo.example.com',
  username: 'user',
};

describe('OnboardingWebviewPanel message dispatch', () => {
  let context: ReturnType<typeof createFakeContext>;
  let config: ConfigManager;
  let fake: ReturnType<typeof createFakePanel>;

  beforeEach(async () => {
    context = createFakeContext();
    config = new ConfigManager(context as never);
    fake = createFakePanel();
    vi.mocked(clearLinkedRepositoryCache).mockReset();
    clearServerVersions();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fake.panel as never);
    OnboardingWebviewPanel.currentPanel = undefined;
    OnboardingWebviewPanel.createOrShow(
      context as never,
      context.extensionUri as never,
      config,
      new ReadmeContentProvider(),
    );
    await config.addInstance(testInstance);
  });

  it('replies with requestError when a request handler returns early without answering', async () => {
    fake.send({
      command: 'renderMarkdown',
      instanceId: 'unknown-instance',
      text: 'hello',
      _requestId: 'req-early-return',
    });
    await flushDispatches();
    const messages = postedMessages(fake.posted);
    const fallback = messages.find((m) => m.command === 'requestError');
    expect(fallback).toBeDefined();
    expect(fallback?._requestId).toBe('req-early-return');
    expect(typeof fallback?.error).toBe('string');
    expect(messages.some((m) => m.command === 'renderedMarkdown')).toBe(false);
  });

  it('replies with requestError when a request handler throws', async () => {
    vi.spyOn(config, 'getInstances').mockImplementation(() => {
      throw new Error('storage exploded');
    });
    fake.send({ command: 'getInitialState', _requestId: 'req-throw' });
    await flushDispatches();
    const fallback = postedMessages(fake.posted).find((m) => m.command === 'requestError');
    expect(fallback).toBeDefined();
    expect(fallback?._requestId).toBe('req-throw');
  });

  it('does not send a fallback reply when the handler answered the request', async () => {
    fake.send({
      command: 'renderMarkdown',
      instanceId: testInstance.id,
      text: 'hello',
      _requestId: 'req-answered',
    });
    await flushDispatches();
    const messages = postedMessages(fake.posted);
    const answer = messages.find((m) => m.command === 'renderedMarkdown');
    expect(answer).toBeDefined();
    expect(answer?._requestId).toBe('req-answered');
    expect(messages.some((m) => m.command === 'requestError')).toBe(false);
  });

  it('does not turn handler errors of plain messages into unhandled rejections', async () => {
    vi.spyOn(config, 'removeInstance').mockRejectedValue(new Error('update failed'));
    // removeInstance carries no _requestId: the error is logged, no reply sent.
    fake.send({ command: 'removeInstance', id: testInstance.id });
    await flushDispatches();
    expect(postedMessages(fake.posted).some((m) => m.command === 'requestError')).toBe(false);
  });

  it('removeInstance aborts without touching the config when the user declines the confirmation', async () => {
    const removeSpy = vi.spyOn(config, 'removeInstance');
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);

    fake.send({ command: 'removeInstance', id: testInstance.id });
    await flushDispatches();

    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(config.getInstances()).toHaveLength(1);
  });

  it('ignores malformed messages without throwing', async () => {
    fake.send(undefined);
    fake.send('not-an-object');
    await flushDispatches();
    expect(fake.posted).toHaveLength(0);
  });

  it('saveInstance clears the cached server version and linked-repository scan', async () => {
    setServerVersion('https://new.example.com', '1.18.0');

    fake.send({ command: 'saveInstance', url: 'https://new.example.com/', token: 'tok' });
    await flushDispatches();

    const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
    expect(result).toMatchObject({ success: true });
    expect(getServerVersion('https://new.example.com')).toBeUndefined();
    expect(vi.mocked(clearLinkedRepositoryCache)).toHaveBeenCalled();
  });

  it('strips tokens from the import preview and rehydrates them from the stash on confirm', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-import-')), 'export.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        instances: [
          { id: 'imported-1', url: 'https://forgejo.example.com', token: 'file-token-1', name: 'one', username: 'u' },
        ],
      }),
    );
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file(file)] as never);

    fake.send({ command: 'previewImportInstances' });
    await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'importInstancesPreview'));

    const preview = postedMessages(fake.posted).find((m) => m.command === 'importInstancesPreview');
    expect(JSON.stringify(preview)).not.toContain('file-token-1');

    fake.send({
      command: 'importInstances',
      ids: ['imported-1'],
      // Forged webview-supplied instance data must be ignored.
      instances: [
        { id: 'imported-1', url: 'https://evil.example.com', token: 'forged-token', name: 'evil', username: 'evil' },
      ],
    });
    await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'instancesImported'));

    const reply = postedMessages(fake.posted).find((m) => m.command === 'instancesImported');
    expect(reply).toMatchObject({ success: true, count: 1 });
    const imported = config.getInstances().find((i) => i.id === 'imported-1');
    expect(imported?.token).toBe('file-token-1');
    expect(imported?.url).toBe('https://forgejo.example.com');
  });
});
