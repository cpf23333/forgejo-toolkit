import { vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(),
      update: vi.fn(),
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
  },
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
