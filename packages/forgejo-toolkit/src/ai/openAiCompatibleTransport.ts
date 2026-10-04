import * as vscode from 'vscode';
import { RequestError, client as sharedClient, type RequestFetch } from '@cpf23333-forgejo-toolkit/shared/request';
import { logger } from '../logger';
import { aiPreReviewAnswerExcerpt } from '../aiPreReviewBrief';
import { combineRequestSignals, defaultRequestDispatcherPair, withDispatcher } from '../api/client';
import { getProxyFetch } from '../api/proxy';
import { redactUrlUserinfo } from '../utils/redactUrlUserinfo';
import type { AiCompletionRequest, AiCompletionResult, AiModelInfo, AiModelTransport } from './transport';
import {
  aiLocalOnlySettingValue,
  aiModelRequestTimeoutMsSettingValue,
  aiModelRequestTotalTimeoutMs,
  inspectAiProviderBaseUrl,
  isLocalAiEndpointHost,
  type AiProviderConfig,
} from './modelSettings';
import {
  isAuthOwnedHeaderName,
  isQueryCarriedHeaderName,
  readAiProviderHeaderValue,
  readAiProviderKey,
  type AiSecretStore,
} from './providerSecrets';

/**
 * The OpenAI-compatible transport: a second implementation of the model seam,
 * pointed at an endpoint the **user** configured
 * (`docs/design/ai-model-transport.md` §6).
 *
 * What it is, in one paragraph: `POST <base>/chat/completions` with
 * `stream: true`, reading the SSE response line by line into **two separate
 * candidate streams** — `delta.content` into the text candidate and
 * `delta.reasoning_content` / `delta.reasoning` into the reasoning candidate —
 * which are never concatenated with each other (§6.4). `GET <base>/models` is
 * used only by the test-connection command and only as a prefill (§8.7, §9.1):
 * `listModels()` here sends **nothing**, because "no content leaves the machine
 * before the consent question is answered" is a structural property of the seam
 * (§7.2) and a transport that listed models over the wire would break it.
 *
 * The four rules this file exists to hold, and where each is implemented:
 *
 * - **No retry** (§6.6). There is no retry, no backoff and no second attempt
 *   anywhere in this file. The retry that exists in this extension is the
 *   feature's own, and only after a contract violation.
 * - **No fallback** (§7.5). This class never reaches for `vscode.lm`, and nothing
 *   here consults `aiTransport` or a binding: it is handed one provider and obeys
 *   it. Choosing between transports is `src/ai/modelSelection.ts`'s job and the
 *   selection fails rather than substituting.
 * - **No secret in any log line or message** (§6.5). Only header **names** are
 *   ever logged, the request URL is logged without its query string (a query
 *   parameter carries the `api-version` header value, §8.5), and the user-facing
 *   sentences name the endpoint and the status and never a credential.
 * - **Idle, not total, timeouts** (§6.5, §8.6). The shared request layer's
 *   `API_REQUEST_TIMEOUT_MS` is deliberately **not** applied: it is a total cap,
 *   and a model answer legitimately takes longer than any fixed total. The window
 *   that applies is an idle watchdog derived from
 *   `forgejoToolkit.aiModelRequestTimeoutMs`, plus a total cap at ten times that
 *   value so a stream that dribbles forever cannot hold the window open.
 *
 * The HTTP layer is `sharedClient` from `packages/shared/src/request` — the same
 * thin client every Forgejo call goes through — carrying the **same** proxy
 * dispatcher pair activation installs (`src/api/client.ts`,
 * `src/api/proxy.ts`). There is no second HTTP client here.
 */

/** The path appended to a base URL for one completion (§6.2). */
export const CHAT_COMPLETIONS_PATH = '/chat/completions';

/** The path appended to a base URL for the model list (§6.1). */
export const MODELS_PATH = '/models';

/**
 * How much of a body is kept while the response has **not** looked like SSE, for
 * the non-streaming fallback (§6.4 item 7).
 *
 * The memory is bounded because a stream that never sends a `data:` line is
 * either a small JSON document (the case this exists for) or not something this
 * transport can read at all; 1 MiB is far past any completion an endpoint would
 * return in one piece, and past it the reading stops copying and reports that the
 * response was too large to read rather than growing without limit.
 */
const JSON_FALLBACK_MAX_BYTES = 1024 * 1024;

/** The provider-facing failure of one request, as its user-facing sentences are built. */
export interface OpenAiFailureContext {
  provider: AiProviderConfig;
  /** The request URL **without** its query string, for display and logs. */
  endpoint: string;
  /** Whether a proxy is installed, which changes what a connection failure means. */
  viaProxy: boolean;
}

/** One response from an endpoint, in the shape the shared client returns it. */
export interface OpenAiResponse {
  status: number;
  statusText: string;
  headers: Headers;
  data: unknown;
}

/** What one request needs: the URL, the credentials already resolved, and how to read the answer. */
export interface OpenAiSendOptions {
  url: string;
  method: 'GET' | 'POST';
  /** The resolved headers, including whatever the auth style added. */
  headers: Record<string, string>;
  /** A JSON body, or nothing for a GET. */
  body?: unknown;
  /** `stream` hands over the raw body; `json` parses it. */
  responseType?: 'json' | 'stream';
  signal?: AbortSignal;
  /** Overridable so a test can run without the activation-time proxy install. */
  dispatcherPair?: () => { dispatcher?: unknown; fetchImpl?: RequestFetch };
}

/**
 * One request to an OpenAI-compatible endpoint, through the extension's shared
 * request layer.
 *
 * `sharedClient` is the whole reason this is short: it owns the header merge, the
 * dispatcher/fetch pair, `response.body` for `responseType: 'stream'`, and — the
 * part the transport depends on — turning every non-2xx into a `RequestError`
 * carrying `status` and `body` instead of a bare `undefined`.
 */
export async function sendOpenAiRequest(options: OpenAiSendOptions): Promise<OpenAiResponse> {
  const pair = (options.dispatcherPair ?? defaultRequestDispatcherPair)();
  const responseType = options.responseType ?? 'json';
  const config = withDispatcher(
    {
      url: options.url,
      method: options.method,
      headers: {
        // A stream request asks for SSE; a JSON request asks for JSON. The
        // endpoint is the authority on what it answers, and the reader below
        // tolerates an endpoint that ignores the `Accept` header either way.
        Accept: responseType === 'stream' ? 'text/event-stream' : 'application/json',
        ...options.headers,
      },
      data: options.body,
      responseType,
      signal: options.signal,
    },
    pair.dispatcher,
    pair.fetchImpl,
  );
  const response = await sharedClient<unknown, unknown, unknown>(config);
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    data: response.data,
  };
}

/** The path of the completion endpoint for one provider, with its query parameters merged in. */
export function openAiEndpointUrl(baseUrl: string, path: string, query?: Record<string, string>): string {
  const parsed = new URL(baseUrl.trim().replace(/\/+$/, ''));
  // The user's base URL is used as given apart from its trailing slash: `/v1` is
  // **not** appended, because Azure's URL and a gateway's `/openai/v1` would both
  // be made wrong by it (§6.2).
  const basePath = parsed.pathname.replace(/\/+$/, '');
  const search = new URLSearchParams(parsed.search);
  for (const [name, value] of Object.entries(query ?? {})) {
    search.set(name, value);
  }
  const suffix = search.toString() === '' ? '' : `?${search.toString()}`;
  return `${parsed.protocol}//${parsed.host}${basePath}${path}${suffix}`;
}

/**
 * A request URL as a human may see it: no query string, and no userinfo.
 *
 * The query is dropped on purpose. The one parameter this transport can add is
 * `api-version`, whose value is a **custom header value** and therefore lives in
 * `SecretStorage` (§8.5) — printing it would put a configured secret into the
 * output channel through the back door. `redactUrlUserinfo` is then double
 * insurance: §6.2 already refuses such a URL, and this is the one place a URL
 * reaches a log.
 */
export function openAiEndpointDisplayUrl(url: string): string {
  let withoutQuery = url;
  try {
    const parsed = new URL(url);
    withoutQuery = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // Not parseable: show it as it is, redacted, rather than claim a URL this
    // function could not read.
    withoutQuery = url.split('?')[0] ?? url;
  }
  return redactUrlUserinfo(withoutQuery);
}

/** What one request's credentials and custom headers came out to. */
export interface OpenAiRequestAuth {
  /** The headers to send, with the auth style already applied. */
  headers: Record<string, string>;
  /** The parameters to append to the URL (`api-version`, §6.2). */
  query: Record<string, string>;
  /**
   * Declared header names the auth style owns, so they were **not** sent (§8.5).
   * Reported by name only — the value is a secret and never leaves
   * `SecretStorage`.
   */
  shadowed: string[];
  /** Whether a credential was actually found. `false` is a configuration failure, not an empty header. */
  keyPresent: boolean;
}

/**
 * Resolves one provider's request credentials.
 *
 * Three rules, all from §8.5:
 *
 * 1. `auth` decides the credential header: `bearer` → `Authorization: Bearer
 *    <key>`, `api-key-header` → `api-key: <key>`, `none` → none at all (a local
 *    server commonly needs nothing).
 * 2. Every other declared header takes its value from `SecretStorage` by name. A
 *    declared name the auth style owns is **shadowed** rather than merged: the
 *    configured auth style wins, and the caller can say so. A silent override is
 *    how "the header I configured did nothing" becomes undiagnosable.
 * 3. `api-version` is carried as a **query parameter**, not as a request header
 *    (§6.1, §6.2) — Azure's own spelling — and only when a value is stored for it.
 *
 * It deliberately does **not** throw for a missing credential: `availability()`
 * and the test-connection command both need to report that state, and `complete()`
 * is the one place that turns it into a failure.
 */
export async function openAiRequestAuth(
  provider: AiProviderConfig,
  secrets: AiSecretStore,
): Promise<OpenAiRequestAuth> {
  const headers: Record<string, string> = {};
  const query: Record<string, string> = {};
  const shadowed: string[] = [];
  for (const declaration of provider.headers) {
    if (isAuthOwnedHeaderName(declaration.name)) {
      shadowed.push(declaration.name);
      continue;
    }
    const value = await readAiProviderHeaderValue(secrets, provider.id, declaration.name);
    if (value === undefined) {
      continue;
    }
    if (isQueryCarriedHeaderName(declaration.name)) {
      query[declaration.name.toLowerCase()] = value;
      continue;
    }
    headers[declaration.name] = value;
  }
  const key = provider.auth === 'none' ? undefined : await readAiProviderKey(secrets, provider.id);
  if (provider.auth === 'bearer' && key !== undefined) {
    headers.Authorization = `Bearer ${key}`;
  } else if (provider.auth === 'api-key-header' && key !== undefined) {
    headers['api-key'] = key;
  }
  return { headers, query, shadowed, keyPresent: provider.auth === 'none' || key !== undefined };
}

/** The l10n sentence for an endpoint that cannot be used at all. */
export function openAiEndpointUnusableMessage(provider: AiProviderConfig, reason: string): string {
  return vscode.l10n.t('The AI endpoint "{0}" cannot be used: {1}', provider.name, reason);
}

/** The l10n sentence for a provider with no stored credential. */
export function openAiMissingKeyMessage(provider: AiProviderConfig): string {
  return vscode.l10n.t(
    'No API key is stored for the AI endpoint "{0}". Add it in your user settings; nothing was sent.',
    provider.name,
  );
}

/** The l10n sentence for an endpoint the local-only policy refuses. */
export function openAiLocalOnlyMessage(provider: AiProviderConfig, host: string): string {
  return vscode.l10n.t(
    'The AI endpoint "{0}" is at {1}, which is not this machine or a private network, and "forgejoToolkit.aiLocalOnly" is on. Nothing was sent.',
    provider.name,
    host,
  );
}

/** The l10n sentence for a plain-`http://` endpoint, logged when a request is about to go out. */
export function openAiInsecureEndpointMessage(endpoint: string): string {
  return vscode.l10n.t(
    'This AI endpoint address is plain http:// rather than https://, so the request and the answer are not encrypted in transit: {0}',
    endpoint,
  );
}

/** The l10n sentence for an idle watchdog abort. */
function openAiStalledMessage(provider: AiProviderConfig, seconds: number): string {
  return vscode.l10n.t(
    'The AI endpoint "{0}" stopped sending data for {1} second(s); the request was aborted.',
    provider.name,
    Math.max(1, seconds),
  );
}

/** The l10n sentence for a total-cap abort. */
function openAiTotalTimeoutMessage(provider: AiProviderConfig, seconds: number): string {
  return vscode.l10n.t(
    'The AI endpoint "{0}" was still streaming after {1} second(s) in total; the request was aborted.',
    provider.name,
    Math.max(1, seconds),
  );
}

/** The bounded, non-secret excerpt a 5xx rendering may quote. */
function boundedBodyExcerpt(body: unknown): string {
  if (typeof body === 'string') {
    return aiPreReviewAnswerExcerpt(body);
  }
  if (typeof body === 'object' && body !== null) {
    // The shape every OpenAI-compatible endpoint uses for its own failures, and
    // the only part of a body worth quoting: the endpoint's sentence. Anything
    // else is described rather than dumped.
    const message = (body as { error?: { message?: unknown } }).error?.message;
    if (typeof message === 'string' && message !== '') {
      return aiPreReviewAnswerExcerpt(message);
    }
    try {
      return aiPreReviewAnswerExcerpt(JSON.stringify(body));
    } catch {
      return 'the endpoint sent a body this extension could not render';
    }
  }
  return '';
}

/**
 * A failed request as the model endpoint's own error, never as Forgejo's.
 *
 * `sharedClient` renders every non-2xx as `Forgejo API error <status>`, which for
 * a model endpoint sends the user to look at a Forgejo instance that is not
 * involved (§6.5). Every row of the record's table is a branch here, and none of
 * them contains a credential: the key is never printed — not even its length — and
 * the only body text quoted is a **bounded** excerpt, on the same discipline as
 * `aiPreReviewAnswerExcerpt`.
 */
export function openAiEndpointFailure(error: unknown, context: OpenAiFailureContext): Error {
  const { provider, endpoint, viaProxy } = context;
  const status = openAiRequestStatus(error);
  if (status !== undefined) {
    if (status === 401 || status === 403) {
      return new Error(
        vscode.l10n.t(
          'The AI endpoint "{0}" rejected the credential (HTTP {1}). The key itself is never printed; re-enter it in your user settings if it has expired.',
          provider.name,
          status,
        ),
      );
    }
    if (status === 404) {
      return new Error(
        vscode.l10n.t(
          'There is no chat-completions path at {0} (HTTP 404). The base URL usually has to include the API path, for example "/v1".',
          endpoint,
        ),
      );
    }
    if (status === 429) {
      return new Error(
        vscode.l10n.t(
          'The AI endpoint "{0}" is rate limiting the request (HTTP 429). The request was not retried.',
          provider.name,
        ),
      );
    }
    if (status >= 500) {
      const excerpt = boundedBodyExcerpt(errorBodyOf(error));
      return new Error(
        excerpt === ''
          ? vscode.l10n.t('The AI endpoint "{0}" failed with HTTP {1}.', provider.name, status)
          : vscode.l10n.t('The AI endpoint "{0}" failed with HTTP {1}: {2}', provider.name, status, excerpt),
      );
    }
    return new Error(vscode.l10n.t('The AI endpoint "{0}" answered HTTP {1}.', provider.name, status));
  }
  const cause = rootCauseMessage(error);
  const base = vscode.l10n.t('Could not reach the AI endpoint "{0}" at {1}: {2}', provider.name, endpoint, cause);
  if (!viaProxy) {
    return new Error(base);
  }
  return new Error(
    `${base} ${vscode.l10n.t('If this machine reaches the endpoint through a proxy, check the proxy setting.')}`,
  );
}

/**
 * The HTTP status of a shared-client request failure, or `undefined` for anything
 * else.
 *
 * Exported because the test-connection command has to tell "this endpoint has no
 * `/models`" (a 404, which is not a failure, §8.7) from "the credential was
 * rejected" (which is).
 */
export function openAiRequestStatus(error: unknown): number | undefined {
  if (error instanceof RequestError && typeof error.status === 'number') {
    return error.status;
  }
  // A `RequestError` from another copy of the shared module is not an `instanceof`
  // this one, and the whole error surface here is built on reading the status.
  const candidate = error as { name?: unknown; status?: unknown } | null;
  if (candidate && candidate.name === 'RequestError' && typeof candidate.status === 'number') {
    return candidate.status;
  }
  return undefined;
}

/** The parsed body a `RequestError` carries, when it carries one. */
function errorBodyOf(error: unknown): unknown {
  return (error as { body?: unknown } | null)?.body;
}

/**
 * The innermost message of a thrown network failure.
 *
 * Node's `fetch` reports a refused connection or an unknown host as a `TypeError`
 * whose own message is the useless `fetch failed`; the reason (`ECONNREFUSED`,
 * `ENOTFOUND`, a TLS sentence) is on `cause`. Walking the chain is what makes the
 * rendering actionable without quoting a URL that may carry a credential.
 */
function rootCauseMessage(error: unknown): string {
  let current: unknown = error;
  let message = '';
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) {
      break;
    }
    const candidate = current as { message?: unknown; code?: unknown; cause?: unknown };
    if (typeof candidate.message === 'string' && candidate.message !== '') {
      message = candidate.message;
    }
    if (typeof candidate.code === 'string' && candidate.code !== '' && candidate.code !== 'ERR_') {
      message = message === '' ? candidate.code : `${message} (${candidate.code})`;
    }
    current = candidate.cause;
  }
  return redactUrlUserinfo(message === '' ? 'the request failed' : message);
}

/**
 * One answer as the seam's candidate streams, built from what the reader collected.
 *
 * The non-streaming fallback lives here too (§6.4 item 7): a response that never
 * sent a `data:` line is parsed as one JSON document, and
 * `choices[0].message.content` becomes the text candidate. Both paths run through
 * the same field extraction, so a `finish_reason` is read the same way whichever
 * shape the endpoint answered in.
 */
interface OpenAiStreamReading {
  /**
   * Which shape the response turned out to have. `unknown` is still open — nothing
   * meaningful has arrived yet — and is treated as the non-streaming case at the end,
   * because a body that never sent an SSE field is not a stream.
   */
  mode: 'unknown' | 'sse' | 'json';
  /** The text candidate's fragments, in arrival order. */
  text: string[];
  /** The reasoning candidate's fragments, in arrival order. */
  reasoning: string[];
  /** `data:` payloads that did not parse (§6.4 item 3). */
  skipped: number;
  /** The endpoint's own `finish_reason`, from whichever choice carried one. */
  finishReason?: string;
  /** The body kept while the response did not look like SSE; cleared once it does. */
  raw: string;
  /** True when the body passed the fallback cap, so it was not kept. */
  rawTruncated: boolean;
  /** An `error` object a 200 response carried instead of an answer, bounded. */
  endpointError?: string;
}

/** One `choices[0]` payload applied to the reading; returns whether a choice was there. */
function applyOpenAiChoice(payload: unknown, reading: OpenAiStreamReading): boolean {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const envelope = payload as { choices?: unknown; error?: unknown };
  if (envelope.error !== undefined && envelope.error !== null) {
    const message = (envelope.error as { message?: unknown }).message;
    reading.endpointError =
      typeof message === 'string' && message !== ''
        ? aiPreReviewAnswerExcerpt(message)
        : aiPreReviewAnswerExcerpt(JSON.stringify(envelope.error) ?? '');
  }
  const choices = envelope.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return false;
  }
  const choice = choices[0];
  if (typeof choice !== 'object' || choice === null) {
    return false;
  }
  const finish = (choice as { finish_reason?: unknown }).finish_reason;
  if (typeof finish === 'string' && finish !== '' && finish !== 'null') {
    reading.finishReason = finish;
  }
  // `delta` is the streaming shape and `message` the complete one; both are read
  // because §6.4 item 7 requires the fallback to be the *same* extraction and
  // because a gateway may put a full message in a single `data:` line.
  for (const container of [(choice as { delta?: unknown }).delta, (choice as { message?: unknown }).message]) {
    if (typeof container !== 'object' || container === null) {
      continue;
    }
    const content = (container as { content?: unknown }).content;
    if (typeof content === 'string' && content !== '') {
      reading.text.push(content);
    }
    // DeepSeek spells the reasoning channel `reasoning_content`, several gateways
    // spell it `reasoning`; they are the reasoning candidate's two known encodings
    // and neither is ever appended to the text candidate (§6.4 item 4).
    const reasoningContent = (container as { reasoning_content?: unknown }).reasoning_content;
    const reasoning = (container as { reasoning?: unknown }).reasoning;
    for (const part of [reasoningContent, reasoning]) {
      if (typeof part === 'string' && part !== '') {
        reading.reasoning.push(part);
      }
    }
  }
  return true;
}

/** One line of an SSE body, applied to the reading; returns whether the stream said `[DONE]`. */
function applySseLine(line: string, reading: OpenAiStreamReading): boolean {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  // An empty line separates events and a line starting with `:` is a comment
  // (§6.4 items 1 and 2). Neither is meaningful: a comment must not flip the mode.
  if (text === '' || text.startsWith(':')) {
    return false;
  }
  const colon = text.indexOf(':');
  const field = colon === -1 ? text : text.slice(0, colon);
  const rawValue = colon === -1 ? '' : text.slice(colon + 1);
  const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
  if (field === 'event' || field === 'id' || field === 'retry') {
    reading.mode = 'sse';
    return false;
  }
  if (field !== 'data') {
    // Not an SSE field: the body is a document, not a stream. Anything already
    // kept stays in `raw` and is parsed as the non-streaming fallback.
    if (reading.mode === 'unknown') {
      reading.mode = 'json';
    }
    return false;
  }
  reading.mode = 'sse';
  reading.raw = '';
  if (value.trim() === '[DONE]') {
    return true;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    // A line that does not parse is skipped and counted; the answer continues
    // (§6.4 item 3).
    reading.skipped += 1;
    return false;
  }
  applyOpenAiChoice(payload, reading);
  return false;
}

/**
 * A read that also settles when the signal aborts.
 *
 * A real `fetch` rejects an in-flight body read when its signal aborts, so this is
 * not the mechanism that makes cancellation work — it is what makes it work
 * **deterministically**: a mocked or proxied response body need not be wired to
 * the signal at all, and a read that never settles would leave the window waiting
 * on a request the user already cancelled. The rejection is an `AbortError`, the
 * one shape a cancellation takes across this seam.
 */
function abortableRead<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(cancellationError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(cancellationError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    read.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error as Error);
      },
    );
  });
}

/**
 * Reads one response body into the two candidate streams, tolerating both shapes
 * an OpenAI-compatible endpoint may answer a `stream: true` request with.
 *
 * The body is consumed **once**, chunk by chunk, so the idle watchdog can be
 * reset on real activity rather than on the request as a whole — that is the
 * difference between "a long answer survives" and "a long answer is killed",
 * which is the whole reason `aiModelRequestTimeoutMs` exists (§8.6). The reader is
 * cancelled on the way out, so an abort or a `[DONE]` releases the connection
 * instead of leaving the socket to be garbage collected.
 */
export async function collectOpenAiResponse(
  body: ReadableStream<Uint8Array>,
  hooks: { onActivity: () => void; signal: AbortSignal },
): Promise<OpenAiStreamReading> {
  const reading: OpenAiStreamReading = {
    mode: 'unknown',
    text: [],
    reasoning: [],
    skipped: 0,
    raw: '',
    rawTruncated: false,
  };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  try {
    while (!done) {
      if (hooks.signal.aborted) {
        break;
      }
      const step = await abortableRead(reader.read(), hooks.signal);
      if (step.done) {
        break;
      }
      hooks.onActivity();
      const chunk = decoder.decode(step.value, { stream: true });
      if (reading.mode !== 'sse' && !reading.rawTruncated) {
        if (reading.raw.length + chunk.length > JSON_FALLBACK_MAX_BYTES) {
          reading.rawTruncated = true;
          reading.raw = '';
        } else {
          reading.raw += chunk;
        }
      }
      if (reading.mode === 'json') {
        // A document, not a stream: there is nothing to parse per line.
        continue;
      }
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (applySseLine(line, reading)) {
          done = true;
          break;
        }
      }
    }
    if (!done && reading.mode !== 'json' && buffer !== '') {
      // A stream that ended without a trailing newline still carries its last
      // event, and a single-`data:` body is exactly that shape.
      applySseLine(buffer, reading);
    }
  } finally {
    // Deliberately **not** awaited: an abort leaves the underlying `read()` pending
    // on a body that may never deliver again, and `cancel()` waits for the pending
    // read to settle — so awaiting it here would hang the very cancellation the
    // rejection above is already reporting. Releasing the reader is cleanup, not
    // part of the answer.
    void reader.cancel().catch(() => undefined);
  }
  return reading;
}

/** Whether a reading produced any answer text at all. */
function readingHasAnswer(reading: OpenAiStreamReading): boolean {
  return reading.text.length > 0 || reading.reasoning.length > 0;
}

/** The l10n sentence for a response this transport cannot read. */
export function openAiUnreadableResponseMessage(provider: AiProviderConfig, bytes: number, shape: string): string {
  return vscode.l10n.t(
    'The AI endpoint "{0}" returned a response this extension cannot read ({1} bytes, {2}).',
    provider.name,
    bytes,
    shape,
  );
}

/** The l10n sentence for an endpoint that reported an error instead of an answer. */
function openAiEndpointErrorMessage(provider: AiProviderConfig, excerpt: string): string {
  return vscode.l10n.t('The AI endpoint "{0}" reported an error instead of an answer: {1}', provider.name, excerpt);
}

/** The l10n sentence that says the endpoint truncated its own answer. */
function openAiTruncatedMessage(provider: AiProviderConfig): string {
  return vscode.l10n.t(
    'The AI endpoint "{0}" stopped the answer at its own output limit (finish_reason=length), so the answer is incomplete.',
    provider.name,
  );
}

/**
 * A completed reading as the seam's result, or the failure the reading describes.
 *
 * The two candidate streams are joined **separately** and never concatenated:
 * `parts` keeps the seam's preference order (text first, reasoning second) and the
 * caller's contract scores each entry on its own bytes (§3.1, §5.4). There is no
 * `text-projection` candidate here — that is the editor API's own fallback and a
 * direct endpoint has nothing that corresponds to it.
 */
function openAiCompletionResult(
  reading: OpenAiStreamReading,
  model: AiModelInfo,
  provider: AiProviderConfig,
): AiCompletionResult {
  if (reading.mode !== 'sse') {
    if (reading.rawTruncated) {
      throw new Error(
        openAiUnreadableResponseMessage(
          provider,
          JSON_FALLBACK_MAX_BYTES,
          'it is not an event stream, and it is larger than the size a complete JSON answer may have',
        ),
      );
    }
    const raw = reading.raw;
    if (raw.trim() === '') {
      if (reading.endpointError !== undefined) {
        throw new Error(openAiEndpointErrorMessage(provider, reading.endpointError));
      }
      throw new Error(openAiUnreadableResponseMessage(provider, raw.length, 'the response body is empty'));
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error(
        openAiUnreadableResponseMessage(provider, raw.length, 'it is not an event stream and it is not JSON'),
      );
    }
    if (!applyOpenAiChoice(payload, reading)) {
      const shape = Array.isArray(payload) ? 'JSON: array with no choices' : `JSON: ${typeof payload} with no choices`;
      throw new Error(openAiUnreadableResponseMessage(provider, raw.length, shape));
    }
  } else if (!readingHasAnswer(reading) && reading.endpointError !== undefined) {
    throw new Error(openAiEndpointErrorMessage(provider, reading.endpointError));
  }

  const text = reading.text.join('');
  const reasoning = reading.reasoning.join('');
  const parts: AiCompletionResult['parts'] = [];
  if (text !== '') {
    parts.push({ kind: 'text', text });
  }
  if (reasoning !== '') {
    parts.push({ kind: 'reasoning', text: reasoning });
  }
  if (parts.length === 0) {
    // The seam's own contract is "at least one entry": an endpoint that streamed
    // nothing is an empty answer, which the caller's contract then fails on its
    // own terms rather than a seam-level crash.
    parts.push({ kind: 'text', text: '' });
  }
  if (reading.finishReason === 'length') {
    // §6.4 item 5: `length` means the endpoint stopped at its own output limit, and
    // for a feature whose contract is JSON that is a definite failure signal. It is
    // reported on the result (`truncated`) and in the output channel, so the run can
    // say "the answer was cut off" instead of "the answer was not JSON".
    logger.info(openAiTruncatedMessage(provider));
  }
  return {
    model,
    parts,
    fragments: reading.text.length > 0 ? reading.text : undefined,
    truncated: reading.finishReason === 'length',
  };
}

/** How the transport is configured: the provider, the secret store, and the two policy values. */
export interface OpenAiCompatibleTransportOptions {
  provider: AiProviderConfig;
  secrets: AiSecretStore;
  /** Overrides `forgejoToolkit.aiLocalOnly`; the policy is read fresh in production. */
  localOnly?: boolean;
  /** Overrides `forgejoToolkit.aiModelRequestTimeoutMs`; the window is read fresh in production. */
  requestTimeoutMs?: number;
  /** Overridable so a test can run without the activation-time proxy install. */
  dispatcherPair?: () => { dispatcher?: unknown; fetchImpl?: RequestFetch };
}

/**
 * One configured provider as a transport.
 *
 * It is built per use rather than cached: the class holds no mutable state, but the
 * provider object and the policy values it was built from are read fresh by its
 * caller, and a cached instance would keep sending to an address the user just
 * changed.
 */
export class OpenAiCompatibleTransport implements AiModelTransport {
  readonly id: string;

  constructor(private readonly options: OpenAiCompatibleTransportOptions) {
    this.id = `openai-compatible:${options.provider.id}`;
  }

  /** The provider this transport sends to. */
  get provider(): AiProviderConfig {
    return this.options.provider;
  }

  /** Whether the window's local-only policy applies to this provider. */
  private localOnlyPolicy(): boolean {
    return this.options.localOnly ?? aiLocalOnlySettingValue();
  }

  /**
   * Whether this endpoint can serve a request at all, in the order that answers
   * "what would I have to fix".
   *
   * A refused URL and a refused local-only policy are both checked before the
   * credential, because they are what the user has to change first; and nothing
   * here sends anything — reading a secret is not a request (§7.2).
   */
  async availability(): Promise<{ usable: true } | { usable: false; reason: string }> {
    const verdict = inspectAiProviderBaseUrl(this.provider.baseUrl);
    if (!verdict.ok) {
      return { usable: false, reason: openAiEndpointUnusableMessage(this.provider, verdict.reason) };
    }
    if ((this.localOnlyPolicy() || this.provider.localOnly) && !isLocalAiEndpointHost(verdict.url.hostname)) {
      return {
        usable: false,
        reason: openAiLocalOnlyMessage(this.provider, `${verdict.url.protocol}//${verdict.url.host}`),
      };
    }
    if (this.provider.auth !== 'none') {
      const key = await readAiProviderKey(this.options.secrets, this.provider.id);
      if (key === undefined) {
        return { usable: false, reason: openAiMissingKeyMessage(this.provider) };
      }
    }
    return { usable: true };
  }

  /**
   * The provider's **declared** models, and no request.
   *
   * The declaration is not a whitelist (§8.1), so an empty list is a legal answer
   * and is not a failure (§9.2): the model id a binding names is free text, and the
   * endpoint's own `/models` is only ever used to prefill the settings page with the
   * test-connection command (§9.1). `maxInputTokens` is left `undefined`: a direct
   * endpoint has no tokenizer this extension can ask, which is the seam's own "not
   * known" arm (§4.2, §13 question 3).
   */
  async listModels(): Promise<AiModelInfo[]> {
    return this.provider.models.map((model) => ({
      vendor: this.provider.id,
      id: model.id,
      name: model.name,
    }));
  }

  /**
   * Nothing: a direct endpoint has no tokenizer to measure text with.
   *
   * `undefined` is the seam's "this model cannot measure it" arm, not a failure —
   * the distinction §5.4 draws — and the input-budget policy for a transport in
   * that state belongs to the feature that measures (`docs/design/ai-model-transport.md`
   * §11.3), not here.
   */
  async countTokens(): Promise<number | undefined> {
    return undefined;
  }

  /**
   * One streamed completion.
   *
   * The order is deliberate and matches the record: validate the endpoint and the
   * policy **before** anything is sent, resolve the credential, send exactly one
   * request with `stream: true`, and read the answer under an idle watchdog. A
   * failure at any step throws; nothing here retries, substitutes a model or
   * reaches for another transport (§6.6, §7.5).
   */
  async complete(model: AiModelInfo, request: AiCompletionRequest): Promise<AiCompletionResult> {
    const provider = this.provider;
    if (model.vendor !== provider.id || model.id.trim() === '') {
      // A model this transport did not list, or a model from another provider: a
      // programming error at the seam's edge rather than a user-facing condition,
      // so it is refused loudly instead of being sent to an address the user did
      // not name for it.
      throw new Error(
        `the openai-compatible transport for "${provider.id}" cannot use the model "${model.vendor}/${model.id}"`,
      );
    }
    const verdict = inspectAiProviderBaseUrl(provider.baseUrl);
    if (!verdict.ok) {
      throw new Error(openAiEndpointUnusableMessage(provider, verdict.reason));
    }
    if ((this.localOnlyPolicy() || provider.localOnly) && !isLocalAiEndpointHost(verdict.url.hostname)) {
      throw new Error(openAiLocalOnlyMessage(provider, `${verdict.url.protocol}//${verdict.url.host}`));
    }

    const auth = await openAiRequestAuth(provider, this.options.secrets);
    if (!auth.keyPresent) {
      throw new Error(openAiMissingKeyMessage(provider));
    }
    const endpoint = openAiEndpointUrl(provider.baseUrl, CHAT_COMPLETIONS_PATH, auth.query);
    const display = openAiEndpointDisplayUrl(endpoint);
    if (verdict.insecure) {
      // Allowed, but never silent: the user is about to send content over a
      // connection that is not encrypted (§6.2).
      logger.info(openAiInsecureEndpointMessage(display));
    }
    if (auth.shadowed.length > 0) {
      // Names only. The value the auth style uses is a secret and the value the
      // declaration would have contributed is another one.
      logger.info(
        `AI endpoint "${provider.id}": the "auth" style owns ${auth.shadowed
          .map((name) => `"${name}"`)
          .join(', ')}, so the stored value for that header was not sent`,
      );
    }

    const idleWindowMs = this.options.requestTimeoutMs ?? aiModelRequestTimeoutMsSettingValue();
    const totalTimeoutMs = aiModelRequestTotalTimeoutMs(idleWindowMs);
    logger.debug(
      `AI endpoint "${provider.id}" via ${this.id}: request "${model.id}", idle watchdog ${idleWindowMs} ms, total cap ${totalTimeoutMs} ms, endpoint ${display}`,
    );

    const controller = new AbortController();
    let stalled = false;
    let totalTimedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    // The idle window is re-armed on every byte, which is what makes it an idle
    // window rather than a second total cap: a long answer that keeps arriving
    // never trips it (§8.6).
    const armIdleWatchdog = (): void => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, idleWindowMs);
    };
    const stopTimers = (): void => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      if (totalTimer !== undefined) {
        clearTimeout(totalTimer);
      }
    };
    armIdleWatchdog();
    totalTimer = setTimeout(() => {
      totalTimedOut = true;
      controller.abort();
    }, totalTimeoutMs);

    // The caller's signal and this request's own watchdog, combined rather than
    // overriding each other (`combineRequestSignals`, `src/api/client.ts`). The
    // shared layer's `API_REQUEST_TIMEOUT_MS` is deliberately absent: it is a
    // **total** cap, and applying it here would abort a legitimate long answer
    // (§6.5, §8.6). `controller.signal` is always present, so the merge always
    // yields one — the cast tells a type that cannot see it.
    const signal = combineRequestSignals([request.signal, controller.signal]) as AbortSignal;
    const context: OpenAiFailureContext = { provider, endpoint: display, viaProxy: Boolean(getProxyFetch()) };
    let reading: OpenAiStreamReading;
    try {
      const response = await sendOpenAiRequest({
        url: endpoint,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth.headers },
        // Exactly the three fields §6.3 allows. No `temperature`, no `max_tokens`,
        // no `response_format`, no `tools`, no `stream_options`: every one of them
        // has a different default per endpoint, and sending one would be betting on
        // a particular implementation's semantics.
        body: {
          model: model.id,
          messages: [
            { role: 'system', content: request.system },
            ...request.messages.map((message) => ({ role: message.role, content: message.text })),
          ],
          stream: true,
        },
        responseType: 'stream',
        signal,
        dispatcherPair: this.options.dispatcherPair,
      });
      const body = response.data as ReadableStream<Uint8Array> | null | undefined;
      if (!body || typeof body.getReader !== 'function') {
        throw new Error(openAiUnreadableResponseMessage(provider, 0, 'the response carried no body'));
      }
      reading = await collectOpenAiResponse(body, {
        onActivity: armIdleWatchdog,
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted) {
        // A cancellation is the user's own action and is reported as one whatever
        // else happened to the socket; the feature reads it by `name`, never by
        // `instanceof` (§6.5).
        throw cancellationError();
      }
      if (stalled) {
        throw new Error(openAiStalledMessage(provider, Math.round(idleWindowMs / 1000)));
      }
      if (totalTimedOut) {
        throw new Error(openAiTotalTimeoutMessage(provider, Math.round(totalTimeoutMs / 1000)));
      }
      throw openAiEndpointFailure(error, context);
    } finally {
      stopTimers();
    }
    if (request.signal?.aborted) {
      throw cancellationError();
    }
    if (reading.skipped > 0) {
      // §6.4 item 3: the skipped lines never fail the request, but the count is
      // said out loud so a mangled stream is diagnosable rather than mysterious.
      logger.debug(`AI endpoint "${provider.id}": skipped ${reading.skipped} data line(s) that did not parse as JSON`);
    }
    logger.debug(
      `AI endpoint "${provider.id}": answer read from the ${reading.mode === 'sse' ? 'event stream' : 'JSON body'}, ${
        reading.text.length
      } text fragment(s), ${reading.reasoning.length} reasoning fragment(s)${
        reading.finishReason === undefined ? '' : `, finish_reason=${reading.finishReason}`
      }`,
    );
    return openAiCompletionResult(reading, model, provider);
  }
}

/**
 * An `AbortError`, the one shape a cancellation takes across this seam.
 *
 * `name` rather than a class, for the reason `VscodeLmTransport` gives: the
 * feature's `isCancellation` reads the documented code names, and an abort may
 * arrive from another realm.
 */
function cancellationError(): Error {
  const error = new Error('the request was cancelled');
  error.name = 'AbortError';
  return error;
}

/** Builds the transport for one provider, reading the policies fresh unless they were overridden. */
export function openAiCompatibleTransportFor(
  provider: AiProviderConfig,
  secrets: AiSecretStore,
  overrides: Partial<Pick<OpenAiCompatibleTransportOptions, 'localOnly' | 'requestTimeoutMs' | 'dispatcherPair'>> = {},
): OpenAiCompatibleTransport {
  return new OpenAiCompatibleTransport({ provider, secrets, ...overrides });
}
