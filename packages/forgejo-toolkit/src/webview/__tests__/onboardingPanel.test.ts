import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

vi.mock('../../api/client', () => ({
  ForgejoClient: vi.fn().mockImplementation(function () {
    return {
      getCurrentUser: vi.fn().mockResolvedValue({ login: 'user' }),
      renderMarkdown: vi.fn().mockResolvedValue('<p>hi</p>'),
    };
  }),
}));

import { OnboardingWebviewPanel } from '../onboardingPanel';
import { ConfigManager } from '../../config';
import { ReadmeContentProvider } from '../../readmeProvider';
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

  it('ignores malformed messages without throwing', async () => {
    fake.send(undefined);
    fake.send('not-an-object');
    await flushDispatches();
    expect(fake.posted).toHaveLength(0);
  });
});
