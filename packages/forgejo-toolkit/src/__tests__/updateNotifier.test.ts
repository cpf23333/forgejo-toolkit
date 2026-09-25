import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { watchForExtensionUpdate } from '../updateNotifier';

// Drives the vscode mock's extensions.onDidChange listener and getExtension
// view to simulate an update landing under a running window.

type ChangeListener = () => void;

function captureListener(): ChangeListener {
  const calls = vi.mocked(vscode.extensions.onDidChange).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as unknown as ChangeListener;
}

function fakeContext(version = '0.0.1') {
  return {
    extension: { id: 'cpf23333.forgejo-toolkit', packageJSON: { version } },
    subscriptions: [] as Array<{ dispose(): void }>,
  };
}

const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), isDebugEnabled: () => false };

describe('watchForExtensionUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prompts for a reload when the installed version differs from the running one', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue('Reload' as never);
    vi.mocked(vscode.extensions.getExtension).mockReturnValue({
      packageJSON: { version: '0.0.2' },
    } as never);
    watchForExtensionUpdate(fakeContext('0.0.1') as never, logger as never);

    captureListener()();
    await vi.waitFor(() =>
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.reloadWindow'),
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('0.0.2'), 'Reload');
  });

  it('stays quiet when the registry still reports the running version (enable/disable noise)', () => {
    vi.mocked(vscode.extensions.getExtension).mockReturnValue({
      packageJSON: { version: '0.0.1' },
    } as never);
    watchForExtensionUpdate(fakeContext('0.0.1') as never, logger as never);

    captureListener()();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('stays quiet when the extension is gone from the registry', () => {
    vi.mocked(vscode.extensions.getExtension).mockReturnValue(undefined as never);
    watchForExtensionUpdate(fakeContext('0.0.1') as never, logger as never);

    captureListener()();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does not reload when the prompt is dismissed', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);
    vi.mocked(vscode.extensions.getExtension).mockReturnValue({
      packageJSON: { version: '0.0.2' },
    } as never);
    watchForExtensionUpdate(fakeContext('0.0.1') as never, logger as never);

    captureListener()();
    await vi.waitFor(() => expect(vscode.window.showInformationMessage).toHaveBeenCalled());
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});
