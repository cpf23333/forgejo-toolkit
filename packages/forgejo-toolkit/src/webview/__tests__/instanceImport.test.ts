import { describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  computeImportTokenConflicts,
  computeTokenConflicts,
  decryptExportData,
  ImportCancelledError,
  isSameOriginUrl,
  MAX_IMPORT_PBKDF2_ITERATIONS,
  readExportDataFromUri,
  sanitizeImportedInstances,
  sanitizeImportedSettings,
  stripInstanceTokens,
} from '../instanceImport';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

function instance(id: string, token: string): ForgejoInstance {
  return { id, token, url: 'https://forgejo.example.com', name: id, username: 'user' };
}

describe('computeTokenConflicts', () => {
  it('flags an imported token that belongs to a different stored instance', () => {
    const imported = [instance('new-1', 'tok-a')];
    const existing = [instance('old-1', 'tok-a')];
    expect(computeTokenConflicts(imported, existing)).toEqual([true]);
  });

  it('does not flag re-importing the unchanged token over its own instance', () => {
    const imported = [instance('inst-1', 'tok-a')];
    const existing = [instance('inst-1', 'tok-a'), instance('inst-2', 'tok-a')];
    expect(computeTokenConflicts(imported, existing)).toEqual([false]);
  });

  it('flags a changed token that collides with another stored instance', () => {
    const imported = [instance('inst-1', 'tok-b')];
    const existing = [instance('inst-1', 'tok-a'), instance('inst-2', 'tok-b')];
    expect(computeTokenConflicts(imported, existing)).toEqual([true]);
  });

  it('does not flag tokens unknown to the stored instances', () => {
    const imported = [instance('new-1', 'tok-x'), instance('new-2', 'tok-y')];
    const existing = [instance('old-1', 'tok-a')];
    expect(computeTokenConflicts(imported, existing)).toEqual([false, false]);
  });

  it('treats empty tokens like any other string (matches the previous webview behavior)', () => {
    const imported = [instance('new-1', '')];
    const existing = [instance('old-1', '')];
    expect(computeTokenConflicts(imported, existing)).toEqual([true]);
    expect(computeTokenConflicts([instance('old-1', '')], existing)).toEqual([false]);
  });
});

describe('computeImportTokenConflicts', () => {
  it('flags tokens duplicated within the file even without stored instances', () => {
    const imported = [instance('new-1', 'tok-a'), instance('new-2', 'tok-a'), instance('new-3', 'tok-b')];
    expect(computeImportTokenConflicts(imported, [])).toEqual([true, true, false]);
  });

  it('flags duplicates of an empty token like the old webview check did', () => {
    const imported = [instance('new-1', ''), instance('new-2', '')];
    expect(computeImportTokenConflicts(imported, [])).toEqual([true, true]);
  });

  it('ORs in-file duplicates with stored-instance conflicts', () => {
    const imported = [instance('new-1', 'tok-a'), instance('new-2', 'tok-a'), instance('new-3', 'tok-c')];
    const existing = [instance('old-1', 'tok-c')];
    expect(computeImportTokenConflicts(imported, existing)).toEqual([true, true, true]);
  });
});

describe('stripInstanceTokens', () => {
  it('blanks tokens while keeping every other field intact', () => {
    const imported: ForgejoInstance[] = [
      { ...instance('a', 'tok-a'), syncApiUrlsToInstanceUrl: true },
      instance('b', 'tok-b'),
    ];
    const stripped = stripInstanceTokens(imported);
    expect(stripped[0]).toEqual({ ...imported[0], token: '' });
    expect(stripped[1]).toEqual({ ...imported[1], token: '' });
    // The stash keeps the real tokens; stripping must not mutate it.
    expect(imported[0].token).toBe('tok-a');
  });
});

describe('isSameOriginUrl', () => {
  it('treats different paths on one host as the same origin', () => {
    expect(isSameOriginUrl('https://forgejo.example.com', 'https://forgejo.example.com/a/b')).toBe(true);
  });

  it('separates hosts, ports and schemes', () => {
    expect(isSameOriginUrl('https://forgejo.example.com', 'https://evil.example')).toBe(false);
    expect(isSameOriginUrl('https://forgejo.example.com', 'https://forgejo.example.com:8443')).toBe(false);
    expect(isSameOriginUrl('https://forgejo.example.com', 'http://forgejo.example.com')).toBe(false);
  });

  it('fails closed on an unparseable URL on either side', () => {
    expect(isSameOriginUrl('not a url', 'https://forgejo.example.com')).toBe(false);
    expect(isSameOriginUrl('https://forgejo.example.com', 'not a url')).toBe(false);
  });
});

function encryptPayload(data: unknown, password: string, iterations = 1000) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return {
    iterations,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  };
}

describe('decryptExportData iteration count guard', () => {
  it('round-trips a payload with an in-range iteration count', () => {
    const payload = encryptPayload({ instances: [] }, 'pw', 1000);
    expect(decryptExportData(payload, 'pw')).toEqual({ instances: [] });
  });

  it.each([0, -1, 1.5, MAX_IMPORT_PBKDF2_ITERATIONS + 1])('rejects the iteration count %s', (iterations) => {
    const payload = { ...encryptPayload({}, 'pw'), iterations };
    expect(() => decryptExportData(payload, 'pw')).toThrow(RangeError);
  });
});

function writeExportFile(payload: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-import-'));
  const file = path.join(dir, 'export.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

describe('readExportDataFromUri', () => {
  it('reads a plain export file', async () => {
    const file = writeExportFile({
      version: 1,
      instances: [{ id: 'inst-1', url: 'https://forgejo.example.com', token: 'tok', name: 'one', username: 'user' }],
    });

    await expect(readExportDataFromUri(vscode.Uri.file(file))).resolves.toEqual({
      instances: [{ id: 'inst-1', url: 'https://forgejo.example.com', token: 'tok', name: 'one', username: 'user' }],
      settings: undefined,
    });
  });

  it('treats a dismissed password prompt as a cancellation, not a failure', async () => {
    const file = writeExportFile({
      encrypted: true,
      ...encryptPayload({ instances: [instance('inst-1', 'tok')] }, 'pw'),
    });
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined as never);

    await expect(readExportDataFromUri(vscode.Uri.file(file))).rejects.toBeInstanceOf(ImportCancelledError);
  });

  it.each([undefined, ''])('treats the password prompt value %s as a cancellation', async (password) => {
    const file = writeExportFile({
      encrypted: true,
      ...encryptPayload({ instances: [instance('inst-1', 'tok')] }, 'pw'),
    });
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(password as never);

    await expect(readExportDataFromUri(vscode.Uri.file(file))).rejects.toBeInstanceOf(ImportCancelledError);
  });

  it('decrypts the file when a password is provided', async () => {
    const file = writeExportFile({
      encrypted: true,
      ...encryptPayload({ instances: [instance('inst-1', 'tok')] }, 'pw'),
    });
    vi.mocked(vscode.window.showInputBox).mockResolvedValue('pw' as never);

    const data = await readExportDataFromUri(vscode.Uri.file(file));
    expect(data.instances).toHaveLength(1);
    expect(data.instances[0].token).toBe('tok');
  });

  it('drops unshipped settings values so the preview cannot render a raw i18n key', async () => {
    const file = writeExportFile({
      version: 2,
      instances: [{ id: 'inst-1', url: 'https://forgejo.example.com', token: 'tok', name: 'one', username: 'user' }],
      settings: { locale: 'ja', debug: false, worktreeOpenMode: 'newWindow' },
    });

    const data = await readExportDataFromUri(vscode.Uri.file(file));
    expect(data.settings).toEqual({ debug: false, worktreeOpenMode: 'newWindow' });
  });

  it('localizes the empty-file failure instead of leaking a raw English literal', async () => {
    const file = writeExportFile({ version: 1, instances: [] });

    await expect(readExportDataFromUri(vscode.Uri.file(file))).rejects.toThrow('No valid instances found in file');
    // The message goes through l10n.t, so the bundle provides the translation.
    expect(vi.mocked(vscode.l10n.t)).toHaveBeenCalledWith('No valid instances found in file');
  });

  it('rejects a file that is not valid JSON instead of previewing an empty import', async () => {
    // A truncated/corrupt export (e.g. an interrupted download) must surface as
    // an error in the preview; resolving with `instances: []` would render an
    // empty list and look like a file that simply holds nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-import-'));
    const file = path.join(dir, 'export.json');
    fs.writeFileSync(file, '{ "version": 1, "instances": [');

    await expect(readExportDataFromUri(vscode.Uri.file(file))).rejects.toThrow(SyntaxError);
  });
});

describe('sanitizeImportedInstances', () => {
  it('keeps valid entries and rebuilds them with only the known fields', () => {
    const { valid, dropped } = sanitizeImportedInstances([
      { id: 'a', url: 'https://forgejo.example.com', token: 't', name: 'n', username: 'u', extra: 'dropped' },
    ]);
    expect(dropped).toBe(0);
    expect(valid).toEqual([{ id: 'a', url: 'https://forgejo.example.com', token: 't', name: 'n', username: 'u' }]);
    expect('extra' in valid[0]).toBe(false);
  });

  it('preserves syncApiUrlsToInstanceUrl when it is a boolean', () => {
    const { valid } = sanitizeImportedInstances([
      { id: 'a', url: 'u', token: 't', name: 'n', username: 'u', syncApiUrlsToInstanceUrl: true },
      { id: 'b', url: 'u', token: 't', name: 'n', username: 'u', syncApiUrlsToInstanceUrl: false },
    ]);
    expect(valid[0].syncApiUrlsToInstanceUrl).toBe(true);
    expect(valid[1].syncApiUrlsToInstanceUrl).toBe(false);
  });

  it('drops a non-boolean syncApiUrlsToInstanceUrl instead of trusting it', () => {
    const { valid } = sanitizeImportedInstances([
      { id: 'a', url: 'u', token: 't', name: 'n', username: 'u', syncApiUrlsToInstanceUrl: 'yes' },
    ]);
    expect('syncApiUrlsToInstanceUrl' in valid[0]).toBe(false);
  });

  it('drops entries missing required string fields and counts them', () => {
    const { valid, dropped } = sanitizeImportedInstances([
      { id: 'a', url: 'u', token: 't', name: 'n', username: 'u' },
      { id: 'b', url: 'u', token: 't', name: 'n' }, // missing username
      { url: 'u', token: 't', name: 'n', username: 'u' }, // missing id
      null,
      'not-an-object',
      { id: 1, url: 'u', token: 't', name: 'n', username: 'u' }, // non-string id
    ]);
    expect(valid).toHaveLength(1);
    expect(valid[0].id).toBe('a');
    expect(dropped).toBe(5);
  });
});

describe('sanitizeImportedSettings', () => {
  it('keeps only the fields the extension can apply', () => {
    expect(
      sanitizeImportedSettings({
        locale: 'zh',
        debug: true,
        worktreeOpenMode: 'newWindow',
        worktreeCacheDirectory: '/tmp/worktrees',
        unknown: 'dropped',
      }),
    ).toEqual({
      locale: 'zh',
      debug: true,
      worktreeOpenMode: 'newWindow',
      worktreeCacheDirectory: '/tmp/worktrees',
    });
  });

  // The preview renders `locales.<value>`; an unshipped locale would show the
  // raw key instead of a language name.
  it('drops an unshipped locale instead of forwarding it to the preview', () => {
    expect(sanitizeImportedSettings({ locale: 'ja', debug: false })).toEqual({ debug: false });
    expect(sanitizeImportedSettings({ locale: 'ZH' })).toBeUndefined();
  });

  it('drops wrongly typed fields rather than guessing', () => {
    expect(sanitizeImportedSettings({ debug: 'true', worktreeOpenMode: 'reuse' })).toBeUndefined();
    expect(sanitizeImportedSettings({ worktreeCacheDirectory: 42 })).toBeUndefined();
  });

  it('returns undefined for a settings block that is missing or not an object', () => {
    expect(sanitizeImportedSettings(undefined)).toBeUndefined();
    expect(sanitizeImportedSettings(null)).toBeUndefined();
    expect(sanitizeImportedSettings(['en'])).toBeUndefined();
    expect(sanitizeImportedSettings('en')).toBeUndefined();
    expect(sanitizeImportedSettings({})).toBeUndefined();
  });
});
