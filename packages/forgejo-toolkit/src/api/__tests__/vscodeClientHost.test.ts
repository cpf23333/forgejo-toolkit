import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { createVscodeClientHost } from '../vscodeClientHost';
import { Logger } from '../../logger';

/**
 * The token-settings action of the auth toasts is the one `openExternal` site
 * that builds its URL from stored data instead of from a literal, so it needs
 * the scheme allowlist the other three sites apply.
 */
describe('createVscodeClientHost openExternal scheme guard', () => {
  beforeEach(() => {
    vi.mocked(vscode.env.openExternal).mockClear();
    vi.mocked(vscode.window.showErrorMessage)
      .mockReset()
      .mockResolvedValue('Open Token Settings' as never);
  });

  afterEach(() => {
    vi.mocked(vscode.env.openExternal).mockClear();
  });

  it('opens the instance token settings page for an http(s) instance URL', async () => {
    const host = createVscodeClientHost();

    host.notifyInvalidCredentials('https://auth-open.example.com');
    // The button handler runs in a .then callback; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
    const uri = vi.mocked(vscode.env.openExternal).mock.calls[0][0] as unknown as { fsPath: string };
    expect(uri.fsPath).toBe('https://auth-open.example.com/user/settings/applications');
  });

  it('does not hand a non-http(s) instance URL to the operating system', async () => {
    const logger = new Logger();
    const errorSpy = vi.spyOn(logger, 'error');
    const host = createVscodeClientHost(logger);

    // Such a URL can only be stored data (an older build, or a hand-edited
    // store): nothing that reaches the OS may leave the http(s) schemes.
    host.notifyInvalidCredentials('file:///etc/passwd');
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.notifyInsufficientScope('data:text/html,<b>hi</b>', { body: 'nope' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(vscode.env.openExternal).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('non-http(s)'));
  });
});
