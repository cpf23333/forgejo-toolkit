/**
 * The seam between the generated (Kubb) client and this repository's shared
 * request layer.
 *
 * Kubb's generated client and the shared client in
 * `packages/shared/src/request/index.ts` build the same request: the generated
 * `resolveRequest` builds the URL from `baseURL` + `url` + the serialized `query`
 * and `path` (through `src/generated/.kubb/serializers.ts`), merges the headers,
 * serializes the body for the declared content type, and hands the result to a
 * *transport*. The shared client is that transport: it owns the `Accept` header,
 * the `dispatcher`/`fetchImpl` proxy pair, response parsing and — the part every
 * caller depends on — turning a non-2xx response (or a 200 whose body is not
 * JSON) into a `RequestError` whose message keeps the
 * `Forgejo API error <status>: <detail>` shape.
 *
 * Wiring it this way keeps `error instanceof RequestError` working in
 * `errors-core.ts` without a single line of generated code being rewritten: the
 * generated operation passes `options.client`, and the bundled client resolves
 * `requestConfig.transport ?? config.transport ?? defaultTransport`.
 *
 * The URL arrives fully built, so `params` is deliberately not forwarded:
 * repeating it would append the serialized query a second time.
 */
import type { ResolvedRequest, Transport, TransportResult } from '@cpf23333-forgejo-toolkit/api/kubb';
import type { RequestConfig, RequestFetch } from '@cpf23333-forgejo-toolkit/shared/request';
import { client as sharedClient, mergeHeaders } from '@cpf23333-forgejo-toolkit/shared/request';

/**
 * The `fetch` pair a proxy needs: the dispatcher only lets itself be used by the
 * undici copy that created it, so the two travel together. Both are read when a
 * request runs, not when the client is built, because the extension installs the
 * configured proxy once during activation (`setDefaultRequestDispatcher`) and a
 * client may have been constructed before that happened.
 */
export interface DispatcherPair {
  dispatcher?: unknown;
  fetchImpl?: RequestFetch;
}

/** What one request runs under: the credential, the proxy pair, and the abort signal. */
export interface SharedTransportOptions {
  /**
   * The credential already formatted for the `Authorization` header, read per
   * request. `undefined` leaves the header off entirely, which is what anonymous
   * access to a public instance needs: an empty `Authorization` value makes some
   * servers reject the request instead of reading it as no credential.
   */
  getAuthorization: () => string | undefined;
  /**
   * The dispatcher pair in force for this request. Read per request rather than
   * captured, for the activation-order reason above.
   */
  resolveDispatcherPair: () => DispatcherPair;
  /** The signal the request runs under, already merged from the caller's, the client's and the timeout. */
  resolveSignal?: (request: ResolvedRequest) => AbortSignal | undefined;
  /**
   * Runs when the request fails, before the error leaves the transport. It is how
   * the host keeps its own error handling: classifying the failure into an
   * `ApiError` and telling the registered host about an auth failure.
   */
  onRequestFailed?: (error: unknown, request: ResolvedRequest) => unknown;
}

/**
 * The `responseType` a resolved request was made under, keyed by the resolved
 * request object itself.
 *
 * Kubb's `Transport` is handed the *resolved* request, so the caller's
 * `RequestConfig` — which is where `responseType` lives — is not in reach. The
 * host's request interceptor runs with both objects and records the pairing
 * here, which is how a `responseType: 'text'` call (CI logs, PR diffs, rendered
 * markdown) reaches the shared client: without it the shared client parses the
 * body as JSON and throws `nonJsonSuccessBodyError` for the plain-text answer
 * such a call exists to receive. Entries are collected with the request object.
 */
const responseTypeByRequest = new WeakMap<ResolvedRequest, RequestConfig['responseType']>();

/** Records the `responseType` a resolved request runs under. Called from the host's request interceptor. */
export function rememberResponseType(request: ResolvedRequest, responseType: RequestConfig['responseType']): void {
  if (responseType !== undefined) {
    responseTypeByRequest.set(request, responseType);
  }
}

/**
 * The dispatcher value passed to the shared client when no proxy is configured.
 *
 * The shared client deliberately drops a `fetchImpl` whose `dispatcher` is
 * missing (a dispatcher is only understood by the `fetch` that shares its undici
 * copy, so the pair travels together). That check is what decides whether the
 * caller's `fetch` is used at all, and this transport has to be the caller's
 * `fetch`: it is the only place the native `Request`/`Response` can be captured.
 * A sentinel satisfies the pair check while the wrapper below still sends through
 * global `fetch` — the sentinel never reaches a wire call, because the wrapper
 * never forwards it.
 */
const DIRECT_FETCH_DISPATCHER = Symbol('forgejo-toolkit.direct-fetch-dispatcher');

/** The URL without its `user:password@` part, for a `Request` rebuilt from a URL the constructor accepts. */
function stripUserinfo(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * The shared request layer as a Kubb `Transport`.
 *
 * It receives a request that is already resolved and serialized, so it re-sends
 * *that* request rather than rebuilding one: the URL is passed through verbatim
 * (no `params`, which would append the serialized query a second time), the body
 * in the form the serializer produced it — which is what keeps a `FormData` body
 * a `FormData` and an urlencoded body a string — and the headers exactly as
 * merged.
 *
 * The native `Request` and `Response` the shared client used are captured by
 * wrapping the `fetch` implementation it is given: the shared client's own
 * `ResponseConfig` deliberately carries only `{ data, status, statusText,
 * headers }`, while a Kubb transport result must carry the native pair
 * (`CallResult.response` is what `_getListPage` reads `X-Total-Count` off, and
 * what the generated `ResponseError` would expose if one were ever built).
 * Wrapping rather than rebuilding keeps the pair the *same* objects the response
 * was parsed from.
 */
export function sharedRequestTransport(options: SharedTransportOptions): Transport {
  return async (request) => {
    const resolved = options.resolveDispatcherPair();
    const usesProxy = Boolean(resolved.dispatcher && resolved.fetchImpl);
    const dispatcher = usesProxy ? resolved.dispatcher : DIRECT_FETCH_DISPATCHER;
    let nativeRequest: TransportResult['request'] | undefined;
    let nativeResponse: TransportResult['response'] | undefined;

    const authorization = options.getAuthorization();
    const config = {
      url: request.url,
      method: request.method,
      headers: mergeHeaders(authorization === undefined ? {} : { Authorization: authorization }, request.headers),
      data: request.body,
      signal: options.resolveSignal?.(request) ?? request.signal,
      credentials: request.credentials,
      responseType: responseTypeByRequest.get(request),
      dispatcher,
    } as RequestConfig;

    try {
      const response = await sharedClient<unknown, unknown, unknown>({
        ...config,
        // Always installed: this is the `fetch` the shared client runs, so it is
        // the only place the native `Request` and `Response` can be captured.
        // Rebuilding the pair from the URL and the body instead would
        // re-serialize the body, which is exactly what must not happen to a
        // `FormData` upload.
        fetchImpl: (async (input: string, init?: RequestInit) => {
          // Capturing the native `Request` must not change how the request
          // fails: a configured instance URL may embed the access token
          // (`https://user:token@host`) and the `Request` constructor refuses
          // such a URL where `fetch` accepts it and reports the same problem
          // itself. The capture is best-effort, the send is not.
          try {
            nativeRequest = new Request(input, init) as TransportResult['request'];
          } catch {
            nativeRequest = undefined;
          }
          const raw = usesProxy
            ? await (resolved.fetchImpl as RequestFetch)(input, init as RequestInit & { dispatcher?: unknown })
            : await fetch(input, init);
          nativeResponse = raw as unknown as TransportResult['response'];
          return raw;
        }) as RequestFetch,
      });

      return {
        data: response.data,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        contentType: response.headers.get('content-type')?.split(';')[0]?.trim() || undefined,
        // `nativeResponse` is always captured: the wrapper above runs on every
        // send, and the shared client returns only after one resolved. The
        // request can be missing in one case — the credential-bearing URL the
        // `Request` constructor refuses (see the wrapper) — so it is rebuilt
        // from the request URL with its userinfo removed. The URL is what a
        // caller reads off the result, and the login/token in it has no business
        // being copied out of the config the user typed it into.
        request: nativeRequest ?? (new Request(stripUserinfo(request.url)) as TransportResult['request']),
        response: nativeResponse as TransportResult['response'],
      };
    } catch (error) {
      // A failure from `onRequestFailed` itself must not be re-classified, so the
      // callback is invoked with the original error and its own throw propagates
      // from here unchanged.
      if (options.onRequestFailed) {
        throw options.onRequestFailed(error, request);
      }
      throw error;
    }
  };
}
