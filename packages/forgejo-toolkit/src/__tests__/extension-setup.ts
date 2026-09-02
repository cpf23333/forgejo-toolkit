import { vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
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
  ViewColumn: { Active: -1, Beside: 2, One: 1, Two: 2 },
  version: '1.99.0',
  RelativePattern: vi.fn().mockImplementation((base: unknown, pattern: unknown) => ({ base, pattern })),
  Uri: {
    file: vi.fn((path: string) => ({ fsPath: path })),
    joinPath: vi.fn((...args: unknown[]) => ({ fsPath: args.join('/') })),
    parse: vi.fn((url: string) => ({ fsPath: url })),
  },
  env: {
    language: 'en',
  },
  l10n: {
    t: vi.fn((message: string, ...args: unknown[]) => {
      return args.length > 0 ? `${message} ${args.join(' ')}` : message;
    }),
  },
  EventEmitter: vi.fn().mockImplementation(() => ({
    event: vi.fn(),
    fire: vi.fn(),
  })),
  Disposable: {
    from: vi.fn(),
  },
}));
