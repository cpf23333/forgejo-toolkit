// A real local OpenAI-compatible endpoint for the dev host.
//
// Why this is a socket rather than one more MSW handler: MSW is *in-process*
// interception. It would happily answer a request to the model endpoint, and the
// walkthrough would then prove nothing about the thing it exists for — that the
// extension's second transport reaches a real HTTP server, over a real socket,
// with a real event stream arriving in pieces. So this file owns an
// `http.Server` and nothing here knows about MSW.
//
// What it serves (`docs/design/ai-model-transport.md` §15):
//
//   GET  /models              the OpenAI list shape, two models
//   POST /chat/completions    an SSE answer by default, openai-shaped chunks,
//                             one `data: [DONE]` terminator
//   GET  /__mock/requests     what this endpoint has seen, for the walkthrough
//
// Every route also answers under a `/v1` prefix, because the seeded provider's
// base URL carries one (the common OpenAI spelling) while a bare base URL is a
// mistake the transport is expected to report. Both therefore have to work here.
//
// The properties that make it usable as evidence rather than as decoration:
//
//   * **Genuine streaming.** The answer is written in several `res.write` calls
//     separated by {@link AiMockServerOptions.chunkDelayMs}, so a client that
//     buffers the whole body fails the timing assertion in `aiMockServer.test.ts`
//     (and passes only if the chunks really arrive apart).
//   * **The error shapes the transport renders** (401/403/429/5xx) plus one
//     deliberately unparseable `data:` line inside the normal stream, which
//     §6.4 item 3 says must be skipped and counted rather than fail the run.
//   * **Loopback only.** The bind address is the loopback literal and is never
//     configurable to a wildcard: this endpoint must not be reachable from
//     another machine, and that is a policy this file states rather than a value
//     a caller passes in.
//
// The scenario switch is a query parameter (`?scenario=429`) or the
// `x-ai-mock-scenario` header. A query parameter is the useful one for the
// walkthrough: the transport appends its path to the base URL but keeps the base
// URL's query string, so `…/v1?scenario=429` makes every request to that endpoint
// take the 429 path without touching any code.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Where this endpoint binds. The loopback literal is the policy itself — "this
 * server is reachable only from this machine" — so it is not a caller-supplied
 * value and not an example address (`AGENTS.md`'s address-pattern exception).
 */
export const AI_MOCK_HOST = '127.0.0.1';

/** The marker `/__mock/requests` answers with, so a caller can prove *which* server replied. */
export const AI_MOCK_IDENTITY = 'ui-review-ai-mock';

export const AI_MOCK_MODELS_PATH = '/models';
export const AI_MOCK_COMPLETIONS_PATH = '/chat/completions';
export const AI_MOCK_REQUESTS_PATH = '/__mock/requests';

/** The model id the seeded provider binds. */
export const AI_MOCK_MODEL_ID = 'mock-pre-review';

/** What `/models` lists: the model above, plus a second one so a count is not hard-coded to 1. */
export const AI_MOCK_MODEL_IDS: readonly string[] = [AI_MOCK_MODEL_ID, 'mock-second-model'];

/** The display name the seeded provider gives that model. */
export const AI_MOCK_MODEL_NAME = 'Mock pre-review model';

/** Gap between two streamed chunks. Long enough to be visible, short enough to walk. */
export const AI_MOCK_DEFAULT_CHUNK_DELAY_MS = 60;

/**
 * How long the `stall` scenario holds the socket open before giving up.
 *
 * Longer than the transport's default idle window (30 s) on purpose: the
 * walkthrough of `forgejoToolkit.aiModelRequestTimeoutMs` is "the client gives up
 * first", and this bound only exists so a forgotten socket cannot leak forever.
 */
export const AI_MOCK_DEFAULT_STALL_MS = 60_000;

/**
 * The scenarios this endpoint understands, in the order the README lists them.
 *
 * `stream` is the default. The five numeric ones are HTTP failures, `json` is the
 * non-streaming fallback (§6.4 item 7), `reasoning`, `truncated`, `stall` and
 * `clean-stream` are the stream shapes the transport has to keep apart.
 */
export const AI_MOCK_SCENARIOS: readonly string[] = [
  'stream',
  'clean-stream',
  'json',
  'reasoning',
  'truncated',
  'stall',
  '401',
  '403',
  '429',
  '500',
  '503',
];

export type AiMockScenario = (typeof AI_MOCK_SCENARIOS)[number];

export function isAiMockScenario(value: string): value is AiMockScenario {
  return AI_MOCK_SCENARIOS.includes(value);
}

/**
 * The one comment the default answer proposes.
 *
 * It is anchored to the mock fixtures' pull request (`src/index.ts`, added line 2
 * in `mockPullRequestDiff`), so a walkthrough that runs the pre-review against
 * the offline fixtures sees a comment whose anchor is *valid* rather than one the
 * validator drops — the difference between "the endpoint answered" and "the
 * endpoint answered something the feature could use". The body says where it came
 * from, because a draft review comment is user-visible text.
 */
export const AI_MOCK_REVIEW_COMMENT = {
  path: 'src/index.ts',
  line: 2,
  side: 'head',
  extraLines: 0,
  body:
    '[local mock endpoint] The added console.log on line 2 looks like leftover debugging; remove it before ' +
    "merging. This comment was produced by tools/ui-review's mock endpoint, not by a model.",
} as const;

/** The contracted answer shape the AI pre-review parses (`{"comments":[…]}`), as one string. */
export const AI_MOCK_REVIEW_ANSWER = JSON.stringify({ comments: [AI_MOCK_REVIEW_COMMENT] });

/** The reasoning-channel prose the `reasoning` scenario streams beside the answer. */
const AI_MOCK_REASONING_FRAGMENTS: readonly string[] = [
  'Looking at the changed lines first.',
  'The added statement writes to the console.',
];

/**
 * The answer cut in half, for the `truncated` scenario: long enough to be
 * recognisably a partial answer, short enough that it cannot parse as JSON.
 */
const AI_MOCK_TRUNCATED_ANSWER_FRAGMENTS: readonly string[] = [
  '{"comments":[{"path":"src/index.ts","line":2,"side":"h',
];

/** One request the endpoint handled, as `/__mock/requests` reports it. */
export interface AiMockRequestRecord {
  /** ISO timestamp of the request's arrival. */
  at: string;
  method: string;
  /** The path as requested, including the `/v1` prefix when the client sent one. */
  path: string;
  scenario: AiMockScenario;
  status: number;
  /** `sse` when the answer was an event stream, `json` otherwise. */
  shape: 'sse' | 'json';
  /** Chunks written so far (a live count: an in-flight stream shows what it has written). */
  chunks: number;
  bytes: number;
  model?: string;
}

export interface AiMockServerOptions {
  /**
   * The port to bind. `0` (the default) lets the OS pick a free one, which is
   * what the harness uses: a fixed port would collide with whatever else this
   * machine runs, and this endpoint's whole job is to be reachable *right now*.
   */
  port?: number;
  /** Gap between streamed chunks (default {@link AI_MOCK_DEFAULT_CHUNK_DELAY_MS}). */
  chunkDelayMs?: number;
  /** How long the `stall` scenario holds the socket (default {@link AI_MOCK_DEFAULT_STALL_MS}). */
  stallMs?: number;
  /** A sink for the server's own request log lines. */
  onLog?: (line: string) => void;
}

export interface AiMockServer {
  host: string;
  port: number;
  /** `http://<host>:<port>` — no trailing slash, no `/v1`. */
  url: string;
  /**
   * Every request handled, oldest first, live. Read by `/__mock/requests`, by the
   * `ai-mock requests` command and by the tests.
   */
  requests: readonly AiMockRequestRecord[];
  close(): Promise<void>;
}

/** How long `close()` waits for in-flight streams before cutting their sockets. */
const CLOSE_GRACE_MS = 500;

/** A URL path without its optional `/v1` prefix, so both base URL shapes route the same. */
export function normalizeAiMockRoute(pathname: string): string {
  const withoutVersion = pathname.replace(/^\/v1(?=\/|$)/, '');
  return withoutVersion === '' ? '/' : withoutVersion;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  response.end(text);
}

/**
 * The OpenAI-shaped failure body, with a sentence that says it is deliberate.
 *
 * The wording matters for the walkthrough: a 500 rendered with a *bounded excerpt*
 * of the endpoint's own message (§6.5) is only recognisable as this endpoint if
 * the message says so.
 */
function sendScenarioError(response: http.ServerResponse, status: number): void {
  const reason =
    status === 401
      ? 'the credential you sent was rejected'
      : status === 403
        ? 'this credential may not use this model'
        : status === 429
          ? 'the rate limit was reached'
          : 'the endpoint failed on purpose';
  sendJson(response, status, {
    error: {
      message: `mock endpoint: ${reason} (deliberate HTTP ${status} from the scenario switch)`,
      type: status === 429 ? 'rate_limit_error' : 'invalid_request_error',
      code: status,
    },
  });
}

/** A `data:` line carrying one openai-shaped chunk. */
function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** The one line in the default stream that no client can parse, on purpose (§6.4 item 3). */
const AI_MOCK_UNPARSEABLE_DATA_LINE = 'data: {this line is deliberately not JSON\n\n';

function modelListBody(): unknown {
  return {
    object: 'list',
    data: AI_MOCK_MODEL_IDS.map((id) => ({ id, object: 'model', created: 0, owned_by: AI_MOCK_IDENTITY })),
  };
}

/** Splits a text into `count` roughly equal fragments, so the answer arrives in pieces. */
function fragmentText(text: string, count: number): string[] {
  const size = Math.ceil(text.length / count);
  const fragments: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    fragments.push(text.slice(index, index + size));
  }
  return fragments;
}

/**
 * One completion as SSE lines — a list rather than a stream, because the shape is
 * what the tests assert and the delay is applied by the writer.
 */
function streamLinesFor(scenario: AiMockScenario, model: string): string[] {
  const id = `chatcmpl-mock-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
    sseChunk({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });

  const answer = fragmentText(AI_MOCK_REVIEW_ANSWER, 4).map((text) => chunk({ content: text }));
  const lines: string[] = [];
  if (scenario === 'reasoning') {
    // The reasoning channel is its own candidate stream (§6.4 item 4); the answer
    // still travels on `content`, so the run's contract arbitration has both.
    lines.push(...AI_MOCK_REASONING_FRAGMENTS.map((text) => chunk({ reasoning_content: text })));
    lines.push(...answer);
  } else if (scenario === 'truncated') {
    lines.push(...AI_MOCK_TRUNCATED_ANSWER_FRAGMENTS.map((text) => chunk({ content: text })));
  } else {
    lines.push(...answer);
    if (scenario !== 'clean-stream') {
      // Written *between* two real fragments, which is the only place a skipped
      // line can appear without hiding whether the answer still arrives.
      lines.splice(1, 0, AI_MOCK_UNPARSEABLE_DATA_LINE);
    }
  }
  lines.push(chunk({}, scenario === 'truncated' ? 'length' : 'stop'));
  lines.push('data: [DONE]\n\n');
  return lines;
}

function completionBodyFor(scenario: AiMockScenario, model: string): unknown {
  const truncated = scenario === 'truncated';
  const content = truncated ? AI_MOCK_TRUNCATED_ANSWER_FRAGMENTS.join('') : AI_MOCK_REVIEW_ANSWER;
  return {
    id: `chatcmpl-mock-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: truncated ? 'length' : 'stop',
      },
    ],
  };
}

/** Writes the SSE response head: no `Content-Length`, so each write is its own chunk. */
function writeSseHead(response: http.ServerResponse): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Several proxies buffer an event stream unless told not to; saying so keeps
    // "the chunks arrived apart" a property of this server rather than of a cache.
    'X-Accel-Buffering': 'no',
  });
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A body this endpoint cannot read is not a reason to fail the request: the
    // model id is the only field it uses, and it has a default.
    return {};
  }
}

/**
 * Starts the endpoint, bound to {@link AI_MOCK_HOST}.
 *
 * The returned promise rejects when the bind fails — `EADDRINUSE` for a port that
 * is taken, `EACCES` for one this user may not bind — with a message naming the
 * address it tried, because "the mock endpoint did not start" is exactly the
 * failure a caller must not swallow (`aiMockServer.test.ts` asserts both the
 * rejection and the port in the message).
 */
export async function startAiMockServer(options: AiMockServerOptions = {}): Promise<AiMockServer> {
  const host = AI_MOCK_HOST;
  const port = options.port ?? 0;
  const chunkDelayMs = options.chunkDelayMs ?? AI_MOCK_DEFAULT_CHUNK_DELAY_MS;
  const stallMs = options.stallMs ?? AI_MOCK_DEFAULT_STALL_MS;
  const onLog = options.onLog ?? ((): void => {});
  const requests: AiMockRequestRecord[] = [];

  const resolveScenario = (url: URL, header: string | string[] | undefined): AiMockScenario | undefined => {
    const raw = url.searchParams.get('scenario') ?? (Array.isArray(header) ? header[0] : header);
    if (raw === undefined || raw === null || raw === '') {
      return 'stream';
    }
    return isAiMockScenario(raw) ? raw : undefined;
  };

  /** Writes `lines` one at a time, `chunkDelayMs` apart, updating the record as it goes. */
  const streamLines = async (
    response: http.ServerResponse,
    record: AiMockRequestRecord,
    lines: readonly string[],
  ): Promise<void> => {
    record.shape = 'sse';
    writeSseHead(response);
    for (const [index, line] of lines.entries()) {
      if (response.destroyed || response.writableEnded) {
        return;
      }
      if (index > 0) {
        await sleep(chunkDelayMs);
      }
      response.write(line);
      record.chunks += 1;
      record.bytes += Buffer.byteLength(line);
    }
    response.end();
  };

  const handle = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    // A client that aborts mid-stream (the transport's own cancellation, or its
    // idle watchdog) makes the next write fail; without a listener that surfaces
    // as an unhandled 'error' event and would take the whole endpoint down.
    response.on('error', (error: Error) => {
      onLog(`!! ${request.method ?? 'GET'} ${request.url ?? '/'}: ${error.message}`);
    });

    const method = request.method ?? 'GET';
    const requested = request.url ?? '/';
    const url = new URL(requested, `http://${host}`);
    const route = normalizeAiMockRoute(url.pathname);
    onLog(`>> ${method} ${requested}`);

    if (route === AI_MOCK_REQUESTS_PATH && method === 'GET') {
      sendJson(response, 200, {
        id: AI_MOCK_IDENTITY,
        object: 'list',
        count: requests.length,
        requests,
      });
      return;
    }

    const scenario = resolveScenario(url, request.headers['x-ai-mock-scenario']);
    if (scenario === undefined) {
      sendJson(response, 400, {
        error: {
          message: `mock endpoint: unknown scenario "${url.searchParams.get('scenario') ?? ''}"; known: ${AI_MOCK_SCENARIOS.join(', ')}`,
          type: 'invalid_request_error',
        },
      });
      onLog('<< 400 unknown scenario');
      return;
    }

    const record: AiMockRequestRecord = {
      at: new Date().toISOString(),
      method,
      path: requested,
      scenario,
      status: 200,
      // JSON until a completion actually streams: `/models`, every failure route
      // and the non-streaming answer are all documents.
      shape: 'json',
      chunks: 0,
      bytes: 0,
    };
    requests.push(record);

    // A numeric scenario is an HTTP failure, whichever route asked for it; only
    // the five statuses in AI_MOCK_SCENARIOS reach this branch.
    const failureStatus = Number(scenario);
    if (Number.isInteger(failureStatus) && failureStatus >= 100 && failureStatus < 600) {
      record.status = failureStatus;
      sendScenarioError(response, failureStatus);
      onLog(`<< ${failureStatus} ${method} ${requested} (scenario)`);
      return;
    }

    if (route === AI_MOCK_MODELS_PATH) {
      if (method !== 'GET') {
        response.writeHead(405, { Allow: 'GET' });
        response.end();
        record.status = 405;
        onLog(`<< 405 ${method} ${requested}`);
        return;
      }
      const body = modelListBody();
      record.bytes = Buffer.byteLength(JSON.stringify(body));
      sendJson(response, 200, body);
      onLog(`<< 200 ${method} ${requested} (json, ${record.bytes} byte(s))`);
      return;
    }

    if (route !== AI_MOCK_COMPLETIONS_PATH) {
      sendJson(response, 404, {
        error: {
          message: `mock endpoint: no route for ${method} ${url.pathname}; try ${AI_MOCK_MODELS_PATH} or ${AI_MOCK_COMPLETIONS_PATH}`,
          type: 'invalid_request_error',
        },
      });
      record.status = 404;
      onLog(`<< 404 ${method} ${requested}`);
      return;
    }

    if (method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      record.status = 405;
      onLog(`<< 405 ${method} ${requested}`);
      return;
    }

    const body = await readJsonBody(request);
    const model = typeof body.model === 'string' && body.model !== '' ? body.model : AI_MOCK_MODEL_ID;
    record.model = model;

    // `stream: true` is what asks for SSE; an endpoint that answers a document
    // anyway is the case §6.4 item 7 requires the transport to read, which is
    // what `scenario=json` models.
    const wantsStream = body.stream === true && scenario !== 'json';
    if (!wantsStream) {
      const payload = completionBodyFor(scenario, model);
      record.bytes = Buffer.byteLength(JSON.stringify(payload));
      sendJson(response, 200, payload);
      onLog(`<< 200 POST ${requested} (json, ${record.bytes} byte(s), scenario=${scenario})`);
      return;
    }

    if (scenario === 'stall') {
      const lines = streamLinesFor('clean-stream', model).slice(0, 2);
      record.shape = 'sse';
      writeSseHead(response);
      for (const line of lines) {
        response.write(line);
        record.chunks += 1;
        record.bytes += Buffer.byteLength(line);
      }
      onLog(`<< 200 POST ${requested} (sse, stalling for ${stallMs} ms)`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!response.writableEnded) response.end();
          resolve();
        }, stallMs);
        response.on('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return;
    }

    await streamLines(response, record, streamLinesFor(scenario, model));
    onLog(`<< 200 POST ${requested} (sse, ${record.chunks} chunk(s), ${record.bytes} byte(s), scenario=${scenario})`);
  };

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      onLog(`!! ${request.method ?? 'GET'} ${request.url ?? '/'}: ${message}`);
      if (!response.headersSent) {
        sendJson(response, 500, { error: { message: `the mock endpoint failed to answer: ${message}` } });
      } else {
        response.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      reject(
        new Error(
          `cannot bind ${host}:${port} for the mock endpoint (${error.code ?? 'bind failed'}: ${error.message})`,
        ),
      );
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address() as AddressInfo;
  let closePromise: Promise<void> | undefined;
  return {
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    requests,
    close(): Promise<void> {
      closePromise ??= new Promise<void>((resolve, reject) => {
        // An SSE stream that nobody is reading would keep `close()` waiting, so
        // in-flight sockets are cut after a short grace period.
        const grace = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS);
        grace.unref();
        server.close((error) => {
          clearTimeout(grace);
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      });
      return closePromise;
    },
  };
}
