import type * as vscode from 'vscode';
import { isAiProviderSegment } from './modelSettings';

/**
 * Where a provider's credentials live (`docs/design/ai-model-transport.md` §8.2).
 *
 * Two secrets, and the second one is the point:
 *
 * | data                                                       | key                                                                |
 * | ---------------------------------------------------------- | ------------------------------------------------------------------ |
 * | the API key                                                | `forgejoToolkit.aiProviderKey.<providerId>`                        |
 * | a custom header's **value** (including `Authorization`)    | `forgejoToolkit.aiProviderHeader.<providerId>.<headerName>`        |
 *
 * The record records why the header value is protected rather than only the
 * standalone key: an implementation that guards the "API key" field while writing
 * `Authorization` in clear into `settings.json` has gone around its own rule, and
 * request headers routinely *are* the credential. So the split is by **kind of
 * data**, not by field name, and the settings side
 * (`src/ai/modelSettings.ts`) can only ever hold a header's *name*.
 *
 * Both key shapes use `.` as the separator, which is why the provider id and the
 * header name are validated against one character class
 * (`isAiProviderSegment`): a name containing a `.` would make the key ambiguous.
 * The accessors below re-check it and answer `undefined` rather than building a
 * key that could collide with another provider's.
 *
 * The store is typed structurally (the three `SecretStorage` methods this module
 * calls) rather than as `vscode.SecretStorage`, so the transport and the command
 * can be handed a container-scoped store in production and a recording double in
 * tests without a cast.
 */

/** The `SecretStorage` surface this module needs. */
export interface AiSecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

/** The prefix of every API-key secret, mirroring `TOKEN_SECRET_PREFIX`'s discipline. */
export const AI_PROVIDER_KEY_SECRET_PREFIX = 'forgejoToolkit.aiProviderKey.';

/** The prefix of every custom-header secret. */
export const AI_PROVIDER_HEADER_SECRET_PREFIX = 'forgejoToolkit.aiProviderHeader.';

/** The secret key holding one provider's API key. */
export function aiProviderKeySecretKey(providerId: string): string {
  return `${AI_PROVIDER_KEY_SECRET_PREFIX}${providerId}`;
}

/**
 * The secret key holding one provider header's value, or `undefined` when either
 * segment cannot be part of a key.
 *
 * `undefined` rather than a best-effort key: this is the one place a bad segment
 * could silently address *another* provider's secret, so it refuses instead.
 */
export function aiProviderHeaderSecretKey(providerId: string, headerName: string): string | undefined {
  if (!isAiProviderSegment(providerId) || !isAiProviderSegment(headerName)) {
    return undefined;
  }
  return `${AI_PROVIDER_HEADER_SECRET_PREFIX}${providerId}.${headerName}`;
}

/**
 * The header names the `auth` style owns (§8.5).
 *
 * A declared header with one of these names is **not sent**: the auth style's
 * value wins, and the conflict is reported by the settings surface rather than
 * resolved by a silent override — "the header I configured had no effect" is the
 * kind of puzzle §8.5 exists to prevent.
 */
const AUTH_OWNED_HEADER_NAMES: readonly string[] = ['authorization', 'api-key'];

/** Whether the `auth` style owns this header name (case-insensitively). */
export function isAuthOwnedHeaderName(headerName: string): boolean {
  return AUTH_OWNED_HEADER_NAMES.includes(headerName.trim().toLowerCase());
}

/**
 * The `api-version` header name, which is carried as a **query parameter** rather
 * than as a request header (§6.1, §6.2: Azure OpenAI's own spelling). Its value
 * still lives in `SecretStorage` like every other custom header value, because
 * §8.5 puts every one of them there.
 */
export const AI_PROVIDER_API_VERSION_HEADER = 'api-version';

/** Whether a declared header's value is carried in the query string rather than as a header. */
export function isQueryCarriedHeaderName(headerName: string): boolean {
  return headerName.trim().toLowerCase() === AI_PROVIDER_API_VERSION_HEADER;
}

/**
 * One secret's value, or `undefined` when it is absent or empty.
 *
 * An empty stored value reads as "no value": an empty `Authorization: Bearer ` is
 * worse than no header at all — the endpoint rejects it with a 401 that blames the
 * credential rather than saying none was configured — and no real credential is
 * the empty string.
 */
async function readSecret(secrets: AiSecretStore, key: string | undefined): Promise<string | undefined> {
  if (key === undefined) {
    return undefined;
  }
  let value: string | undefined;
  try {
    value = await secrets.get(key);
  } catch {
    // A secret store that throws is "not configured", the same direction a failed
    // settings read takes: it can only ever mean "send less".
    return undefined;
  }
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** One provider's API key, or `undefined` when none is stored. */
export async function readAiProviderKey(secrets: AiSecretStore, providerId: string): Promise<string | undefined> {
  return await readSecret(secrets, isAiProviderSegment(providerId) ? aiProviderKeySecretKey(providerId) : undefined);
}

/** One provider header's value, or `undefined` when none is stored. */
export async function readAiProviderHeaderValue(
  secrets: AiSecretStore,
  providerId: string,
  headerName: string,
): Promise<string | undefined> {
  return await readSecret(secrets, aiProviderHeaderSecretKey(providerId, headerName));
}

/** Stores one provider's API key. */
export async function storeAiProviderKey(secrets: AiSecretStore, providerId: string, value: string): Promise<void> {
  await secrets.store(aiProviderKeySecretKey(providerId), value);
}

/** Forgets one provider's API key. */
export async function deleteAiProviderKey(secrets: AiSecretStore, providerId: string): Promise<void> {
  await secrets.delete(aiProviderKeySecretKey(providerId));
}

/** Stores one provider header's value, refusing a name that cannot be part of a key. */
export async function storeAiProviderHeaderValue(
  secrets: AiSecretStore,
  providerId: string,
  headerName: string,
  value: string,
): Promise<void> {
  const key = aiProviderHeaderSecretKey(providerId, headerName);
  if (key === undefined) {
    throw new Error(`"${headerName}" cannot be a header name in the secret store (letters, digits, "_" and "-" only)`);
  }
  await secrets.store(key, value);
}

/** Forgets one provider header's value. */
export async function deleteAiProviderHeaderValue(
  secrets: AiSecretStore,
  providerId: string,
  headerName: string,
): Promise<void> {
  const key = aiProviderHeaderSecretKey(providerId, headerName);
  if (key === undefined) {
    return;
  }
  await secrets.delete(key);
}

/** The secret store production code uses: the extension context's own. */
export function contextSecretStore(context: { secrets: vscode.SecretStorage }): AiSecretStore {
  return context.secrets;
}
