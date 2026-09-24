import { passthroughTranslate, type TranslateFn } from './translate';

export type ApiErrorKind = 'network' | 'timeout' | 'tls' | 'http' | 'unknown';

/**
 * Node/undici error codes and messages that mean "the TLS handshake failed
 * because the server certificate is not trusted", as opposed to "the instance
 * is unreachable". They are deliberately matched on both the message (undici
 * surfaces prose such as `self-signed certificate`) and `cause.code`.
 */
const TLS_FAILURE_PATTERN =
  /certificate|CERT_|DEPTH_ZERO|UNABLE_TO_VERIFY|SELF_SIGNED|ERR_TLS|ERR_SSL|_SSL_|TLS_|self[- ]signed|unable to verify the first certificate|Hostname\/IP does not match/i;

// Localization is injected by the vscode-bound wrapper (errors.ts); headless
// consumers (the MCP server process) keep the English passthrough default.
let translate: TranslateFn = passthroughTranslate;

export function setApiErrorTranslate(t: TranslateFn): void {
  translate = t;
}

/**
 * Structured wrapper for request failures raised by ForgejoClient. `message`
 * keeps the raw text (e.g. `Forgejo API error 409: ...`) so existing pattern
 * matching and logs keep working; `userMessage` is the localized, displayable
 * rendering produced from `kind`/`status`.
 */
export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly rawMessage: string,
    readonly status?: number,
  ) {
    super(rawMessage);
    this.name = 'ApiError';
  }

  get userMessage(): string {
    return apiErrorUserMessage(this);
  }
}

/**
 * Collects `message` and `code` from an error plus its `cause` chain. Node's
 * fetch wraps the underlying failure in a `TypeError('fetch failed')` whose
 * `cause` carries the real code (e.g. `DEPTH_ZERO_SELF_SIGNED_CERT`), so the
 * top-level message alone cannot tell a certificate problem from an outage.
 */
function describeErrorChain(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(current.message);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      parts.push(code);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' ');
}

/**
 * Classify an error thrown by the shared fetch client. Timeouts (AbortSignal),
 * certificate/TLS failures and network failures (instance down, DNS, refused
 * connection) are told apart from HTTP error statuses so the UI can show a
 * meaningful localized message instead of a raw `fetch failed`.
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  const raw = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new ApiError('timeout', raw);
  }
  const httpMatch = raw.match(/Forgejo API error (\d+):/);
  if (httpMatch) {
    return new ApiError('http', raw, Number(httpMatch[1]));
  }
  // Checked before the generic network branch: a certificate failure is also a
  // `TypeError('fetch failed')`, and calling it "check that the instance is
  // running and the URL is correct" sends the user after the wrong problem.
  if (TLS_FAILURE_PATTERN.test(describeErrorChain(error))) {
    return new ApiError('tls', raw);
  }
  if (
    error instanceof TypeError ||
    /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up/i.test(raw)
  ) {
    return new ApiError('network', raw);
  }
  return new ApiError('unknown', raw);
}

/**
 * The `message` field of the JSON object carried by an error body, if the body
 * carries one.
 *
 * The shared request client renders a JSON body as `<statusText> ({...})` (see
 * `describedBody` in `packages/shared/src/request/index.ts`), so the object is
 * wrapped in parentheses; a bare object (`{"message":"..."}`) is accepted too,
 * for callers and fixtures that build the message by hand. A body that is not
 * JSON, or is JSON without a usable `message` string, yields `undefined` so the
 * caller can fall back to the raw text — for a described body (empty, or from a
 * non-JSON content type) the description *is* the actionable part.
 */
function messageFromErrorBody(body: string): string | undefined {
  const jsonStart = body.indexOf('{');
  if (jsonStart === -1) {
    return undefined;
  }
  const quoted = body.slice(jsonStart).trim();
  const candidates = quoted.endsWith(')') ? [quoted, quoted.slice(0, -1).trim()] : [quoted];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object') {
      const message = (parsed as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) {
        return message;
      }
      // Valid JSON, but nothing to extract: stop instead of re-parsing the
      // same object with its wrapper stripped.
      return undefined;
    }
  }
  return undefined;
}

/**
 * Pull the human-readable `message` field out of a `Forgejo API error <status>:
 * <body>` string so validation failures surface their actual reason instead of
 * raw JSON. Falls back to the original text.
 */
export function extractApiErrorMessage(raw: string): string {
  const bodyMatch = raw.match(/Forgejo API error \d+:\s*([\s\S]*)$/);
  if (bodyMatch) {
    const message = messageFromErrorBody(bodyMatch[1]);
    if (message !== undefined) {
      return message;
    }
  }
  return raw;
}

/** Localized, displayable rendering of an ApiError. */
export function apiErrorUserMessage(error: ApiError): string {
  switch (error.kind) {
    case 'timeout':
      return translate('The request timed out. The instance is not responding.');
    case 'network':
      return translate('Cannot connect to the instance. Check that it is running and that the URL is correct.');
    case 'tls':
      return translate(
        'The instance certificate is not trusted. The server presented a self-signed, expired or otherwise unverifiable certificate; install a trusted certificate on the instance, or add its certificate to your system trust store.',
      );
    case 'http':
      switch (error.status) {
        case 401:
          return translate('Invalid or expired credentials. Check the access token for this instance.');
        case 403:
          return translate('Permission denied. The access token may lack the required scope.');
        case 404:
          return translate('Not found. The resource may have been deleted or is not accessible with this token.');
        case 409:
          return translate('Conflict: {0}', extractApiErrorMessage(error.rawMessage));
        case 422:
          return translate('Validation failed: {0}', extractApiErrorMessage(error.rawMessage));
        default:
          return translate('Request failed: {0}', extractApiErrorMessage(error.rawMessage));
      }
    case 'unknown':
      return error.rawMessage;
  }
}

/**
 * Error-to-display-string boundary for user-facing surfaces (message replies,
 * error toasts, MCP tool errors). Structured ApiErrors render as localized
 * messages; anything else keeps its original text. The raw message stays
 * available on `ApiError.rawMessage` for logs.
 */
export function userFacingErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.userMessage;
  }
  return error instanceof Error ? error.message : String(error);
}
