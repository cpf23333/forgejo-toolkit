import { ProxyAgent } from 'undici';

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
    const value = candidate?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

let dispatcher: ProxyAgent | undefined;
let dispatcherProxyUrl: string | undefined;

/** The `ProxyAgent` for a proxy URL, created once per URL. */
export function createProxyDispatcher(proxyUrl?: string): ProxyAgent | undefined {
  if (!proxyUrl) {
    return undefined;
  }
  if (!dispatcher || dispatcherProxyUrl !== proxyUrl) {
    dispatcher = new ProxyAgent(proxyUrl);
    dispatcherProxyUrl = proxyUrl;
  }
  return dispatcher;
}
