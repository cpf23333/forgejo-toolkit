import { passthroughTranslate, type TranslateFn } from './translate';

export type ApiErrorKind = 'network' | 'timeout' | 'http' | 'unknown';

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
 * Classify an error thrown by the shared fetch client. Timeouts (AbortSignal)
 * and network failures (instance down, DNS, refused connection) are told apart
 * from HTTP error statuses so the UI can show a meaningful localized message
 * instead of a raw `fetch failed`.
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
  if (
    error instanceof TypeError ||
    /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up/i.test(raw)
  ) {
    return new ApiError('network', raw);
  }
  return new ApiError('unknown', raw);
}

/**
 * Pull the human-readable `message` field out of a `Forgejo API error <status>:
 * <json body>` string so validation failures surface their actual reason
 * instead of raw JSON. Falls back to the original text.
 */
export function extractApiErrorMessage(raw: string): string {
  const bodyMatch = raw.match(/Forgejo API error \d+:\s*(\{[\s\S]*)/);
  if (bodyMatch) {
    try {
      const parsed = JSON.parse(bodyMatch[1]) as { message?: unknown };
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        return parsed.message;
      }
    } catch {
      // Not JSON — fall through to the raw message.
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
