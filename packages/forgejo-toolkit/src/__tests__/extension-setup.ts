import { vi } from 'vitest';
import { setForgejoClientHost } from '../api/clientHost';
import { createVscodeClientHost } from '../api/vscodeClientHost';

// The client is host-agnostic; tests exercise the extension-host behavior
// (auth error toasts) through the vscode-backed host hooks.
setForgejoClientHost(createVscodeClientHost());

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(async (_message: unknown, ...args: unknown[]) => {
      // Modal confirmations default to "accepted": resolve with the first
      // action button (string argument after the message/options), so tests
      // exercise the confirm path unless they explicitly override the mock.
      return args.find((arg) => typeof arg === 'string');
    }),
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
    withProgress: vi.fn((_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
      task({ report: vi.fn() }, {}),
    ),
    createWebviewPanel: vi.fn(),
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    createStatusBarItem: vi.fn(() => ({
      text: '',
      tooltip: undefined,
      command: undefined,
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    })),
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
    // The polling lease reads the window's own focus state and subscribes to
    // its changes (`vscode.window.state.focused` /
    // `onDidChangeWindowState`); the real extension host always has both.
    state: { focused: true },
    onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(),
      update: vi.fn(),
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
    createFileSystemWatcher: vi.fn(() => ({
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
      onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
      dispose: vi.fn(),
    })),
    workspaceFolders: [],
  },
  commands: {
    executeCommand: vi.fn(() => Promise.resolve(undefined)),
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  ViewColumn: { Active: -1, Beside: 2, One: 1, Two: 2 },
  // Used by the lease's one-time notice, which turns the setting off where it
  // can actually take effect: workspace scope in a window with a folder (a
  // workspace value beats a user value), user scope otherwise.
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  version: '1.99.0',
  RelativePattern: vi.fn().mockImplementation(function (base: unknown, pattern: unknown) {
    return { base, pattern };
  }),
  Uri: {
    file: vi.fn((path: string) => ({ fsPath: path, scheme: 'file' })),
    joinPath: vi.fn((...args: unknown[]) => ({ fsPath: args.join('/') })),
    parse: vi.fn((url: string) => {
      const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
      return { fsPath: url, scheme: match?.[1] ?? '' };
    }),
    from: vi.fn((components: { scheme: string; path: string; query?: string }) => ({
      scheme: components.scheme,
      path: components.path,
      query: components.query,
      fsPath: components.path,
      toString: () => `${components.scheme}://${components.path}`,
    })),
  },
  env: {
    language: 'en',
    // Both are read by the polling diagnostics payload (§11.1 stage 2).
    sessionId: 'test-session',
    remoteName: undefined,
    openExternal: vi.fn(async () => true),
    clipboard: { writeText: vi.fn(async () => undefined) },
  },
  extensions: {
    getExtension: vi.fn(),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
  },
  l10n: {
    // Real `vscode.l10n.t` substitutes positional placeholders (`{0}`, `{1}`, …)
    // or, when given a single object, named ones (`{name}`); it leaves a
    // placeholder it has no value for. The mock used to append its arguments
    // after the message instead, so a message that legitimately names its
    // arguments rendered as "<literal> <args joined>" in every test — an
    // assertion on the rendered text then tested the mock rather than the
    // product (the 404 messages in api/errors-core.ts are the visible case).
    t: vi.fn((message: string, ...args: unknown[]) => {
      const [first] = args;
      const named =
        args.length === 1 && typeof first === 'object' && first !== null && !Array.isArray(first)
          ? (first as Record<string, unknown>)
          : undefined;
      return message.replace(/\{([^{}]+)\}/g, (placeholder, key: string) => {
        const value = named ? named[key] : args[Number(key)];
        return value === undefined ? placeholder : String(value);
      });
    }),
  },
  EventEmitter: vi.fn().mockImplementation(function () {
    return {
      event: vi.fn(),
      fire: vi.fn(),
      dispose: vi.fn(),
    };
  }),
  Disposable: {
    from: vi.fn(),
  },
  FileSystemError: {
    // Real instances carry a `code`; tests assert on the code so a provider
    // cannot silently downgrade "unavailable" into "not found".
    FileNotFound: (uri?: unknown) => Object.assign(new Error(`FileNotFound: ${String(uri)}`), { code: 'FileNotFound' }),
    Unavailable: (message?: unknown) => Object.assign(new Error(String(message)), { code: 'Unavailable' }),
    NoPermissions: () => Object.assign(new Error('NoPermissions'), { code: 'NoPermissions' }),
  },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
}));
