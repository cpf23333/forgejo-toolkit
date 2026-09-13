import { describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import {
  computeTokenConflicts,
  decryptExportData,
  MAX_IMPORT_PBKDF2_ITERATIONS,
  sanitizeImportedInstances,
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
