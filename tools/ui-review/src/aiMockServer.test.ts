// Tests for the local OpenAI-compatible endpoint (`src/aiMockServer.ts`).
//
// Every assertion here is made against a real socket: the server binds a port and
// the test fetches it, which is the whole point of the file — a mock that answered
// in-process would prove nothing about what the harness needs (the extension
// reaching an HTTP endpoint over the loopback interface).
//
// What is pinned, and what would rot silently without it:
//
//  1. the SSE answer **really streams**: the chunks must arrive at different
//     times, so a client that buffered the body cannot pass (§15's reason for a
//     real endpoint);
//  2. the openai-shaped fields the transport reads (`choices[0].delta.content`,
//     `delta.reasoning_content`, `finish_reason`), the `data: [DONE]` terminator,
//     and the one unparseable `data:` line §6.4 item 3 requires to be skipped
//     instead of failing the run;
//  3. every failure shape the transport renders (401/403/429/5xx) plus the three
//     protocol mistakes (unknown scenario, unknown route, wrong method);
//  4. a bind failure is a rejection that names the address it tried, never
//     silence.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AI_MOCK_MODEL_IDS,
  AI_MOCK_REQUESTS_PATH,
  AI_MOCK_REVIEW_ANSWER,
  AI_MOCK_SCENARIOS,
  isAiMockScenario,
  normalizeAiMockRoute,
  startAiMockServer,
  type AiMockServer,
} from './aiMockServer';

/** Every test gets its own endpoint (port 0) and always closes it. */
async function withMockServer<T>(
  options: Parameters<typeof startAiMockServer>[0],
  body: (server: AiMockServer) => Promise<T>,
): Promise<T> {
  const server = await startAiMockServer(options);
  try {
    return await body(server);
  } finally {
    await server.close();
  }
}

interface StreamReading {
  status: number;
  contentType: string | null;
  text: string;
  /** Milliseconds from the request to each body chunk that arrived. */
  arrivalsMs: number[];
}

/** POSTs a completion and reads the body chunk by chunk, timing each arrival. */
async function readCompletion(server: AiMockServer, query = '', stream = true): Promise<StreamReading> {
  const started = Date.now();
  const response = await fetch(`${server.url}/v1/chat/completions${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ model: 'mock-pre-review', messages: [{ role: 'user', content: 'review this' }], stream }),
  });
  const arrivalsMs: number[] = [];
  const decoder = new TextDecoder();
  let text = '';
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      arrivalsMs.push(Date.now() - started);
      text += decoder.decode(step.value, { stream: true });
    }
  }
  return { status: response.status, contentType: response.headers.get('content-type'), text, arrivalsMs };
}

function dataLines(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('data: '));
}

interface ParsedChunks {
  /** The text candidate, as the transport would join it. */
  content: string;
  /** The reasoning candidate, as the transport would join it. */
  reasoning: string;
  /** The last `finish_reason` any chunk carried. */
  finishReason: string | null;
  /** `data:` payloads that did not parse (the deliberate one, normally). */
  unparseable: number;
  /** Whether the stream ended with `data: [DONE]`. */
  done: boolean;
}

function parseChunks(text: string): ParsedChunks {
  const lines = dataLines(text);
  const done = lines.at(-1) === 'data: [DONE]';
  const payloads = done ? lines.slice(0, -1) : lines;
  const result: ParsedChunks = { content: '', reasoning: '', finishReason: null, unparseable: 0, done };
  for (const line of payloads) {
    let payload: unknown;
    try {
      payload = JSON.parse(line.slice('data: '.length));
    } catch {
      result.unparseable += 1;
      continue;
    }
    const choice = (payload as { choices?: Array<Record<string, unknown>> }).choices?.[0];
    const delta = (choice?.delta ?? {}) as Record<string, unknown>;
    if (typeof delta.content === 'string') result.content += delta.content;
    if (typeof delta.reasoning_content === 'string') result.reasoning += delta.reasoning_content;
    if (typeof choice?.finish_reason === 'string') result.finishReason = choice.finish_reason;
  }
  return result;
}

test('GET /models answers the OpenAI list shape, with and without a /v1 prefix', async () => {
  await withMockServer({}, async (server) => {
    for (const path of ['/models', '/v1/models']) {
      const response = await fetch(`${server.url}${path}`);
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { object: string; data: Array<{ id: string }> };
      assert.equal(payload.object, 'list');
      assert.deepEqual(
        payload.data.map((model) => model.id),
        [...AI_MOCK_MODEL_IDS],
        `${path} must list the models the seeded provider declares`,
      );
    }
    assert.equal(server.requests.length, 2);
    assert.deepEqual(
      server.requests.map((record) => [record.method, record.path, record.status, record.shape]),
      [
        ['GET', '/models', 200, 'json'],
        ['GET', '/v1/models', 200, 'json'],
      ],
    );
  });
});

test('the default answer streams openai-shaped chunks over time and ends with [DONE]', async () => {
  await withMockServer({ chunkDelayMs: 50 }, async (server) => {
    const reading = await readCompletion(server, '', true);
    assert.equal(reading.status, 200);
    assert.match(reading.contentType ?? '', /^text\/event-stream/);

    const parsed = parseChunks(reading.text);
    assert.equal(parsed.done, true, 'the stream must end with data: [DONE]');
    // The answer aggregates to the contracted JSON, so a feature reading it can
    // actually use it; the unparseable line is skipped, not fatal.
    assert.equal(parsed.content, AI_MOCK_REVIEW_ANSWER);
    assert.equal(parsed.unparseable, 1, 'exactly the one deliberately malformed data: line');
    assert.equal(parsed.finishReason, 'stop');

    // A client that buffers the whole body cannot pass: the chunks arrived at
    // different times. Seven writes 50 ms apart is ~300 ms; half of that is slack
    // for a slow machine, and a buffered body would show a spread near zero.
    assert.ok(reading.arrivalsMs.length >= 5, `expected several body chunks, got ${reading.arrivalsMs.length}`);
    const spread = (reading.arrivalsMs.at(-1) ?? 0) - (reading.arrivalsMs[0] ?? 0);
    assert.ok(
      spread >= 150,
      `expected the answer to arrive over time, got a spread of ${spread} ms across ${reading.arrivalsMs.length} chunk(s)`,
    );

    const record = server.requests.at(-1);
    assert.equal(record?.shape, 'sse');
    assert.equal(record?.model, 'mock-pre-review');
    assert.ok((record?.chunks ?? 0) >= 5, 'the request log counts the streamed chunks');
    assert.ok((record?.bytes ?? 0) > 0);
  });
});

test('scenario=clean-stream is the same answer without the unparseable line', async () => {
  await withMockServer({ chunkDelayMs: 10 }, async (server) => {
    const parsed = parseChunks((await readCompletion(server, '?scenario=clean-stream')).text);
    assert.equal(parsed.unparseable, 0);
    assert.equal(parsed.content, AI_MOCK_REVIEW_ANSWER);
    assert.equal(parsed.done, true);
  });
});

test('the reasoning scenario keeps the two candidate streams apart', async () => {
  await withMockServer({ chunkDelayMs: 10 }, async (server) => {
    const parsed = parseChunks((await readCompletion(server, '?scenario=reasoning')).text);
    assert.ok(parsed.reasoning.length > 0, 'reasoning_content chunks must be present');
    assert.equal(parsed.content, AI_MOCK_REVIEW_ANSWER, 'the text candidate carries the answer and only it');
    assert.ok(
      !parsed.content.includes(parsed.reasoning.slice(0, 12)),
      'the reasoning text must never be concatenated into the text candidate',
    );
  });
});

test('the truncated scenario reports finish_reason=length and an incomplete answer', async () => {
  await withMockServer({ chunkDelayMs: 10 }, async (server) => {
    const parsed = parseChunks((await readCompletion(server, '?scenario=truncated')).text);
    assert.equal(parsed.finishReason, 'length');
    assert.equal(parsed.done, true);
    assert.ok(parsed.content.length > 0);
    assert.notEqual(parsed.content, AI_MOCK_REVIEW_ANSWER);
    assert.throws(() => JSON.parse(parsed.content), 'a truncated answer is not the contracted JSON');
  });
});

test('scenario=json answers one document even though the request asked for a stream', async () => {
  await withMockServer({}, async (server) => {
    const reading = await readCompletion(server, '?scenario=json', true);
    assert.equal(reading.status, 200);
    assert.match(reading.contentType ?? '', /^application\/json/);
    const payload = JSON.parse(reading.text) as {
      object: string;
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };
    assert.equal(payload.object, 'chat.completion');
    assert.equal(payload.choices[0]?.message.content, AI_MOCK_REVIEW_ANSWER);
    assert.equal(payload.choices[0]?.finish_reason, 'stop');

    // Not asking for a stream gets a document too, which is what a real endpoint
    // does and what the transport's non-streaming fallback exists for.
    const withoutStream = await readCompletion(server, '', false);
    assert.match(withoutStream.contentType ?? '', /^application\/json/);
  });
});

test('the failure scenarios answer the transport-facing HTTP error shapes', async () => {
  await withMockServer({}, async (server) => {
    for (const status of [401, 403, 429, 500, 503]) {
      const response = await fetch(`${server.url}/v1/chat/completions?scenario=${status}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'mock-pre-review', stream: true }),
      });
      assert.equal(response.status, status);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
      const payload = (await response.json()) as { error: { message: string; code: number } };
      assert.equal(payload.error.code, status);
      assert.match(
        payload.error.message,
        new RegExp(`deliberate HTTP ${status}`),
        'the message has to be recognisable as this endpoint when the transport quotes it',
      );
    }
    // The same switch applies to `/models`, so "the endpoint is in this state" is
    // one fact rather than one per route.
    const models = await fetch(`${server.url}/v1/models?scenario=401`);
    assert.equal(models.status, 401);
    assert.deepEqual(
      server.requests.filter((record) => Number(record.scenario) >= 400).map((record) => record.status),
      [401, 403, 429, 500, 503, 401],
    );
  });
});

test('an unknown scenario, an unknown route and a wrong method each say what is wrong', async () => {
  await withMockServer({}, async (server) => {
    const badScenario = await fetch(`${server.url}/v1/chat/completions?scenario=nope`, { method: 'POST' });
    assert.equal(badScenario.status, 400);
    const scenarioBody = (await badScenario.json()) as { error: { message: string } };
    for (const known of AI_MOCK_SCENARIOS) {
      assert.ok(scenarioBody.error.message.includes(known), `the 400 must list "${known}"`);
    }

    const badRoute = await fetch(`${server.url}/v1/nope`);
    assert.equal(badRoute.status, 404);
    const routeBody = (await badRoute.json()) as { error: { message: string } };
    assert.match(routeBody.error.message, /\/models/);
    assert.match(routeBody.error.message, /\/chat\/completions/);

    const wrongMethod = await fetch(`${server.url}/v1/chat/completions`);
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'POST');
  });
});

test('the stall scenario sends a chunk, then nothing until the socket is closed', async () => {
  await withMockServer({ stallMs: 300 }, async (server) => {
    const started = Date.now();
    const response = await fetch(`${server.url}/v1/chat/completions?scenario=stall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    });
    const reader = response.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    const firstAt = Date.now() - started;
    assert.equal(first.done, false);
    const firstText = new TextDecoder().decode(first.value);
    assert.ok(firstText.includes('"content"'), 'the stall still sends one real chunk first');
    assert.ok(!firstText.includes('[DONE]'));
    assert.ok(firstAt < 250, `the first chunk must arrive at once, it took ${firstAt} ms`);

    let text = firstText;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      text += new TextDecoder().decode(step.value);
    }
    const total = Date.now() - started;
    assert.ok(total >= 250, `the endpoint must hold the socket for ~300 ms, it held it for ${total} ms`);
    assert.ok(!text.includes('[DONE]'), 'a stalled stream never terminates cleanly');
  });
});

test('a bind failure rejects with the address it tried, instead of starting nothing quietly', async () => {
  const first = await startAiMockServer({});
  try {
    await assert.rejects(
      () => startAiMockServer({ port: first.port }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, new RegExp(`cannot bind 127\\.0\\.0\\.1:${first.port}`));
        assert.match(message, /EADDRINUSE|EACCES|bind failed/);
        return true;
      },
    );
    // The endpoint that already held the port is untouched and still serving.
    const response = await fetch(`${first.url}/v1/models`);
    assert.equal(response.status, 200);
  } finally {
    await first.close();
  }
});

test('/__mock/requests reports the endpoint identity and every request it handled', async () => {
  await withMockServer({ chunkDelayMs: 5 }, async (server) => {
    await fetch(`${server.url}/v1/models`);
    await readCompletion(server);
    const response = await fetch(`${server.url}${AI_MOCK_REQUESTS_PATH}`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { id: string; count: number; requests: unknown[] };
    assert.equal(payload.id, 'ui-review-ai-mock');
    assert.equal(payload.count, 2);
    assert.equal(payload.requests.length, 2);
  });
});

test('the request log line sink sees every request', async () => {
  const lines: string[] = [];
  await withMockServer({ onLog: (line) => lines.push(line) }, async (server) => {
    await fetch(`${server.url}/v1/models`);
  });
  assert.ok(lines.some((line) => line.startsWith('>> GET /v1/models')));
  assert.ok(lines.some((line) => line.startsWith('<< 200 GET /v1/models')));
});

test('route normalisation and the scenario vocabulary are exactly what the README lists', () => {
  assert.equal(normalizeAiMockRoute('/v1/models'), '/models');
  assert.equal(normalizeAiMockRoute('/v1/chat/completions'), '/chat/completions');
  assert.equal(normalizeAiMockRoute('/models'), '/models');
  assert.equal(normalizeAiMockRoute('/v1'), '/');
  assert.equal(normalizeAiMockRoute('/v1/'), '/');
  assert.equal(normalizeAiMockRoute('/'), '/');
  // A path that merely starts with the same characters is not version-prefixed.
  assert.equal(normalizeAiMockRoute('/v1beta/models'), '/v1beta/models');

  for (const scenario of ['stream', 'clean-stream', 'json', 'reasoning', 'truncated', 'stall', '401', '429', '500']) {
    assert.ok(isAiMockScenario(scenario), `${scenario} must be a scenario`);
    assert.ok(AI_MOCK_SCENARIOS.includes(scenario));
  }
  assert.equal(isAiMockScenario('402'), false);
  assert.equal(isAiMockScenario(''), false);
});
