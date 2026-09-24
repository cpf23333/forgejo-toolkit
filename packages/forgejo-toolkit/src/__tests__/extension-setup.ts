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
    openExternal: vi.fn(async () => true),
    clipboard: { writeText: vi.fn(async () => undefined) },
  },
  extensions: {
    getExtension: vi.fn(),
  },
  l10n: {
    t: vi.fn((message: string, ...args: unknown[]) => {
      return args.length > 0 ? `${message} ${args.join(' ')}` : message;
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
