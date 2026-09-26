import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const clientMocks = vi.hoisted(() => ({
  getUserRepositories: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  // resolveAttachmentImages (used when rendering markdown) imports this.
  API_REQUEST_TIMEOUT_MS: 30_000,
  ForgejoClient: vi.fn().mockImplementation(function () {
    return {
      getCurrentUser: vi.fn().mockResolvedValue({ login: 'user' }),
      renderMarkdown: vi.fn().mockResolvedValue('<p>hi</p>'),
      getUserRepositories: clientMocks.getUserRepositories,
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
import { logger } from '../../logger';
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
  let disposeListener: (() => void) | undefined;
  let disposed = false;
  const panel = {
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidDispose: (l: () => void) => {
      disposeListener = l;
      return { dispose: vi.fn() };
    },
    webview: {
      html: '',
      cspSource: '',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: (message: unknown) => {
        if (disposed) {
          // What a disposed VS Code WebviewPanel does: posting rejects. A
          // request that settles after the panel closed then becomes an
          // unhandled rejection unless the host checks first.
          throw new Error('Webview is disposed');
        }
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
    dispose: () => {
      disposed = true;
      disposeListener?.();
    },
  };
}

function postedMessages(posted: unknown[]): Array<Record<string, unknown>> {
  return posted as Array<Record<string, unknown>>;
}

/**
 * The import preview's host-side token stash. Read directly: the panel exposes
 * no accessor for it, and whether the plaintext tokens are still held is the
 * observable behavior under test. Takes the panel explicitly because disposal
 * clears `OnboardingWebviewPanel.currentPanel`, and the stash of the disposed
 * panel is exactly what has to be empty.
 */
function pendingImportInstances(panel: OnboardingWebviewPanel): unknown {
  return (panel as unknown as { _pendingImportInstances?: unknown })._pendingImportInstances;
}

async function flushDispatches() {
  // Dispatch is fire-and-forget; let the handler promise chain settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Flush macrotasks until the predicate holds. Flows that cross real `fs`
 * promises (threadpool) need more than a fixed number of ticks, and a tick
 * count that suffices locally still starves on a heavily loaded CI runner:
 * 50 ticks ≈ 90 ms wall-clock, which already caused CI failures in the
 * sibling viewProviderDispatch suite (the atomic-export and startWorkOnIssue
 * tests got no reply within the tick budget there), so the budget is
 * wall-clock, not ticks — identical to that suite's `flushUntil`.
 */
async function flushUntil(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
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
  let readmeProvider: ReadmeContentProvider;

  beforeEach(async () => {
    context = createFakeContext();
    config = new ConfigManager(context as never);
    fake = createFakePanel();
    vi.mocked(clearLinkedRepositoryCache).mockReset();
    clientMocks.getUserRepositories.mockReset();
    clearServerVersions();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fake.panel as never);
    OnboardingWebviewPanel.currentPanel = undefined;
    readmeProvider = new ReadmeContentProvider();
    OnboardingWebviewPanel.createOrShow(context as never, context.extensionUri as never, config, readmeProvider);
    await config.addInstance(testInstance);
  });

  it('keys the README preview document by the instance the request names', async () => {
    // The virtual document URI has to carry the instance id, exactly like the
    // sidebar handler: without it two instances hosting the same owner/repo
    // share (and overwrite) one README document.
    const executeCommand = vi.mocked(vscode.commands.executeCommand);
    executeCommand.mockClear();

    fake.send({
      command: 'previewReadme',
      instanceId: testInstance.id,
      owner: 'owner',
      repo: 'repo',
      content: '# Hello',
    });
    await flushDispatches();

    const call = executeCommand.mock.calls.find(([command]) => command === 'markdown.showPreviewToSide');
    expect(call).toBeDefined();
    expect((call?.[1] as { path?: string } | undefined)?.path).toBe(`${testInstance.id}/owner/repo/README.md`);
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

  it('rejects a non-http(s) connection test before reaching the network', async () => {
    // The wizard tests a webview-supplied URL; without the scheme check a
    // compromised panel could aim the host at `file:`/`data:`/intranet targets.
    const { ForgejoClient } = await import('../../api/client');
    vi.mocked(ForgejoClient).mockClear();

    fake.send({ command: 'testConnection', url: 'file:///etc/passwd', token: 'tok', _requestId: 'req-scheme' });
    await flushDispatches();

    const answer = postedMessages(fake.posted).find((m) => m.command === 'testConnectionResult');
    expect(answer?.success).toBe(false);
    expect(String(answer?.error)).toContain('http');
    expect(vi.mocked(ForgejoClient)).not.toHaveBeenCalled();
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

  it('records the welcome flag when the guide is completed', async () => {
    // Finishing the guide is what stops the automatic reopen on later
    // activations (with zero instances the flag is otherwise never written).
    fake.send({ command: 'closeOnboarding' });
    await flushDispatches();

    expect(context.globalState.get('forgejoToolkit.hasShownWelcome')).toBe(true);
  });

  it('lands on the dashboard when the guide is finished', async () => {
    // The finish button is labelled "Open Dashboard", so closing the panel
    // alone is not enough: focusing the view container only brings back
    // whatever route the sidebar was last on, which after a first run is not
    // the dashboard. `openDashboard` is the two-step the sidebar's own
    // openDashboard() performs (reveal, then post the navigation message).
    const executeCommand = vi.mocked(vscode.commands.executeCommand);
    executeCommand.mockClear();

    fake.send({ command: 'closeOnboarding' });
    await flushDispatches();

    expect(executeCommand).toHaveBeenCalledWith('forgejoToolkit.openDashboard');
    expect(executeCommand).toHaveBeenCalledWith('forgejoToolkitView.focus');
  });

  it('drops the plaintext-token stash when the panel is disposed', async () => {
    // The stash holds the picked file's tokens in the clear, kept host-side so
    // they never cross into the webview. The webview that could still confirm
    // the import is gone once the panel is disposed, so the tokens must not
    // outlive it.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-import-dispose-')), 'export.json');
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
    const panel = OnboardingWebviewPanel.currentPanel as OnboardingWebviewPanel;

    fake.send({ command: 'previewImportInstances' });
    await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'importInstancesPreview'));
    expect(pendingImportInstances(panel)).toBeDefined();

    fake.dispose();

    expect(pendingImportInstances(panel)).toBeUndefined();
  });

  it('refuses a connection test URL that embeds a credential', async () => {
    // The wizard's own save path stores through ConfigManager, which refuses a
    // userinfo URL: answering before the request keeps the user from being told
    // the instance is unreachable when the URL is the problem.
    fake.send({ command: 'testConnection', url: 'https://alice:secret-token@forgejo.example.com', token: 'tok' });
    await flushDispatches();

    const result = postedMessages(fake.posted).find((m) => m.command === 'testConnectionResult');
    expect(result).toMatchObject({ success: false });
    expect(String(result?.error)).toContain('http');
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

  it('answers a saveInstance failure with a status-only message, never the response body', async () => {
    // A 409/422 body is remote-authored content; userFacingErrorMessage would
    // embed it, and it must not be reflected into the webview (the sidebar's
    // saveInstance replies through connectionFailureMessage for the same
    // reason). The log keeps the full message.
    const { ForgejoClient } = await import('../../api/client');
    vi.mocked(ForgejoClient).mockImplementationOnce(function () {
      return {
        getCurrentUser: vi.fn().mockRejectedValue(new Error('Forgejo API error 409: {"message":"remote-authored"}')),
      } as never;
    });
    const loggerError = vi.spyOn(logger, 'error');

    fake.send({ command: 'saveInstance', url: 'https://new.example.com', token: 'tok' });
    await flushDispatches();

    const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
    expect(result).toMatchObject({ success: false });
    expect(String(result?.error)).toContain('rejected the request');
    expect(String(result?.error)).toContain('409');
    expect(String(result?.error)).not.toContain('remote-authored');
    // The log keeps the full message, body included.
    expect(loggerError.mock.calls.map((call) => String(call[0])).join('\n')).toContain('remote-authored');
  });

  it('answers the setup guide getRepositories probe with the repository list', async () => {
    // The guide sends this load right after a save and reads the answer out of
    // its `repos-<id>` slot, which only a `repositories` reply clears. Before
    // the panel handled the command nothing answered it at all (the dispatcher
    // fallback only covers messages carrying a `_requestId`, and this load has
    // none), so the slot stayed busy and the guide reported a successful save
    // for a token that cannot list repositories.
    const repos = [{ id: 1, name: 'repo', full_name: 'owner/repo' }];
    clientMocks.getUserRepositories.mockResolvedValue({ items: repos });

    fake.send({ command: 'getRepositories', instanceId: testInstance.id });
    await flushDispatches();

    const reply = postedMessages(fake.posted).find((m) => m.command === 'repositories');
    expect(reply).toMatchObject({ instanceId: testInstance.id, repositories: repos });
    expect(reply?.error).toBeUndefined();
  });

  it('reports a refused repository list through an error reply, not silence', async () => {
    // A missing `read:repository` scope is exactly what the probe exists to
    // surface; the guide turns the `error` field into its missing-scope
    // message, so it must be present (and must not be swallowed into a
    // requestError the guide does not listen for).
    clientMocks.getUserRepositories.mockRejectedValue(new Error('Permission denied [403]'));

    fake.send({ command: 'getRepositories', instanceId: testInstance.id });
    await flushDispatches();

    const reply = postedMessages(fake.posted).find((m) => m.command === 'repositories');
    expect(reply?.instanceId).toBe(testInstance.id);
    expect(reply?.error).toBe('Permission denied [403]');
    expect(reply?.repositories).toBeUndefined();
    expect(postedMessages(fake.posted).some((m) => m.command === 'requestError')).toBe(false);
  });

  it('echoes the request id on every repositories reply so the guide can attribute it', async () => {
    // The guide names its probe with a `_requestId` (the shared webview sends
    // one for all three list commands). Without the echo the reply can only be
    // matched by arrival order, which is exactly what the id exists to avoid —
    // and the failure branch matters as much as the success one, since a
    // refused probe is the case the guide is built to report.
    fake.send({ command: 'getRepositories', instanceId: testInstance.id, _requestId: 'list-repos-7' });
    await flushDispatches();

    let reply = postedMessages(fake.posted).find((m) => m.command === 'repositories');
    expect(reply?._requestId).toBe('list-repos-7');

    clientMocks.getUserRepositories.mockRejectedValue(new Error('Permission denied [403]'));
    fake.posted.length = 0;
    fake.send({ command: 'getRepositories', instanceId: testInstance.id, _requestId: 'list-repos-8' });
    await flushDispatches();

    reply = postedMessages(fake.posted).find((m) => m.command === 'repositories');
    expect(reply?.error).toBe('Permission denied [403]');
    expect(reply?._requestId).toBe('list-repos-8');

    fake.posted.length = 0;
    fake.send({ command: 'getRepositories', instanceId: 'gone-instance', _requestId: 'list-repos-9' });
    await flushDispatches();

    reply = postedMessages(fake.posted).find((m) => m.command === 'repositories');
    expect(reply?.error).toBe('Instance not found');
    expect(reply?._requestId).toBe('list-repos-9');
  });

  it('answers the probe for an unknown instance so its busy slot cannot stick', async () => {
    // The instance is looked up in the config, so a removed instance (or a
    // stale id) would otherwise return silently and leave the guide spinning.
    fake.send({ command: 'getRepositories', instanceId: 'gone-instance' });
    await flushDispatches();

    const reply = postedMessages(fake.posted).find((m) => m.command === 'repositories');
    expect(reply?.instanceId).toBe('gone-instance');
    expect(reply?.error).toBe('Instance not found');
  });

  it('names the failing instance when an imported entry cannot be saved', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-import-fail-')), 'export.json');
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
    vi.spyOn(config, 'addInstance').mockRejectedValueOnce(new Error('storage is read-only'));

    fake.send({ command: 'importInstances' });
    await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'instancesImported'));

    const reply = postedMessages(fake.posted).find((m) => m.command === 'instancesImported');
    // The setup guide renders this reply's `error`; a bare "failed" would leave
    // the user with nothing to act on. The message comes from l10n.t (so the
    // bundle translates it) and names both the instance and the reason.
    expect(reply?.success).toBe(false);
    expect(reply?.cancelled).toBeUndefined();
    expect(vi.mocked(vscode.l10n.t)).toHaveBeenCalledWith(
      'Importing instance {0} failed: {1}',
      'one',
      'storage is read-only',
    );
    expect(reply?.error).toBe('Importing instance one failed: storage is read-only');
  });

  it('reports the parse failure of a corrupt import file through the same reply', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-import-corrupt-')), 'export.json');
    fs.writeFileSync(file, '{ this is not json');
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file(file)] as never);

    fake.send({ command: 'importInstances' });
    await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'instancesImported'));

    const reply = postedMessages(fake.posted).find((m) => m.command === 'instancesImported');
    expect(reply?.success).toBe(false);
    expect(typeof reply?.error).toBe('string');
    expect(String(reply?.error ?? '').length).toBeGreaterThan(0);
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

  it('treats a dismissed password prompt as a cancel instead of an error', async () => {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const iterations = 1000;
    const key = crypto.pbkdf2Sync('pw', salt, iterations, 32, 'sha256');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(
        JSON.stringify({
          instances: [
            { id: 'imported-1', url: 'https://forgejo.example.com', token: 'file-token-1', name: 'one', username: 'u' },
          ],
        }),
        'utf8',
      ),
      cipher.final(),
    ]);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-import-enc-')), 'export.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        encrypted: true,
        iterations,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        data: encrypted.toString('base64'),
      }),
    );
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file(file)] as never);
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined as never);

    fake.send({ command: 'previewImportInstances' });
    await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'importInstancesPreview'));

    const preview = postedMessages(fake.posted).find((m) => m.command === 'importInstancesPreview');
    expect(preview).toMatchObject({ cancelled: true, instances: [] });
    expect(preview?.error).toBeUndefined();
  });

  it('carries the dropped-entry count the preview has to warn about', async () => {
    // Two usable entries and three unusable ones (missing fields, a non-object
    // entry, a wrongly typed field). The dropped entries never reach
    // `instances`, so the count is the only signal that the file held more.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-import-dropped-')), 'export.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        instances: [
          { id: 'imported-1', url: 'https://forgejo.example.com', token: 't1', name: 'one', username: 'u' },
          { id: 'imported-2', url: 'https://other.example.com', token: 't2', name: 'two', username: 'u' },
          { id: 'broken' },
          'not-an-object',
          { id: 'imported-3', url: 42, token: 't3', name: 'three', username: 'u' },
        ],
      }),
    );
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file(file)] as never);

    fake.send({ command: 'previewImportInstances' });
    await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'importInstancesPreview'));

    const preview = postedMessages(fake.posted).find((m) => m.command === 'importInstancesPreview');
    expect(preview?.dropped).toBe(3);
    expect(preview?.instances).toHaveLength(2);
  });

  it('omits the dropped count when the file used every entry', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-import-complete-')), 'export.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        instances: [{ id: 'imported-1', url: 'https://forgejo.example.com', token: 't1', name: 'one', username: 'u' }],
      }),
    );
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file(file)] as never);

    fake.send({ command: 'previewImportInstances' });
    await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'importInstancesPreview'));

    const preview = postedMessages(fake.posted).find((m) => m.command === 'importInstancesPreview');
    expect(preview?.dropped).toBeUndefined();
  });

  it('localizes the rejected testConnection payload', async () => {
    // Clear first: evaluating `vscode.l10n.t(...)` inside an assertion would
    // register the very call being looked for (the mock returns the key text).
    vi.mocked(vscode.l10n.t).mockClear();
    fake.send({ command: 'testConnection', url: 42, token: 'tok' });
    await flushDispatches();

    const result = postedMessages(fake.posted).find((m) => m.command === 'testConnectionResult');
    expect(result).toMatchObject({ success: false, error: 'Invalid input' });
    expect(vi.mocked(vscode.l10n.t)).toHaveBeenCalledWith('Invalid input');
  });

  it('localizes the rejected saveInstance payload', async () => {
    vi.mocked(vscode.l10n.t).mockClear();
    fake.send({ command: 'saveInstance', url: 42, token: 'tok' });
    await flushDispatches();

    const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
    expect(result).toMatchObject({ success: false, error: 'Invalid input' });
    expect(vi.mocked(vscode.l10n.t)).toHaveBeenCalledWith('Invalid input');
  });

  it('refuses a saveInstance URL that embeds a credential before testing it', async () => {
    // The wizard's save stores through ConfigManager, which refuses a userinfo
    // URL (fetch cannot even request one). Connection-testing it first answered
    // "Cannot connect to the instance…" and named the instance instead of the
    // URL, exactly the misdirection the sidebar's own save refusal avoids.
    const { ForgejoClient } = await import('../../api/client');
    vi.mocked(ForgejoClient).mockClear();
    const addInstance = vi.spyOn(config, 'addInstance');

    fake.send({
      command: 'saveInstance',
      url: 'https://alice:secret-token@forgejo.example.com',
      token: 'tok',
      _requestId: 'req-userinfo-save',
    });
    await flushDispatches();

    const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
    expect(result).toMatchObject({ success: false });
    expect(String(result?.error)).toContain('http');
    expect(String(result?.error)).not.toContain('alice');
    expect(vi.mocked(ForgejoClient)).not.toHaveBeenCalled();
    expect(addInstance).not.toHaveBeenCalled();
  });

  it('redacts a credential-carrying URL before logging it', async () => {
    // The URL comes from the (untrusted) webview and can embed a token as
    // userinfo; the sidebar redacts the same two log lines. The scheme refusal
    // and the openExternal failure both have to log the redacted form.
    const loggerError = vi.spyOn(logger, 'error');
    const openExternal = vi.mocked(vscode.env.openExternal);
    openExternal.mockRejectedValueOnce(new Error('no handler'));

    fake.send({ command: 'openExternal', url: 'data:text/html,<b>x</b>' });
    await flushDispatches();

    fake.send({
      command: 'openExternal',
      url: 'https://alice:secret-token@forgejo.example.com/page',
    });
    await flushDispatches();

    const logged = loggerError.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('forgejo.example.com');
    expect(logged).not.toContain('secret-token');
    // The failing-open line really ran: the block line alone would not prove the
    // failure path is redacted too.
    expect(logged).toContain('openExternal failed');
  });

  it('drops a reply once the panel is disposed instead of rejecting', async () => {
    // The user closes the wizard while a request is still awaiting the network:
    // without a guard, `_reply` posts to the disposed webview and the rejection
    // is unhandled — the dispatch wrapper's catch has already returned.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    // The list is deferred so the handler is still mid-request when the panel
    // is disposed.
    let resolveRepos!: (value: unknown) => void;
    clientMocks.getUserRepositories.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRepos = resolve;
        }),
    );

    fake.send({ command: 'getRepositories', instanceId: testInstance.id });
    await flushDispatches();

    fake.dispose();

    resolveRepos({ items: [] });
    await flushDispatches();
    await flushDispatches();

    process.off('unhandledRejection', onRejection);
    expect(rejections).toEqual([]);
    expect(postedMessages(fake.posted).some((m) => m.command === 'repositories')).toBe(false);
  });
});
