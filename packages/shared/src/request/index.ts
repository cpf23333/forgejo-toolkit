/**
 * Shared fetch client types used by generated API clients.
 */

export type RequestCredentials = 'omit' | 'same-origin' | 'include';

export type RequestConfig<TData = unknown> = {
  baseURL?: string;
  url?: string;
  method?: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE' | 'OPTIONS' | 'HEAD';
  params?: Record<string, unknown> | undefined;
  data?: TData | FormData;
  responseType?: 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream';
  signal?: AbortSignal;
  headers?: [string, string][] | Record<string, string>;
  credentials?: RequestCredentials;
};

export type ResponseConfig<TData = unknown> = {
  data: TData;
  status: number;
  statusText: string;
  headers: Headers;
};

export type ResponseErrorConfig<TError = unknown> = TError;

/**
 * Encodes a single URL path segment so values containing `/`, `#`, `?` or
 * other reserved characters (e.g. branch names like `release/1.0`) do not
 * corrupt the request path.
 */
export function encodePathSegment(value: string | number): string {
  return encodeURIComponent(String(value));
}

const MAX_ERROR_BODY_LENGTH = 500;

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

export function mergeHeaders(...headers: Array<RequestConfig['headers'] | undefined>): Record<string, string> {
  return headers.reduce<Record<string, string>>((merged, h) => {
    if (!h) {
      return merged;
    }
    const entries = Array.isArray(h) ? h : Object.entries(h);
    entries.forEach(([key, value]) => {
      if (value !== undefined) {
        merged[key] = String(value);
      }
    });
    return merged;
  }, {});
}

export const client: Client = async <TResponseData, _TError = unknown, TRequestData = unknown>(
  paramsConfig: RequestConfig<TRequestData>,
): Promise<ResponseConfig<TResponseData>> => {
  const targetUrl = buildUrl(paramsConfig);

  const headers = mergeHeaders({ Accept: 'application/json' }, paramsConfig.headers);

  const body =
    paramsConfig.data instanceof FormData
      ? paramsConfig.data
      : // Explicit null/undefined check: falsy values like 0, '', or false are
        // legitimate JSON bodies and must not be dropped.
        paramsConfig.data !== undefined && paramsConfig.data !== null
        ? JSON.stringify(paramsConfig.data)
        : undefined;

  if (body !== undefined && !(paramsConfig.data instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(targetUrl, {
    credentials: paramsConfig.credentials || 'same-origin',
    method: paramsConfig.method?.toUpperCase(),
    body,
    signal: paramsConfig.signal,
    headers,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    // Error responses can be huge (e.g. an HTML page from a reverse proxy),
    // so the body embedded in the error message is capped.
    const truncated =
      text.length > MAX_ERROR_BODY_LENGTH ? `${text.slice(0, MAX_ERROR_BODY_LENGTH)} (truncated)` : text;
    throw new Error(`Forgejo API error ${response.status}: ${truncated || response.statusText}`);
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
      data = text ? (JSON.parse(text) as unknown as TResponseData) : ({} as TResponseData);
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
