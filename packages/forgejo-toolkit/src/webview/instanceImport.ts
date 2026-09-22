import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { ExportSettings, ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

export const MAX_IMPORT_PBKDF2_ITERATIONS = 1_000_000;

export function decryptExportData(
  payload: { salt: string; iv: string; authTag: string; data: string; iterations?: number },
  password: string,
): unknown {
  const iterations = payload.iterations ?? 100_000;
  // The count comes from the import file; reject hostile or corrupt values
  // instead of feeding them to pbkdf2Sync (a huge count would hang the host).
  // RangeError lets readExportDataFromUri tell this apart from a wrong password.
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_IMPORT_PBKDF2_ITERATIONS) {
    throw new RangeError(vscode.l10n.t('The export file uses an unsupported key-derivation iteration count'));
  }
  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const authTag = Buffer.from(payload.authTag, 'base64');
  const encrypted = Buffer.from(payload.data, 'base64');
  const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

export interface ExportData {
  instances: ForgejoInstance[];
  settings?: ExportSettings;
}

/**
 * True when both URLs resolve to the same origin. Imported entries may reuse a
 * stored instance id with an attacker-chosen URL, so callers use this to
 * decide whether a stored token may stay bound to that id. Unparseable URLs
 * fail closed (treated as different origins) rather than accidentally
 * authorizing the reuse.
 */
export function isSameOriginUrl(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Per imported instance, true when its token matches a stored instance with a
 * different id. Computed host-side so stored tokens are never sent to the
 * webview. Mirrors the previous webview-side check exactly: re-importing the
 * unchanged token over the instance it belongs to is not a conflict, and
 * empty tokens count as equal like any other string.
 */
export function computeTokenConflicts(imported: ForgejoInstance[], existing: ForgejoInstance[]): boolean[] {
  return imported.map((instance) => {
    if (!existing.some((stored) => stored.token === instance.token)) {
      return false;
    }
    return existing.find((stored) => stored.id === instance.id)?.token !== instance.token;
  });
}

/**
 * Token-conflict flags for the import preview, parallel to `imported`. On top
 * of computeTokenConflicts this also flags tokens duplicated within the file
 * itself — the webview used to run that check on the raw tokens before token
 * values stopped crossing over (its conflict predicate ORed the two).
 */
export function computeImportTokenConflicts(imported: ForgejoInstance[], existing: ForgejoInstance[]): boolean[] {
  const conflicts = computeTokenConflicts(imported, existing);
  const counts = new Map<string, number>();
  for (const instance of imported) {
    counts.set(instance.token, (counts.get(instance.token) ?? 0) + 1);
  }
  return imported.map((instance, index) => conflicts[index] || (counts.get(instance.token) ?? 0) > 1);
}

/**
 * Copies of the imported instances with the token blanked out, for the
 * preview payload sent to the webview. The preview only renders non-secret
 * fields (conflict flags travel in a parallel array); token values stay in
 * the extension host and are rehydrated by id when the import is confirmed.
 */
export function stripInstanceTokens(instances: ForgejoInstance[]): ForgejoInstance[] {
  return instances.map((instance) => ({ ...instance, token: '' }));
}

/**
 * Validate raw instance entries from an export file and rebuild them as
 * plain objects carrying only the known fields. Invalid entries are dropped
 * and counted. `syncApiUrlsToInstanceUrl` is kept only when it is actually
 * a boolean, so older exports without it round-trip to `undefined`.
 *
 * `id` is forwarded as-is: the file may name an id that is already stored,
 * and this function has no view of the stored list. ConfigManager.addInstance
 * enforces the id/url origin consistency that makes reusing a stored id safe
 * (see isSameOriginUrl), so no check belongs here.
 */
export function sanitizeImportedInstances(items: unknown[]): { valid: ForgejoInstance[]; dropped: number } {
  const valid: ForgejoInstance[] = [];
  let dropped = 0;
  for (const item of items) {
    const instance = item as Record<string, unknown>;
    if (
      instance &&
      typeof instance.id === 'string' &&
      typeof instance.url === 'string' &&
      typeof instance.token === 'string' &&
      typeof instance.name === 'string' &&
      typeof instance.username === 'string'
    ) {
      valid.push({
        id: instance.id,
        url: instance.url,
        token: instance.token,
        name: instance.name,
        username: instance.username,
        ...(typeof instance.syncApiUrlsToInstanceUrl === 'boolean'
          ? { syncApiUrlsToInstanceUrl: instance.syncApiUrlsToInstanceUrl }
          : {}),
      });
    } else {
      dropped += 1;
    }
  }
  return { valid, dropped };
}

export async function readExportDataFromUri(uri: vscode.Uri): Promise<ExportData> {
  const content = await fs.promises.readFile(uri.fsPath, 'utf8');
  const parsed = JSON.parse(content) as {
    encrypted?: boolean;
    instances?: unknown[];
    settings?: unknown;
    [key: string]: unknown;
  };
  let raw: unknown;
  if (parsed.encrypted === true) {
    const password = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Enter import password'),
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) {
      throw new Error('Import cancelled');
    }
    try {
      raw = decryptExportData(
        parsed as { salt: string; iv: string; authTag: string; data: string; iterations?: number },
        password,
      );
    } catch (error) {
      // An invalid iteration count is a file problem, not a wrong password.
      if (error instanceof RangeError) {
        throw error;
      }
      throw new Error(vscode.l10n.t('Incorrect password or corrupted file'));
    }
  } else {
    raw = parsed;
  }
  const data: { instances?: unknown[]; settings?: unknown } =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { instances?: unknown[]; settings?: unknown })
      : { instances: Array.isArray(raw) ? raw : undefined, settings: undefined };
  const instances = Array.isArray(data.instances) ? data.instances : [];
  const { valid: validInstances } = sanitizeImportedInstances(instances);
  if (validInstances.length === 0) {
    throw new Error('No valid instances found in file');
  }
  const settings = data.settings as ExportSettings | undefined;
  return { instances: validInstances, settings };
}
