import { vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showOpenDialog: vi.fn(),
    showQuickPick: vi.fn(),
    withProgress: vi.fn((_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
      task({ report: vi.fn() }, {}),
    ),
    createWebviewPanel: vi.fn(),
    activeTextEditor: undefined,
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
    executeCommand: vi.fn(),
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
    from: vi.fn((components: { scheme: string; path: string }) => ({
      scheme: components.scheme,
      path: components.path,
      fsPath: components.path,
      toString: () => `${components.scheme}://${components.path}`,
    })),
  },
  env: {
    language: 'en',
    openExternal: vi.fn(async () => true),
    clipboard: { writeText: vi.fn(async () => undefined) },
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
}));
