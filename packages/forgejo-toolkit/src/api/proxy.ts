import { FormData as UndiciFormData, ProxyAgent, fetch as undiciFetch } from 'undici';
import type { RequestFetch } from '@cpf23333-forgejo-toolkit/shared/request';

/**
 * The proxy a request should go through, if any.
 *
 * The explicit editor setting wins over the environment, which is what every other
 * tool on the machine reads; `no_proxy` is deliberately not interpreted (the
 * extension talks to a single instance, and silently ignoring a listed host would
 * be worse than honouring the proxy).
 */
export function resolveProxyUrl(env: Record<string, string | undefined>, configured?: string): string | undefined {
  const candidates = [
    configured,
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy,
    env.ALL_PROXY,
    env.all_proxy,
  ];
  for (const candidate of candidates) {
    // A hand-edited settings.json can hold any JSON type for `http.proxy`; a
    // non-string must be ignored rather than throw inside activation.
    const value = typeof candidate === 'string' ? candidate.trim() : undefined;
    if (value) {
      return value;
    }
  }
  return undefined;
}

/**
 * Turns a configured proxy value into a URL `ProxyAgent` accepts.
 *
 * People write `proxy.example.com:8080` in `http.proxy` and the environment, but
 * undici rejects a URL without a scheme, so a scheme is assumed before parsing.
 * Anything unusable (a non-HTTP scheme, a malformed URL) returns undefined: an
 * unusable proxy must fall back to a direct connection rather than throw inside
 * activation, where it would abort the whole extension.
 */
export function normalizeProxyUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  // A scheme is only present with `://`: `proxy.example.com:3128` otherwise
  // looks like a (bogus) protocol to `new URL`.
  const candidate = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

let dispatcher: ProxyAgent | undefined;
let dispatcherProxyUrl: string | undefined;
let dispatcherFetch: RequestFetch | undefined;

/** The `ProxyAgent` for a proxy URL, created once per URL and never throwing. */
export function createProxyDispatcher(proxyUrl?: string): ProxyAgent | undefined {
  if (!proxyUrl) {
    return undefined;
  }
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) {
    // Forget any previously installed agent: an unusable value means "no proxy",
    // not "keep using the last one".
    dispatcher = undefined;
    dispatcherProxyUrl = undefined;
    dispatcherFetch = undefined;
    return undefined;
  }
  if (dispatcher && dispatcherProxyUrl === normalized) {
    return dispatcher;
  }
  try {
    const agent = new ProxyAgent(normalized);
    dispatcher = agent;
    dispatcherProxyUrl = normalized;
    dispatcherFetch = createProxyFetch(agent);
    return dispatcher;
  } catch {
    // A proxy value undici refuses (an unsupported option, an unusable port)
    // leaves the extension without a proxy instead of failing activation.
    dispatcher = undefined;
    dispatcherProxyUrl = undefined;
    dispatcherFetch = undefined;
    return undefined;
  }
}

/**
 * `fetch` that sends the request through `dispatcher`.
 *
 * `dispatcher` is a Node-only fetch option, and only the undici copy that created
 * the agent understands the handler it passes: Node's built-in fetch ships a
 * different undici major and fails the request with "invalid onRequestStart
 * method". Proxied requests therefore go through the bundled undici. Its
 * `FormData` is a separate class from the global one as well, so multipart bodies
 * are rebuilt with it (undici converts the global `Blob`/`File` entries itself).
 */
export function createProxyFetch(agent: ProxyAgent): RequestFetch {
  return async (input, init) => {
    const body = init?.body;
    const normalizedBody = body instanceof FormData ? await toUndiciFormData(body) : body;
    const response = await undiciFetch(input, {
      ...init,
      body: normalizedBody,
      dispatcher: agent,
    } as unknown as Parameters<typeof undiciFetch>[1]);
    return response as unknown as Response;
  };
}

/**
 * The fetch a host-side request should use to honour the configured proxy, or
 * undefined when no proxy is active (callers then use global fetch).
 */
export function getProxyFetch(): RequestFetch | undefined {
  return dispatcherFetch;
}

async function toUndiciFormData(source: FormData): Promise<UndiciFormData> {
  const target = new UndiciFormData();
  for (const [name, value] of source.entries()) {
    if (typeof value === 'string') {
      target.append(name, value);
      continue;
    }
    target.append(name, value as unknown as Blob, (value as File).name || 'file');
  }
  return target;
}
