import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { createVscodeClientHost, permissionErrorKey, resetShownPermissionErrors } from '../vscodeClientHost';
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

describe('createVscodeClientHost permission toast dedupe', () => {
  beforeEach(() => {
    resetShownPermissionErrors();
    vi.mocked(vscode.window.showErrorMessage)
      .mockReset()
      .mockResolvedValue(undefined as never);
  });

  it('re-arms the toast when the credential in the instance URL changes', () => {
    const host = createVscodeClientHost();

    // The user's first token is dead. Then they paste a second bad one: every
    // request still 401s, and the actionable toast has to be able to come back,
    // or the user is left with a silent failure and no way to reach the token
    // settings.
    host.notifyInvalidCredentials('https://alice:first-bad-token@forgejo.example.com');
    host.notifyInvalidCredentials('https://alice:first-bad-token@forgejo.example.com');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);

    host.notifyInvalidCredentials('https://alice:second-bad-token@forgejo.example.com');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps the same credential quiet, so a poller cannot re-toast every request', () => {
    const host = createVscodeClientHost();

    for (let index = 0; index < 5; index += 1) {
      host.notifyInvalidCredentials('https://forgejo.example.com');
    }

    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
  });

  it('re-arms the toast when the client fingerprint of a SecretStorage token rotates', () => {
    const host = createVscodeClientHost();

    // A normal instance keeps its token in SecretStorage and its URL therefore
    // carries no credential: the URL cannot tell two tokens apart, so the client
    // passes a fingerprint of the credential it actually sent. Rotating the
    // token must re-arm the toast, or the user who just pasted a new (still
    // rejected) token gets silence for the rest of the session.
    host.notifyInvalidCredentials('https://forgejo.example.com', 'a1b2c3d4e5f60718-12');
    host.notifyInvalidCredentials('https://forgejo.example.com', 'a1b2c3d4e5f60718-12');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);

    host.notifyInvalidCredentials('https://forgejo.example.com', 'ffeeddccbbaa9988-13');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps an unchanged client fingerprint quiet, so a poller cannot re-toast', () => {
    const host = createVscodeClientHost();

    for (let index = 0; index < 5; index += 1) {
      host.notifyInvalidCredentials('https://forgejo.example.com', 'a1b2c3d4e5f60718-12');
    }

    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps the URL-credential behaviour for a caller that passes no fingerprint', () => {
    // An older caller (or one that has no credential to fingerprint) still gets
    // the dedupe the URL alone could provide: same URL, one toast; a different
    // URL credential, a new toast.
    const host = createVscodeClientHost();

    host.notifyInvalidCredentials('https://legacy-caller.example.com');
    host.notifyInvalidCredentials('https://legacy-caller.example.com');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);

    host.notifyInvalidCredentials('https://alice:second-bad-token@legacy-caller.example.com');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(2);
  });

  it('re-arms the scope toast when the client fingerprint of the token rotates', () => {
    const host = createVscodeClientHost();

    // The 403 branch has the same defect as the 401 one: its key folds in the
    // reason (the error body) and the credential, and with a SecretStorage token
    // a rotated token is only visible through the client's fingerprint.
    host.notifyInsufficientScope('https://forgejo.example.com', { body: 'missing write:issue' }, 'a1b2c3d4e5f60718-12');
    host.notifyInsufficientScope('https://forgejo.example.com', { body: 'missing write:issue' }, 'a1b2c3d4e5f60718-12');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);

    host.notifyInsufficientScope('https://forgejo.example.com', { body: 'missing write:issue' }, 'ffeeddccbbaa9988-13');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(2);
  });

  it('re-arms a scope toast when the reported reason or the credential changes', () => {
    const host = createVscodeClientHost();

    host.notifyInsufficientScope('https://alice:bad-token@forgejo.example.com', { body: 'missing write:issue' });
    host.notifyInsufficientScope('https://alice:bad-token@forgejo.example.com', { body: 'missing write:issue' });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);

    host.notifyInsufficientScope('https://alice:bad-token@forgejo.example.com', { body: 'missing read:user' });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(2);

    host.notifyInsufficientScope('https://alice:other-bad-token@forgejo.example.com', {
      body: 'missing read:user',
    });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(3);
  });

  it('is not a 401-only dedupe: a 401 and a scope failure on one URL both show', () => {
    const host = createVscodeClientHost();

    host.notifyInvalidCredentials('https://forgejo.example.com');
    host.notifyInsufficientScope('https://forgejo.example.com', { body: 'missing write:issue' });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(2);
  });
});

describe('permissionErrorKey', () => {
  it('is stable for an unchanged credential and different for a changed one', () => {
    const key = (credential: string) => permissionErrorKey('https://forgejo.example.com/', '401', credential);

    expect(key('bad-token')).toBe(key('bad-token'));
    expect(key('bad-token')).not.toBe(key('other-bad-token'));
    expect(key('')).not.toBe(key('bad-token'));
  });

  it('separates two reasons for one URL', () => {
    expect(permissionErrorKey('https://forgejo.example.com/', '401', 't')).not.toBe(
      permissionErrorKey('https://forgejo.example.com/', 'missing write:issue', 't'),
    );
  });

  it('never contains the credential itself', () => {
    // The key is process-local, but a key that carried the token would be one
    // `logger.debug` away from the output channel.
    expect(permissionErrorKey('https://forgejo.example.com/', '401', 'secret-token')).not.toContain('secret-token');
  });

  it('folds the client fingerprint in, so a rotation changes the key', () => {
    const key = (fingerprint: string) => permissionErrorKey('https://forgejo.example.com/', '401', '', fingerprint);

    expect(key('a1b2c3d4e5f60718-12')).toBe(key('a1b2c3d4e5f60718-12'));
    expect(key('a1b2c3d4e5f60718-12')).not.toBe(key('ffeeddccbbaa9988-13'));
    // No fingerprint (an older caller) is its own state, not the same as any
    // fingerprint the client could send.
    expect(permissionErrorKey('https://forgejo.example.com/', '401', '')).not.toBe(key('a1b2c3d4e5f60718-12'));
  });
});

describe('createVscodeClientHost openExternal failure reporting', () => {
  beforeEach(() => {
    resetShownPermissionErrors();
    vi.mocked(vscode.env.openExternal)
      .mockReset()
      .mockResolvedValue(true as never);
    vi.mocked(vscode.window.showErrorMessage)
      .mockReset()
      .mockResolvedValue('Open Token Settings' as never);
  });

  afterEach(() => {
    vi.mocked(vscode.env.openExternal)
      .mockReset()
      .mockResolvedValue(true as never);
  });

  it('logs a rejection of openExternal instead of swallowing it', async () => {
    const logger = new Logger();
    const errorSpy = vi.spyOn(logger, 'error');
    vi.mocked(vscode.env.openExternal).mockRejectedValue(new Error('no browser'));
    const host = createVscodeClientHost(logger);

    host.notifyInvalidCredentials('https://auth-fail.example.com');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no browser'));
  });

  it('logs a false result from openExternal, which is otherwise a silent no-op', async () => {
    const logger = new Logger();
    const errorSpy = vi.spyOn(logger, 'error');
    vi.mocked(vscode.env.openExternal).mockResolvedValue(false as never);
    const host = createVscodeClientHost(logger);

    host.notifyInvalidCredentials('https://auth-false.example.com');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('reported failure'));
  });

  it('opens a token settings URL without the instance URL credentials', async () => {
    // The URL goes to an external browser: the configured credential must not
    // be part of it, and the masked form would not resolve either.
    const host = createVscodeClientHost();

    host.notifyInvalidCredentials('https://alice:secret-token@forgejo.example.com');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const uri = vi.mocked(vscode.env.openExternal).mock.calls[0][0] as unknown as { fsPath: string };
    expect(uri.fsPath).toBe('https://forgejo.example.com/user/settings/applications');
    expect(uri.fsPath).not.toContain('secret-token');
    expect(uri.fsPath).not.toContain('***');
  });
});
