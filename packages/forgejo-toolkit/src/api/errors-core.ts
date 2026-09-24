import { passthroughTranslate, type TranslateFn } from './translate';

export type ApiErrorKind = 'network' | 'timeout' | 'tls' | 'http' | 'unknown' | 'proxy';

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
 * What a failed request was asking for, when the caller knows it.
 *
 * `resource` is a human-readable resource kind (`file or directory`, `branch`,
 * `pull request`, ...) and `owner`/`repo` name the repository the request was
 * scoped to. It carries no request headers and no response body, so it cannot
 * leak the access token; the values are the same ones the caller already sent.
 * A 404 rendering uses it to name what was not found, because one generic
 * message covered a wrong owner, a wrong file path and a genuine permission
 * problem — three situations with three different fixes.
 *
 * `viaProxy` reports that a proxy dispatcher was installed for the request, which
 * turns a connection failure into a proxy problem: "check that the instance is
 * running" sends the user after the wrong host.
 */
export interface RequestResource {
  resource?: string;
  owner?: string;
  repo?: string;
  viaProxy?: boolean;
}

/**
 * Structured wrapper for request failures raised by ForgejoClient. `message`
 * keeps the raw text (e.g. `Forgejo API error 409: ...`) so existing pattern
 * matching and logs keep working; `userMessage` is the localized, displayable
 * rendering produced from `kind`/`status`.
 *
 * `context` is the request the failure belongs to (resource kind, repository
 * scope, whether a proxy was in use); a 404 and a proxied connection failure use
 * it to say what actually went wrong. It never carries headers or a body.
 */
export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly rawMessage: string,
    readonly status?: number,
    readonly context?: RequestResource,
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
export function toApiError(error: unknown, context?: RequestResource): ApiError {
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
    return new ApiError('http', raw, Number(httpMatch[1]), context);
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
    // A connection failure while a proxy is installed is usually the proxy
    // refusing or not resolving, not the instance being down; the network
    // message would point at the wrong host.
    return new ApiError(context?.viaProxy ? 'proxy' : 'network', raw);
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
    case 'proxy':
      return translate(
        'Cannot connect through the configured proxy. Check the proxy URL, that the proxy is reachable, and its credentials; the Forgejo instance itself may be fine.',
      );
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
          return notFoundMessage(error.context);
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
 * Human-readable kind for a repository sub-resource, keyed by the API path
 * segment right after `/<owner>/<repo>/`. A segment absent from this map is used
 * verbatim (de-pluralized), so an endpoint added later still gets a name rather
 * than nothing.
 */
const REPO_RESOURCE_LABELS: Record<string, string> = {
  contents: 'file or directory',
  'git/trees': 'file or directory',
  'git/blobs': 'file',
  commits: 'commit',
  branches: 'branch',
  tags: 'tag',
  releases: 'release',
  labels: 'label',
  milestones: 'milestone',
  issues: 'issue',
  pulls: 'pull request',
  actions: 'Actions resource',
  assignees: 'assignee',
  collaborators: 'collaborator',
  keys: 'deploy key',
  languages: 'language',
  topics: 'topic',
  stargazers: 'stargazer',
  subscribers: 'subscriber',
};

/**
 * The resource kind and repository scope of one API request, derived from its
 * URL. It is what lets a 404 name what was not found instead of covering a wrong
 * owner, a wrong path and a permission problem with one message.
 *
 * Only the request path is read: no header, token or response body is involved,
 * so attaching the result to an ApiError cannot leak anything the caller did not
 * already send. A path that is not repository-scoped (search, notifications, the
 * current user) yields no kind, which keeps the generic 404 rendering.
 */
export function requestResourceFor(url: string): RequestResource | undefined {
  const path = apiPathOf(url);
  if (!path) {
    return undefined;
  }
  if (path[0] === 'repos' && path.length >= 3) {
    const [, owner, repo, ...rest] = path;
    return { resource: repositoryResourceLabel(rest), owner: decodeSegment(owner), repo: decodeSegment(repo) };
  }
  // A non-repository endpoint whose 404 is still worth naming, without claiming
  // a repository scope it does not have.
  if (path[0] === 'users') {
    return { resource: 'user' };
  }
  return undefined;
}

/**
 * The context a failed request is rendered with: what it asked for, plus whether
 * it went through a proxy. `viaProxy` is the only proxy signal available at this
 * layer (the dispatcher itself lives in `proxy.ts`), so the caller that owns the
 * request supplies it. A request with no recognizable resource still gets the
 * proxy flag, which is what keeps a proxy outage from reading as a dead instance.
 */
export function requestContextFor(url: string, options: { viaProxy?: boolean } = {}): RequestResource {
  const resource = requestResourceFor(url);
  return { ...resource, ...(options.viaProxy ? { viaProxy: true } : {}) };
}

/** The `/api/v1/...` segments of a request URL, or undefined for anything else. */
function apiPathOf(url: string): string[] | undefined {
  let segments: string[];
  try {
    segments = new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return undefined;
  }
  const apiIndex = segments.indexOf('api');
  if (apiIndex === -1 || segments[apiIndex + 1] !== 'v1') {
    return undefined;
  }
  return segments.slice(apiIndex + 2);
}

/** The label for the path segments that follow `/<owner>/<repo>/`. */
function repositoryResourceLabel(rest: string[]): string {
  const [first, second] = rest;
  if (first === undefined) {
    return 'repository';
  }
  // Deeper routes nest under a two-word prefix (`git/trees`, `git/blobs`).
  if (second !== undefined && REPO_RESOURCE_LABELS[`${first}/${second}`]) {
    return REPO_RESOURCE_LABELS[`${first}/${second}`];
  }
  // `actions/runs/{id}/jobs` and the rest of the Actions tree are one kind.
  if (first === 'actions') {
    return REPO_RESOURCE_LABELS.actions;
  }
  if (REPO_RESOURCE_LABELS[first]) {
    return REPO_RESOURCE_LABELS[first];
  }
  // An endpoint added after this map still gets a usable name: the segment is
  // already a resource word, just plural.
  return first.length > 1 && first.endsWith('s') ? first.slice(0, -1) : first;
}

/** Path segments arrive percent-encoded; a malformed escape keeps the raw text. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Render a 404 with the resource the caller asked for, so the common causes stay
 * distinguishable: a wrong owner/repository, a repository object that does not
 * exist (a path, branch or number), and a token that cannot see it all answer
 * 404, and each needs a different fix.
 *
 * The fallback keeps the wording that was used for every 404 before the request
 * context was available.
 */
function notFoundMessage(resource?: RequestResource): string {
  if (resource?.owner && resource.repo) {
    return translate(
      'Not found: {0} in {1}/{2}. Check the owner and repo: a wrong owner or repository name and a token without access both answer 404.',
      resource.resource ?? 'the requested resource',
      resource.owner,
      resource.repo,
    );
  }
  if (resource?.resource) {
    return translate(
      'Not found: {0}. The path, ref or index may be wrong, the resource may have been deleted, or the token may not have access.',
      resource.resource,
    );
  }
  return translate('Not found. The resource may have been deleted or is not accessible with this token.');
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
