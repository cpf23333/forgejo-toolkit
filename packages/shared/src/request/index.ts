/**
 * Shared fetch client types used by generated API clients.
 */

export type RequestCredentials = 'omit' | 'same-origin' | 'include';

/**
 * A `fetch` implementation. Node's built-in fetch only accepts a `dispatcher`
 * created by the undici copy it ships internally, so a host that bundles its own
 * undici passes both the dispatcher and the matching fetch here.
 */
export type RequestFetch = (input: string, init?: RequestInit & { dispatcher?: unknown }) => Promise<Response>;

export type RequestConfig<TData = unknown> = {
  baseURL?: string;
  url?: string;
  method?: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE' | 'OPTIONS' | 'HEAD';
  params?: Record<string, unknown> | undefined;
  data?: TData | FormData;
  responseType?: 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream';
  signal?: AbortSignal;
  /** Node fetch dispatcher (undici ProxyAgent) for hosts behind a proxy. */
  dispatcher?: unknown;
  /** Fetch implementation that understands `dispatcher`; defaults to global fetch. */
  fetchImpl?: RequestFetch;
  headers?: [string, string][] | Record<string, string>;
  credentials?: RequestCredentials;
};

export type ResponseConfig<TData = unknown> = {
  data: TData;
  status: number;
  statusText: string;
  headers: Headers;
};

/**
 * The error type a generated operation *declares* for one status code, used only
 * as the second type argument of `Client` (e.g. `ResponseErrorConfig<RepoGet404>`).
 *
 * It is documentation, not a runtime contract: this client never throws it. Every
 * failure surfaces as a plain `Error` whose message is
 * `Forgejo API error <status>: <detail>` (see below), so a `catch` narrowed to a
 * generated error type reads fields like `errors` or `url` as `undefined`. Catch
 * `Error` and read `message`; the extension host re-classifies it (status, kind,
 * localized text) in `packages/forgejo-toolkit/src/api/errors-core.ts`.
 */
export type ResponseErrorConfig<TError = unknown> = TError;

/**
 * Encodes a single URL path segment so values containing `/`, `#`, `?` or
 * other reserved characters (e.g. branch names like `release/1.0`) do not
 * corrupt the request path.
 *
 * Dot segments are rejected instead of encoded: the URL parser treats `.` and
 * `..` (in literal or percent-encoded form) as path navigation and removes them,
 * so an interpolated `..` would make the request escape its route.
 */
export function encodePathSegment(value: string | number): string {
  const segment = String(value);
  if (segment === '.' || segment === '..') {
    throw new Error(`Unsafe path segment: ${segment}`);
  }
  return encodeURIComponent(segment);
}

const MAX_ERROR_BODY_LENGTH = 500;

const TRUNCATION_SUFFIX = ' (truncated)';

/** Media type without parameters, lowercased (`text/html; charset=utf-8` → `text/html`). */
function mediaType(response: Response): string {
  const value = response.headers.get('content-type');
  return value ? (value.split(';')[0] ?? '').trim().toLowerCase() : '';
}

function describedMediaType(response: Response): string {
  return mediaType(response) || 'unknown content type';
}

function describedBody(response: Response, text: string): string {
  if (!text) {
    return `empty response body (HTTP ${response.status}, ${describedMediaType(response)})`;
  }
  // A reverse proxy answering with an HTML error page used to dump a truncated
  // blob of markup into the message. Name the shape of the response instead:
  // the caller gets something actionable and no more of the body than before.
  if (mediaType(response) !== 'application/json') {
    return `non-JSON response body (HTTP ${response.status}, ${describedMediaType(response)})`;
  }
  const truncated =
    text.length > MAX_ERROR_BODY_LENGTH ? text.slice(0, MAX_ERROR_BODY_LENGTH) + TRUNCATION_SUFFIX : text;
  return `${response.statusText} (${truncated})`;
}

function nonJsonSuccessBodyError(response: Response, text: string): Error {
  return new Error(`Forgejo API error ${response.status}: ${describedBody(response, text)}`);
}

export type Client = <TResponseData, _TError = unknown, TRequestData = unknown>(
  config: RequestConfig<TRequestData>,
) => Promise<ResponseConfig<TResponseData>>;

export function buildUrl(config: RequestConfig): string {
  const normalizedParams = new URLSearchParams();
  Object.entries(config.params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) {
      return;
    }
    if (Array.isArray(value)) {
      // Forgejo API expects collectionFormat: multi — repeat the key per element.
      value.forEach((item) => {
        if (item !== undefined && item !== null) {
          normalizedParams.append(key, String(item));
        }
      });
      return;
    }
    normalizedParams.append(key, String(value));
  });

  const baseURL = (config.baseURL ?? '').replace(/\/$/, '');
  const path = config.url ?? '';
  let targetUrl = `${baseURL}${path}`;

  const query = normalizedParams.toString();
  if (query) {
    targetUrl += `?${query}`;
  }

  return targetUrl;
}

/**
 * Merge header sets left to right into one record.
 *
 * Header names are case-insensitive (RFC 9110 §5.1), so a plain key-equal merge
 * would let `Content-Type` and `content-type` coexist in the result — which
 * undici then serializes as one illegal combined header. A later set overrides
 * an earlier one under case-insensitive comparison, and the *later* spelling of
 * the name is the one kept. `undefined` values are skipped, so a generated
 * operation's optional header never erases a default.
 */
export function mergeHeaders(...headers: Array<RequestConfig['headers'] | undefined>): Record<string, string> {
  const merged: Record<string, string> = {};
  // Lowercased name → the spelling currently in `merged`, so an override under
  // a different casing can drop the earlier spelling rather than duplicate it.
  const spellingByName = new Map<string, string>();
  for (const h of headers) {
    if (!h) {
      continue;
    }
    const entries = Array.isArray(h) ? h : Object.entries(h);
    for (const [key, value] of entries) {
      if (value === undefined) {
        continue;
      }
      const existingSpelling = spellingByName.get(key.toLowerCase());
      if (existingSpelling !== undefined && existingSpelling !== key) {
        delete merged[existingSpelling];
      }
      spellingByName.set(key.toLowerCase(), key);
      merged[key] = String(value);
    }
  }
  return merged;
}

/**
 * Minimal fetch-based client used by the generated API operations.
 *
 * Contract points a caller must know, because this client deliberately stays
 * thin:
 *
 * - **No built-in timeout.** `config.signal` is forwarded to fetch and nothing
 *   else bounds the request. Callers must supply their own timeout signal
 *   (e.g. `AbortSignal.timeout(...)` or an `AbortController` on a timer);
 *   without one a stalled server holds the request open forever. Inside the
 *   toolkit every production call goes through the host-side `ForgejoClient`,
 *   which applies its own timeout (`API_REQUEST_TIMEOUT_MS`), but this package
 *   is a reusable library and other consumers get no such guard.
 * - **Credentials across redirects.** Callers pass their `Authorization` (or
 *   other credential) header through `config.headers`; it is then safe to send
 *   only because the fetch specification — as implemented by undici, which
 *   backs Node's global fetch — strips the `Authorization` header when a
 *   redirect crosses origins. A non-compliant `fetchImpl` would break that
 *   guarantee, so a custom implementation must follow the same rule.
 */
export const client: Client = async <TResponseData, _TError = unknown, TRequestData = unknown>(
  paramsConfig: RequestConfig<TRequestData>,
): Promise<ResponseConfig<TResponseData>> => {
  const targetUrl = buildUrl(paramsConfig);

  const headers = mergeHeaders({ Accept: 'application/json' }, paramsConfig.headers);

  const body =
    paramsConfig.data instanceof FormData
      ? paramsConfig.data
      : // A string body is sent verbatim (e.g. renderMarkdownRaw's text/plain
        // payload): JSON.stringify would wrap it in quotes and contradict the
        // operation's declared content type.
        typeof paramsConfig.data === 'string'
        ? paramsConfig.data
        : // Explicit null/undefined check: falsy values like 0 or false are
          // legitimate JSON bodies and must not be dropped.
          paramsConfig.data !== undefined && paramsConfig.data !== null
          ? JSON.stringify(paramsConfig.data)
          : undefined;

  if (body !== undefined && !(paramsConfig.data instanceof FormData) && typeof paramsConfig.data !== 'string') {
    // Set the JSON Content-Type only when the caller did not supply one under
    // any casing: assigning the key directly would both override an
    // operation's own content type (e.g. renderMarkdownRaw's text/plain) and
    // let `Content-Type`/`content-type` coexist, bypassing the case-insensitive
    // dedup mergeHeaders applies. A string body gets no default either — fetch
    // applies its own text/plain for those.
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }

  // A dispatcher is only understood by the fetch that shares its undici copy, so
  // the caller supplies the pair together. A dispatcher without its fetch is
  // dropped rather than handed to global fetch, which would reject the foreign
  // handler ("invalid onRequestStart method") and fail the request.
  const useDispatcher = Boolean(paramsConfig.dispatcher && paramsConfig.fetchImpl);
  const doFetch: RequestFetch = useDispatcher ? (paramsConfig.fetchImpl as RequestFetch) : (fetch as RequestFetch);

  const response = await doFetch(targetUrl, {
    credentials: paramsConfig.credentials || 'same-origin',
    method: paramsConfig.method?.toUpperCase(),
    body,
    signal: paramsConfig.signal,
    headers,
    ...(useDispatcher ? { dispatcher: paramsConfig.dispatcher } : {}),
  } as RequestInit & { dispatcher?: unknown });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    // Error responses can be huge (e.g. an HTML page from a reverse proxy),
    // so the body embedded in the error message is capped — and a body that is
    // not JSON is described rather than quoted.
    throw new Error(`Forgejo API error ${response.status}: ${describedBody(response, text)}`);
  }

  let data: TResponseData;
  if ([204, 205, 304].includes(response.status)) {
    data = {} as TResponseData;
  } else {
    const responseType = paramsConfig.responseType ?? 'json';
    if (responseType === 'text') {
      data = (await response.text()) as unknown as TResponseData;
    } else if (responseType === 'arraybuffer') {
      data = (await response.arrayBuffer()) as unknown as TResponseData;
    } else if (responseType === 'stream') {
      // Hand the raw body to the caller for streaming consumers (e.g. large
      // artifact downloads piped straight to disk).
      data = response.body as unknown as TResponseData;
    } else if (responseType === 'blob') {
      data = (await response.blob()) as unknown as TResponseData;
    } else {
      const text = await response.text();
      if (!text) {
        data = {} as TResponseData;
      } else {
        try {
          data = JSON.parse(text) as unknown as TResponseData;
        } catch {
          // A 200 that is not JSON (a proxy's HTML page, a plain-text body) is
          // a failure the caller must see, not a silent `undefined`.
          throw nonJsonSuccessBodyError(response, text);
        }
      }
    }
  }

  return {
    data,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
};

export default client;
