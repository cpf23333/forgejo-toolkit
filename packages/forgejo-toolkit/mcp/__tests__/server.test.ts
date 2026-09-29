import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ForgejoClient } from '../../src/api/client';
import { getForgejoClientHost, setForgejoClientHost } from '../../src/api/clientHost';
import { passthroughTranslate } from '../../src/api/translate';
import { createMcpServer } from '../mcpServer';
import type { WorkspaceContextOptions } from '../tools';
import type { McpWriteAuditRecord, McpWriteAuditSink } from '../writeTools';
import { formatMcpWriteAuditRecord } from '../../src/mcpWriteAudit';
import { startMockServer, stopMockServer, resetMockServer, mockServer } from '../../src/test/mocks/server';
import {
  mockIssueDetail,
  mockPullRequestDetail,
  mockPullRequestCommit,
  mockPullReview,
  mockTimelineComment,
  mockRepository,
  mockActionRun,
} from '../../src/test/mocks/data';

interface TextToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

/**
 * The read-only tool surface, as an explicit list (§9 stage 0). Every other
 * registered tool must *not* claim `readOnlyHint`, so a new tool cannot join
 * the surface as read-only by accident — and, more importantly, a write tool
 * cannot lose the per-call confirmation by inheriting a shared annotation
 * object. The list is asserted against the live tool listing below, both ways:
 * a name here that is no longer registered fails, and a tool that is neither
 * here nor a declared write tool fails.
 */
const READ_ONLY_TOOLS = [
  'get_action_job_log',
  'get_action_run_artifacts',
  'get_action_run_jobs',
  'get_ci_failure_summary',
  'get_file_content',
  'get_file_history',
  'get_issue',
  'get_pr_diff',
  'get_pr_review_brief',
  'get_pr_timeline',
  'get_pull_request',
  'get_pull_review_comments',
  'get_repo',
  'get_workspace_repository',
  'list_action_runs',
  'list_branches',
  'list_commits',
  'list_issues',
  'list_labels',
  'list_milestones',
  'list_my_repos',
  'list_notifications',
  'list_pull_requests',
  'list_pull_reviews',
  'list_releases',
  'list_repo_contents',
  'list_tags',
  'search',
  'search_repo_files',
  'whoami',
] as const;

/**
 * Tools that change server state: the first batch's two (§13.7 fixed their
 * names) plus the second batch's first candidate (§4.1, §13.3).
 */
const WRITE_TOOLS = ['create_issue_comment', 'submit_pull_review', 'cancel_action_run'] as const;

/**
 * A workspace context that passes both write gates: the provenance marker (the
 * session was established by the extension host) and the per-tool switch.
 */
const WRITE_ALLOWED: WorkspaceContextOptions = {
  instanceId: 'instance-1',
  writeTools: ['create_issue_comment'],
  enabledWriteTools: ['create_issue_comment'],
  writeCaller: 'extension host (test session)',
};

/**
 * The same for the stage-2 tool. The provenance marker carries **tool names**,
 * so a session established for the review tool advertises only that one; a
 * request for the comment tool in it is refused as unprovenanced, which is the
 * per-tool half of "the host established *this* write".
 */
const REVIEW_WRITE_ALLOWED: WorkspaceContextOptions = {
  instanceId: 'instance-1',
  writeTools: ['submit_pull_review'],
  enabledWriteTools: ['submit_pull_review'],
  writeCaller: 'extension host (test session)',
};

/** The endpoint `submit_pull_review` posts to, for a request counter. */
const SUBMIT_REVIEW_URL = 'https://*/api/v1/repos/:owner/:repo/pulls/:index/reviews/:id';

/** The endpoint `cancel_action_run` posts to, for a request counter. */
const CANCEL_RUN_URL = 'https://*/api/v1/repos/:owner/:repo/actions/runs/:runId/cancel';

/**
 * A workspace context that passes both gates for the second batch's tool: the
 * marker covers exactly `cancel_action_run` and exactly that switch is on.
 */
const CANCEL_WRITE_ALLOWED: WorkspaceContextOptions = {
  instanceId: 'instance-1',
  writeTools: ['cancel_action_run'],
  enabledWriteTools: ['cancel_action_run'],
  writeCaller: 'extension host (test session)',
};

/** Arguments that pass `cancel_action_run`'s schema. */
function cancelArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { owner: 'demo-user', repo: 'demo-repo', runId: mockActionRun.id, ...overrides };
}

/** Arguments that pass `submit_pull_review`'s own validation. */
function reviewArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    owner: 'demo-user',
    repo: 'demo-repo',
    index: 2,
    reviewId: mockPullReview.id,
    event: 'COMMENT',
    body: 'Reviewed the changes.',
    ...overrides,
  };
}

/** A pending review's answer to `POST …/pulls/:index/reviews/:id`. */
function mockSubmittedReview(options: { event?: string; body?: string; state?: string } = {}) {
  return {
    ...mockPullReview,
    state: options.state ?? options.event ?? mockPullReview.state,
    body: options.body ?? mockPullReview.body,
    official: true,
    html_url: 'https://forgejo.example.com/demo-user/demo-repo/pulls/2#issuecomment-100',
  };
}

/** Records what the tool surface audits, without an Output Channel. */
function collectAudit(): { entries: McpWriteAuditRecord[]; sink: McpWriteAuditSink } {
  const entries: McpWriteAuditRecord[] = [];
  return {
    entries,
    sink: {
      record: async (entry) => {
        entries.push(entry);
      },
      recordFilePath: () => undefined,
    },
  };
}

/** Round-trips one tool call over an in-memory client/server pair backed by MSW. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  workspaceContext: WorkspaceContextOptions = {},
): Promise<TextToolResult> {
  const server = createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token'), workspaceContext);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcp-test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    return (await client.callTool({ name, arguments: args })) as TextToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

function resultJson(result: TextToolResult): unknown {
  expect(result.isError).toBeFalsy();
  expect(result.content[0].type).toBe('text');
  return JSON.parse(result.content[0].text as string);
}

describe('MCP server over InMemoryTransport', () => {
  beforeAll(() => {
    startMockServer();
  });

  afterAll(() => {
    stopMockServer();
  });

  afterEach(() => {
    resetMockServer();
  });

  it('classifies every tool as read-only or write, and annotates it accordingly', async () => {
    const server = createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token'));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'mcp-test-client', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      // Exact equality both ways, as before: the assertion above pins the
      // read-only set, this one pins the whole surface.
      expect(names).toEqual([...READ_ONLY_TOOLS, ...WRITE_TOOLS].sort());
      for (const tool of tools) {
        expect(tool.description, tool.name).toBeTruthy();
        if ((READ_ONLY_TOOLS as readonly string[]).includes(tool.name)) {
          expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
          continue;
        }
        // A write tool: VS Code shows its per-call confirmation dialog exactly
        // because of these two absences (§3.2), and it must not claim
        // idempotency while its key is the caller's to reuse (§6.6).
        expect(tool.annotations?.readOnlyHint, tool.name).not.toBe(true);
        expect(tool.annotations?.destructiveHint, tool.name).not.toBe(false);
        expect(tool.annotations?.idempotentHint, tool.name).toBe(false);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('keeps the write tool registered but refused when the session has no provenance marker', async () => {
    // §5: the refusal is a normal result, not `isError` — an error reads as
    // "retry and it may work", and the point is to make the agent ask the user.
    const result = await callTool('create_issue_comment', {
      owner: 'demo-user',
      repo: 'demo-repo',
      index: 1,
      body: 'hello',
    });
    expect(result.isError).toBeFalsy();
    const refusal = JSON.parse(result.content[0].text as string) as { refused?: boolean; message?: string };
    expect(refusal.refused).toBe(true);
    expect(refusal.message).toContain('forgejoToolkit.mcpWriteTools.createIssueComment');
    expect(refusal.message).toContain('not established by the Forgejo Toolkit extension host');
  });

  it('refuses when the marker is present but the per-tool switch is off', async () => {
    const result = await callTool(
      'create_issue_comment',
      { owner: 'demo-user', repo: 'demo-repo', index: 1, body: 'hello' },
      { instanceId: 'instance-1', writeTools: ['create_issue_comment'], enabledWriteTools: [] },
    );
    expect(result.isError).toBeFalsy();
    const refusal = JSON.parse(result.content[0].text as string) as { reason?: string; message?: string };
    expect(refusal.reason).toBe('disabled');
    expect(refusal.message).toContain('forgejoToolkit.mcpWriteTools.createIssueComment');
    expect(refusal.message).toContain('not enabled in this session');
  });

  it('creates a comment when both gates pass, and audits it without the body', async () => {
    const { entries, sink } = collectAudit();
    const body = 'Automated review note.';
    const result = await callTool(
      'create_issue_comment',
      { owner: 'demo-user', repo: 'demo-repo', index: 1, body },
      { ...WRITE_ALLOWED, writeAudit: sink },
    );
    const created = resultJson(result) as { ok?: boolean; id?: number; html_url?: string };
    expect(created.ok).toBe(true);
    expect(created.id).toBe(mockTimelineComment.id);
    expect(created.html_url).toBe(mockTimelineComment.html_url);

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.tool).toBe('create_issue_comment');
    expect(entry.result).toBe('ok');
    expect(entry.dryRun).toBe(false);
    expect(entry.repo).toBe('demo-user/demo-repo');
    expect(entry.target).toBe('demo-user/demo-repo#1');
    expect(entry.caller).toBe('extension host (test session)');
    expect(entry.instance).toBe('instance-1');
    expect(entry.bytes).toBe(Buffer.byteLength(body, 'utf8'));
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof entry.ms).toBe('number');
    // Never the text — the audit line is what users paste into bug reports.
    expect(JSON.stringify(entry)).not.toContain(body);
  });

  it('sends nothing on a dry run and reports the plan', async () => {
    let posts = 0;
    mockServer.use(
      http.post('https://*/api/v1/repos/:owner/:repo/issues/:index/comments', () => {
        posts += 1;
        return HttpResponse.json({ ...mockTimelineComment }, { status: 201 });
      }),
    );
    const { entries, sink } = collectAudit();
    const body = 'Hello from the MCP write path.\n';
    const result = await callTool(
      'create_issue_comment',
      { owner: 'demo-user', repo: 'demo-repo', index: 1, body, dryRun: true },
      { ...WRITE_ALLOWED, writeAudit: sink },
    );
    expect(posts).toBe(0);
    const planned = resultJson(result) as {
      dryRun?: boolean;
      plan?: Record<string, unknown>;
      note?: string;
    };
    expect(planned.dryRun).toBe(true);
    expect(planned.plan).toMatchObject({
      tool: 'create_issue_comment',
      instance: 'instance-1',
      repo: 'demo-user/demo-repo',
      target: 'demo-user/demo-repo#1',
      bodyCharacters: body.length,
      bytes: Buffer.byteLength(body, 'utf8'),
    });
    expect(planned.plan?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // §7: a dry run must not promise that the server would accept the call.
    expect(planned.note).toMatch(/accepting/i);
    expect(entries[0].dryRun).toBe(true);
    expect(entries[0].result).toBe('ok');
  });

  it('replays a repeated idempotency key instead of writing twice', async () => {
    let posts = 0;
    mockServer.use(
      http.post('https://*/api/v1/repos/:owner/:repo/issues/:index/comments', () => {
        posts += 1;
        return HttpResponse.json({ ...mockTimelineComment }, { status: 201 });
      }),
    );
    const server = createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token'), {
      ...WRITE_ALLOWED,
      writeAudit: collectAudit().sink,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'mcp-test-client', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const args = { owner: 'demo-user', repo: 'demo-repo', index: 1, body: 'once', idempotencyKey: 'key-1' };
      const first = (await client.callTool({ name: 'create_issue_comment', arguments: args })) as TextToolResult;
      const second = (await client.callTool({ name: 'create_issue_comment', arguments: args })) as TextToolResult;

      expect(posts).toBe(1);
      expect((resultJson(first) as { id?: number }).id).toBe(mockTimelineComment.id);
      const replay = resultJson(second) as { duplicate?: boolean; result?: { id?: number }; message?: string };
      expect(replay.duplicate).toBe(true);
      expect(replay.result?.id).toBe(mockTimelineComment.id);
      expect(replay.message).toMatch(/nothing new was created/i);

      // The same key with a different body is a caller bug, not a replay.
      const mismatched = (await client.callTool({
        name: 'create_issue_comment',
        arguments: { ...args, body: 'different' },
      })) as TextToolResult;
      expect(mismatched.isError).toBe(true);
      expect(mismatched.content[0].text ?? '').toMatch(/idempotencyKey/);
      expect(posts).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('refuses an empty or oversized body without sending anything', async () => {
    let posts = 0;
    mockServer.use(
      http.post('https://*/api/v1/repos/:owner/:repo/issues/:index/comments', () => {
        posts += 1;
        return HttpResponse.json({ ...mockTimelineComment }, { status: 201 });
      }),
    );
    const { entries, sink } = collectAudit();
    const context = { ...WRITE_ALLOWED, writeAudit: sink };

    const empty = await callTool(
      'create_issue_comment',
      { owner: 'demo-user', repo: 'demo-repo', index: 1, body: '   ' },
      context,
    );
    expect(empty.isError).toBe(true);
    expect(empty.content[0].text ?? '').toMatch(/non-empty/);

    const oversized = await callTool(
      'create_issue_comment',
      { owner: 'demo-user', repo: 'demo-repo', index: 1, body: 'x'.repeat(64 * 1024 + 1) },
      context,
    );
    expect(oversized.isError).toBe(true);
    expect(oversized.content[0].text ?? '').toMatch(/over the 65536-byte limit/);

    expect(posts).toBe(0);
    // Both refusals are still audited (§8), with the body's size but not itself.
    expect(entries.map((entry) => entry.result)).toEqual(['refused:validation', 'refused:validation']);
    expect(entries[1].bytes).toBe(64 * 1024 + 1);
  });

  it('tells the caller about a missing write scope and audits the status', async () => {
    mockServer.use(
      http.post('https://*/api/v1/repos/:owner/:repo/issues/:index/comments', () =>
        HttpResponse.json({ message: 'token does not have at least one of the required scopes' }, { status: 403 }),
      ),
    );
    // The host hooks are no-ops in a headless process (`headlessHost` in
    // src/api/clientHost.ts), so the tool text is the only place the missing
    // scope can reach the user. The shared test setup registers the VS Code
    // host (whose toast path needs window APIs this suite does not stand up),
    // so the headless host is installed here to test the headless rendering.
    const previousHost = getForgejoClientHost();
    setForgejoClientHost({
      t: passthroughTranslate,
      notifyInvalidCredentials: () => undefined,
      notifyInsufficientScope: () => undefined,
      notifyUnsupportedInstance: () => undefined,
    });
    try {
      const { entries, sink } = collectAudit();
      const result = await callTool(
        'create_issue_comment',
        { owner: 'demo-user', repo: 'demo-repo', index: 1, body: 'nope' },
        { ...WRITE_ALLOWED, writeAudit: sink },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text ?? '').toMatch(/scope/i);
      expect(entries[0].result).toBe('http:403');
      expect(entries[0].bytes).toBe(4);
    } finally {
      setForgejoClientHost(previousHost);
    }
  });

  it('refuses submit_pull_review without provenance, naming its own setting', async () => {
    // Same shape as stage 1's refusal: a successful result, not `isError`, and
    // the stage-2 setting rather than the stage-1 one (§13.8).
    const result = await callTool('submit_pull_review', reviewArgs());
    expect(result.isError).toBeFalsy();
    const refusal = JSON.parse(result.content[0].text as string) as { refused?: boolean; message?: string };
    expect(refusal.refused).toBe(true);
    expect(refusal.message).toContain('forgejoToolkit.mcpWriteTools.submitPullReview');
    expect(refusal.message).not.toContain('createIssueComment');
    expect(refusal.message).toContain('not established by the Forgejo Toolkit extension host');
  });

  it('refuses submit_pull_review when the marker covers it but its switch is off', async () => {
    const result = await callTool('submit_pull_review', reviewArgs(), {
      instanceId: 'instance-1',
      writeTools: ['submit_pull_review'],
      enabledWriteTools: [],
    });
    expect(result.isError).toBeFalsy();
    const refusal = JSON.parse(result.content[0].text as string) as { reason?: string; message?: string };
    expect(refusal.reason).toBe('disabled');
    expect(refusal.message).toContain('forgejoToolkit.mcpWriteTools.submitPullReview');
    expect(refusal.message).toContain('not enabled in this session');
  });

  it('submits a review when both gates pass, and audits it without the body', async () => {
    let posts = 0;
    let sent: { event?: string; body?: string } = {};
    mockServer.use(
      http.post(SUBMIT_REVIEW_URL, async ({ request }) => {
        posts += 1;
        sent = (await request.json()) as { event?: string; body?: string };
        return HttpResponse.json(mockSubmittedReview({ event: sent.event, body: sent.body }), { status: 200 });
      }),
    );
    const { entries, sink } = collectAudit();
    const body = 'This looks correct.';
    const result = await callTool('submit_pull_review', reviewArgs({ event: 'APPROVED', body }), {
      ...REVIEW_WRITE_ALLOWED,
      writeAudit: sink,
    });

    expect(posts).toBe(1);
    // The verdict and the message reach the server verbatim (§9 stage 2 asks
    // for the request body to be asserted, not just the result).
    expect(sent).toEqual({ event: 'APPROVED', body });
    const submitted = resultJson(result) as { ok?: boolean; id?: number; state?: string; html_url?: string };
    expect(submitted.ok).toBe(true);
    expect(submitted.id).toBe(mockPullReview.id);
    expect(submitted.state).toBe('APPROVED');
    expect(submitted.html_url).toContain('/pulls/2');

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.tool).toBe('submit_pull_review');
    expect(entry.result).toBe('ok');
    expect(entry.dryRun).toBe(false);
    expect(entry.repo).toBe('demo-user/demo-repo');
    // The shared target keeps its `owner/repo#index` meaning; the review's own
    // number travels beside it (§8).
    expect(entry.target).toBe('demo-user/demo-repo#2');
    expect(entry.reviewId).toBe(mockPullReview.id);
    expect(entry.caller).toBe('extension host (test session)');
    expect(entry.instance).toBe('instance-1');
    expect(entry.bytes).toBe(Buffer.byteLength(body, 'utf8'));
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof entry.ms).toBe('number');
    // Never the text — the audit line is what users paste into bug reports.
    expect(JSON.stringify(entry)).not.toContain(body);

    // …and the line the sinks actually receive (the Output Channel text and the
    // JSONL file line are this one string) carries the same fields, with
    // `reviewId` beside the shared target and none of the message.
    const serialized = formatMcpWriteAuditRecord(entry);
    expect(serialized).not.toContain('\n');
    const line = JSON.parse(serialized) as Record<string, unknown>;
    expect(Object.keys(line)).toEqual([
      'at',
      'caller',
      'instance',
      'repo',
      'target',
      'reviewId',
      'tool',
      'dryRun',
      'bytes',
      'sha256',
      'result',
      'ms',
    ]);
    expect(line.reviewId).toBe(mockPullReview.id);
    expect(serialized).not.toContain(body);
  });

  it('sends nothing for a review dry run and reports the plan and the verdict', async () => {
    let posts = 0;
    mockServer.use(
      http.post(SUBMIT_REVIEW_URL, () => {
        posts += 1;
        return HttpResponse.json(mockSubmittedReview(), { status: 200 });
      }),
    );
    const { entries, sink } = collectAudit();
    const body = 'Please change the retry handling.';
    const result = await callTool('submit_pull_review', reviewArgs({ event: 'REQUEST_CHANGES', body, dryRun: true }), {
      ...REVIEW_WRITE_ALLOWED,
      writeAudit: sink,
    });

    expect(posts).toBe(0);
    const planned = resultJson(result) as {
      dryRun?: boolean;
      plan?: Record<string, unknown>;
      note?: string;
    };
    expect(planned.dryRun).toBe(true);
    expect(planned.plan).toMatchObject({
      tool: 'submit_pull_review',
      instance: 'instance-1',
      repo: 'demo-user/demo-repo',
      target: 'demo-user/demo-repo#2',
      reviewId: mockPullReview.id,
      event: 'REQUEST_CHANGES',
      bodyCharacters: body.length,
      bytes: Buffer.byteLength(body, 'utf8'),
      api: `POST /repos/demo-user/demo-repo/pulls/2/reviews/${mockPullReview.id}`,
    });
    expect(planned.plan?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // §9 stage 2: the plan carries the extra wording the verdict deserves.
    expect(String(planned.plan?.consequence)).toMatch(/request for changes/i);
    // §7: a dry run must not promise that the server would accept the call.
    expect(planned.note).toMatch(/accepting/i);
    expect(entries[0].dryRun).toBe(true);
    expect(entries[0].result).toBe('ok');
    expect(entries[0].reviewId).toBe(mockPullReview.id);
  });

  it('replays a repeated review idempotency key instead of submitting twice', async () => {
    let posts = 0;
    mockServer.use(
      http.post(SUBMIT_REVIEW_URL, async ({ request }) => {
        posts += 1;
        const sent = (await request.json()) as { event?: string; body?: string };
        return HttpResponse.json(mockSubmittedReview({ event: sent.event, body: sent.body }), { status: 200 });
      }),
    );
    const server = createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token'), {
      ...REVIEW_WRITE_ALLOWED,
      writeAudit: collectAudit().sink,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'mcp-test-client', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const args = reviewArgs({ event: 'COMMENT', body: 'once', idempotencyKey: 'review-key-1' });
      const first = (await client.callTool({ name: 'submit_pull_review', arguments: args })) as TextToolResult;
      const second = (await client.callTool({ name: 'submit_pull_review', arguments: args })) as TextToolResult;

      expect(posts).toBe(1);
      expect((resultJson(first) as { id?: number }).id).toBe(mockPullReview.id);
      const replay = resultJson(second) as { duplicate?: boolean; result?: { id?: number }; message?: string };
      expect(replay.duplicate).toBe(true);
      expect(replay.result?.id).toBe(mockPullReview.id);
      expect(replay.message).toMatch(/nothing new was created/i);

      // The same key with a different body is a caller bug, not a replay.
      const mismatched = (await client.callTool({
        name: 'submit_pull_review',
        arguments: { ...args, body: 'different' },
      })) as TextToolResult;
      expect(mismatched.isError).toBe(true);
      expect(mismatched.content[0].text ?? '').toMatch(/idempotencyKey/);
      expect(posts).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects an event outside the enum before any request', async () => {
    // §4.2: the spelling is the whole point — `APPROVE` and `CHANGES_REQUESTED`
    // are the synonyms a model reaches for, and the server leaves the review
    // pending (422) on anything its own switch does not recognise. The schema is
    // the only place that can stop the call.
    let posts = 0;
    mockServer.use(
      http.post(SUBMIT_REVIEW_URL, () => {
        posts += 1;
        return HttpResponse.json(mockSubmittedReview(), { status: 200 });
      }),
    );
    for (const event of ['APPROVE', 'CHANGES_REQUESTED', 'approve', 'approved', 'PENDING', '']) {
      const result = await callTool('submit_pull_review', reviewArgs({ event }), REVIEW_WRITE_ALLOWED);
      expect(result.isError, event).toBe(true);
      expect(result.content[0].text ?? '', event).toMatch(/event/i);
    }
    expect(posts).toBe(0);
  });

  it('refuses a body-less APPROVED or REQUEST_CHANGES review without sending anything', async () => {
    // The server's own rule (`preparePullReviewType`: `needsBody` stays true for
    // both verdicts), enforced here so the caller is told before a confirmation
    // dialog is ever shown. COMMENT may omit the message.
    let posts = 0;
    mockServer.use(
      http.post(SUBMIT_REVIEW_URL, () => {
        posts += 1;
        return HttpResponse.json(mockSubmittedReview(), { status: 200 });
      }),
    );
    const { entries, sink } = collectAudit();
    const context = { ...REVIEW_WRITE_ALLOWED, writeAudit: sink };

    for (const event of ['APPROVED', 'REQUEST_CHANGES'] as const) {
      const result = await callTool('submit_pull_review', reviewArgs({ event, body: '   ' }), context);
      expect(result.isError, event).toBe(true);
      expect(result.content[0].text ?? '', event).toMatch(/non-empty/);
    }
    expect(posts).toBe(0);
    // Both refusals are still audited (§8).
    expect(entries.map((entry) => entry.result)).toEqual(['refused:validation', 'refused:validation']);
  });

  it('keeps the two per-tool switches independent in both directions', async () => {
    // The whole point of per-tool switches (§13.2): turning one on must not
    // enable the other, whichever one it is.
    const commentOnly = await callTool('submit_pull_review', reviewArgs(), {
      instanceId: 'instance-1',
      writeTools: WRITE_TOOLS,
      enabledWriteTools: ['create_issue_comment'],
    });
    expect(commentOnly.isError).toBeFalsy();
    const commentRefusal = JSON.parse(commentOnly.content[0].text as string) as { reason?: string; message?: string };
    expect(commentRefusal.reason).toBe('disabled');
    expect(commentRefusal.message).toContain('forgejoToolkit.mcpWriteTools.submitPullReview');

    const reviewOnly = await callTool(
      'create_issue_comment',
      { owner: 'demo-user', repo: 'demo-repo', index: 1, body: 'hello' },
      { instanceId: 'instance-1', writeTools: WRITE_TOOLS, enabledWriteTools: ['submit_pull_review'] },
    );
    expect(reviewOnly.isError).toBeFalsy();
    const reviewRefusal = JSON.parse(reviewOnly.content[0].text as string) as { reason?: string; message?: string };
    expect(reviewRefusal.reason).toBe('disabled');
    expect(reviewRefusal.message).toContain('forgejoToolkit.mcpWriteTools.createIssueComment');
  });

  it('refuses cancel_action_run without provenance, naming its own setting', async () => {
    // Zero provenance: every route that is not an extension-provided session
    // lands here, and the refusal is a normal result naming the stage's own
    // setting (§5, §13.8) — never `isError`, which reads as "retry".
    const result = await callTool('cancel_action_run', cancelArgs());
    expect(result.isError).toBeFalsy();
    const refusal = JSON.parse(result.content[0].text as string) as { refused?: boolean; message?: string };
    expect(refusal.refused).toBe(true);
    expect(refusal.message).toContain('forgejoToolkit.mcpWriteTools.cancelActionRun');
    expect(refusal.message).not.toContain('createIssueComment');
    expect(refusal.message).not.toContain('submitPullReview');
    expect(refusal.message).toContain('not established by the Forgejo Toolkit extension host');
  });

  it('refuses cancel_action_run when the marker covers it but its switch is off', async () => {
    const result = await callTool('cancel_action_run', cancelArgs(), {
      instanceId: 'instance-1',
      writeTools: ['cancel_action_run'],
      enabledWriteTools: [],
    });
    expect(result.isError).toBeFalsy();
    const refusal = JSON.parse(result.content[0].text as string) as { reason?: string; message?: string };
    expect(refusal.reason).toBe('disabled');
    expect(refusal.message).toContain('forgejoToolkit.mcpWriteTools.cancelActionRun');
    expect(refusal.message).toContain('not enabled in this session');
  });

  it('cancels the run when both gates pass, and audits a line with no body fields', async () => {
    let posts = 0;
    mockServer.use(
      http.post(CANCEL_RUN_URL, () => {
        posts += 1;
        // Forgejo answers 204 with no content, finished run or not.
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { entries, sink } = collectAudit();
    const result = await callTool('cancel_action_run', cancelArgs(), { ...CANCEL_WRITE_ALLOWED, writeAudit: sink });

    expect(posts).toBe(1);
    const cancelled = resultJson(result) as { ok?: boolean; id?: number; target?: string; message?: string };
    expect(cancelled.ok).toBe(true);
    expect(cancelled.id).toBe(mockActionRun.id);
    expect(cancelled.target).toBe(`demo-user/demo-repo#${mockActionRun.id}`);
    // The endpoint answers 204 for a run that had already finished too, so the
    // text may not claim this call cancelled anything.
    expect(cancelled.message).toMatch(/accepted the cancel request/);
    expect(cancelled.message).toMatch(/already finished/);

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.tool).toBe('cancel_action_run');
    expect(entry.result).toBe('ok');
    expect(entry.dryRun).toBe(false);
    expect(entry.repo).toBe('demo-user/demo-repo');
    expect(entry.target).toBe(`demo-user/demo-repo#${mockActionRun.id}`);
    expect(entry.caller).toBe('extension host (test session)');
    expect(entry.instance).toBe('instance-1');
    expect(typeof entry.ms).toBe('number');
    // This call carries no body at all, so the two body fields are absent
    // rather than zero — the same rule a body-less COMMENT review follows.
    expect(entry.bytes).toBeUndefined();
    expect(entry.sha256).toBeUndefined();
    expect(entry.reviewId).toBeUndefined();
    expect(Object.keys(entry).sort()).toEqual(
      ['at', 'caller', 'dryRun', 'instance', 'ms', 'repo', 'result', 'target', 'tool'].sort(),
    );
  });

  it('sends nothing for a cancel dry run and reports the plan', async () => {
    let posts = 0;
    mockServer.use(
      http.post(CANCEL_RUN_URL, () => {
        posts += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { entries, sink } = collectAudit();
    const result = await callTool('cancel_action_run', cancelArgs({ dryRun: true }), {
      ...CANCEL_WRITE_ALLOWED,
      writeAudit: sink,
    });

    expect(posts).toBe(0);
    const planned = resultJson(result) as { dryRun?: boolean; plan?: Record<string, unknown>; note?: string };
    expect(planned.dryRun).toBe(true);
    expect(planned.plan).toMatchObject({
      tool: 'cancel_action_run',
      instance: 'instance-1',
      repo: 'demo-user/demo-repo',
      target: `demo-user/demo-repo#${mockActionRun.id}`,
      runId: mockActionRun.id,
      api: `POST /repos/demo-user/demo-repo/actions/runs/${mockActionRun.id}/cancel`,
    });
    // The plan says what cancelling means, and does not promise the server would
    // accept the real call (§7).
    expect(String(planned.plan?.consequence)).toMatch(/cancelled/);
    expect(planned.note).toMatch(/accepting/i);
    expect(entries[0].dryRun).toBe(true);
    expect(entries[0].result).toBe('ok');
    expect(entries[0].bytes).toBeUndefined();
    expect(entries[0].sha256).toBeUndefined();
  });

  it('replays a repeated cancel instead of sending a second request', async () => {
    let posts = 0;
    mockServer.use(
      http.post(CANCEL_RUN_URL, () => {
        posts += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const server = createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token'), {
      ...CANCEL_WRITE_ALLOWED,
      writeAudit: collectAudit().sink,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'mcp-test-client', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const args = cancelArgs({ idempotencyKey: 'cancel-key-1' });
      const first = (await client.callTool({ name: 'cancel_action_run', arguments: args })) as TextToolResult;
      const second = (await client.callTool({ name: 'cancel_action_run', arguments: args })) as TextToolResult;

      // The second cancel is the same logical action, so it replays rather than
      // issuing a second request — and the endpoint being a no-op for a
      // finished run does not make the replay optional.
      expect(posts).toBe(1);
      expect((resultJson(first) as { id?: number }).id).toBe(mockActionRun.id);
      const replay = resultJson(second) as { duplicate?: boolean; result?: { id?: number }; message?: string };
      expect(replay.duplicate).toBe(true);
      expect(replay.result?.id).toBe(mockActionRun.id);
      expect(replay.message).toMatch(/nothing new was created/i);

      // The same key for a different run is a caller bug, not a replay.
      const mismatched = (await client.callTool({
        name: 'cancel_action_run',
        arguments: { ...args, runId: mockActionRun.id + 1 },
      })) as TextToolResult;
      expect(mismatched.isError).toBe(true);
      expect(mismatched.content[0].text ?? '').toMatch(/idempotencyKey/);
      expect(posts).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('tells the caller about a missing write scope on a cancel and audits the status', async () => {
    mockServer.use(
      http.post(CANCEL_RUN_URL, () =>
        HttpResponse.json({ message: 'token does not have at least one of the required scopes' }, { status: 403 }),
      ),
    );
    // As for the comment tool: the host hooks are no-ops in a headless process,
    // so the tool text is the only place the missing scope can reach the user.
    const previousHost = getForgejoClientHost();
    setForgejoClientHost({
      t: passthroughTranslate,
      notifyInvalidCredentials: () => undefined,
      notifyInsufficientScope: () => undefined,
      notifyUnsupportedInstance: () => undefined,
    });
    try {
      const { entries, sink } = collectAudit();
      const result = await callTool('cancel_action_run', cancelArgs(), { ...CANCEL_WRITE_ALLOWED, writeAudit: sink });
      expect(result.isError).toBe(true);
      expect(result.content[0].text ?? '').toMatch(/scope/i);
      expect(entries[0].result).toBe('http:403');
      expect(entries[0].bytes).toBeUndefined();
    } finally {
      setForgejoClientHost(previousHost);
    }
  });

  it('keeps every write switch independent of the other two', async () => {
    // Per-tool independence is the point of the switches (§13.2), and the second
    // batch's tool must not become reachable through either earlier switch.
    for (const enabled of ['create_issue_comment', 'submit_pull_review'] as const) {
      const result = await callTool('cancel_action_run', cancelArgs(), {
        instanceId: 'instance-1',
        writeTools: WRITE_TOOLS,
        enabledWriteTools: [enabled],
      });
      expect(result.isError, enabled).toBeFalsy();
      const refusal = JSON.parse(result.content[0].text as string) as { reason?: string; message?: string };
      expect(refusal.reason, enabled).toBe('disabled');
      expect(refusal.message, enabled).toContain('forgejoToolkit.mcpWriteTools.cancelActionRun');
    }

    // …and enabling the cancel switch alone leaves both earlier tools refused.
    const cancelOnly: WorkspaceContextOptions = {
      instanceId: 'instance-1',
      writeTools: WRITE_TOOLS,
      enabledWriteTools: ['cancel_action_run'],
    };
    const comment = await callTool(
      'create_issue_comment',
      { owner: 'demo-user', repo: 'demo-repo', index: 1, body: 'hello' },
      cancelOnly,
    );
    expect(comment.isError).toBeFalsy();
    expect((JSON.parse(comment.content[0].text as string) as { message?: string }).message).toContain(
      'forgejoToolkit.mcpWriteTools.createIssueComment',
    );

    const review = await callTool('submit_pull_review', reviewArgs(), cancelOnly);
    expect(review.isError).toBeFalsy();
    expect((JSON.parse(review.content[0].text as string) as { message?: string }).message).toContain(
      'forgejoToolkit.mcpWriteTools.submitPullReview',
    );
  });

  it('treats one key reused across two write tools as a reuse, not a replay', async () => {
    // The three tools share one idempotency table, so the tool name is part of
    // the identity: a key a comment call used is not a licence for a cancel with
    // the same key, and the caller is told to generate a new one rather than
    // silently getting the other tool's result back.
    let posts = 0;
    mockServer.use(
      http.post('https://*/api/v1/repos/:owner/:repo/issues/:index/comments', () => {
        posts += 1;
        return HttpResponse.json({ ...mockTimelineComment }, { status: 201 });
      }),
      http.post(CANCEL_RUN_URL, () => {
        posts += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const server = createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token'), {
      instanceId: 'instance-1',
      writeTools: WRITE_TOOLS,
      enabledWriteTools: WRITE_TOOLS,
      writeCaller: 'extension host (test session)',
      writeAudit: collectAudit().sink,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'mcp-test-client', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const key = 'shared-key-1';
      const comment = (await client.callTool({
        name: 'create_issue_comment',
        arguments: { owner: 'demo-user', repo: 'demo-repo', index: 1, body: 'once', idempotencyKey: key },
      })) as TextToolResult;
      expect(resultJson(comment)).toMatchObject({ ok: true });

      const cancel = (await client.callTool({
        name: 'cancel_action_run',
        arguments: cancelArgs({ idempotencyKey: key }),
      })) as TextToolResult;
      expect(cancel.isError).toBe(true);
      expect(cancel.content[0].text ?? '').toMatch(/idempotencyKey/);
      // The comment was written once; the cancel never reached the server.
      expect(posts).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('round-trips list_issues as a paged result with the rows and no total', async () => {
    const result = await callTool('list_issues', { owner: 'demo-user', repo: 'demo-repo' });
    // The handler passes the client's `PagedList` through so the truncation note
    // can read the server's total; the mock sends no X-Total-Count, which is the
    // old-server shape, so the total is honestly absent.
    const page = resultJson(result) as { items: { title?: string }[]; totalCount?: number };
    expect(page.items).toHaveLength(2);
    expect(page.items[0].title).toBe('Fix login bug');
    expect(page.totalCount).toBeUndefined();
  });

  it('round-trips get_issue with comments', async () => {
    const result = await callTool('get_issue', { owner: 'demo-user', repo: 'demo-repo', index: 1 });
    const data = resultJson(result) as { issue: { number?: number }; comments: { body?: string }[] };
    expect(data.issue.number).toBe(mockIssueDetail.number);
    expect(data.comments[0].body).toBe(mockTimelineComment.body);
  });

  it('round-trips list_pull_requests as a paged result', async () => {
    const result = await callTool('list_pull_requests', { owner: 'demo-user', repo: 'demo-repo' });
    const page = resultJson(result) as { items: { title?: string }[]; totalCount?: number };
    expect(page.items).toHaveLength(2);
    expect(page.items[0].title).toBe('Add dark mode');
    expect(page.totalCount).toBeUndefined();
  });

  it('round-trips get_pull_request with files and commits', async () => {
    const result = await callTool('get_pull_request', { owner: 'demo-user', repo: 'demo-repo', index: 2 });
    const data = resultJson(result) as {
      pullRequest: { number?: number };
      files: { filename?: string }[];
      commits: { sha?: string }[];
    };
    expect(data.pullRequest.number).toBe(mockPullRequestDetail.number);
    expect(data.files[0].filename).toBe('src/index.ts');
    expect(data.commits[0].sha).toBe(mockPullRequestCommit.sha);
  });

  it('round-trips get_pr_timeline', async () => {
    const result = await callTool('get_pr_timeline', { owner: 'demo-user', repo: 'demo-repo', index: 2 });
    // The timeline is a paged list, so the rows come back under `items` with the
    // server's own count beside them (absent here: the mock sends no header).
    const page = resultJson(result) as { items: { body?: string }[]; totalCount?: number };
    expect(page.items[0].body).toBe(mockTimelineComment.body);
    expect(page.totalCount).toBeUndefined();
  });

  it('round-trips list_notifications as a paged result', async () => {
    const result = await callTool('list_notifications', {});
    const page = resultJson(result) as { items: { id?: number }[] };
    expect(page.items.map((n) => n.id)).toEqual([101, 102]);
  });

  it('round-trips get_repo', async () => {
    const result = await callTool('get_repo', { owner: 'demo-user', repo: 'demo-repo' });
    const detail = resultJson(result) as { repository: { full_name?: string } };
    expect(detail.repository.full_name).toBe(mockRepository.full_name);
  });

  it('round-trips search', async () => {
    const result = await callTool('search', { query: 'another', type: 'repositories' });
    const repos = resultJson(result) as { full_name?: string }[];
    expect(repos).toHaveLength(1);
    expect(repos[0].full_name).toBe('demo-user/another-repo');
  });

  it('round-trips list_action_runs', async () => {
    const result = await callTool('list_action_runs', { owner: 'demo-user', repo: 'demo-repo' });
    const runs = resultJson(result) as { workflow_runs: { id?: number }[] };
    // The fixture has 35 runs; the tool's page holds the first 30.
    expect(runs.workflow_runs).toHaveLength(30);
    expect(runs.workflow_runs[0].id).toBe(42);
  });

  it('round-trips get_action_job_log as a plain string', async () => {
    const result = await callTool('get_action_job_log', { owner: 'demo-user', repo: 'demo-repo', jobId: 101 });
    expect(resultJson(result)).toBe('build log output');
  });

  it('round-trips get_file_content', async () => {
    const result = await callTool('get_file_content', {
      owner: 'demo-user',
      repo: 'demo-repo',
      path: 'src/index.ts',
      ref: 'main',
    });
    expect(resultJson(result)).toContain('export function greet');
  });

  it('round-trips search_repo_files with the default-branch fallback', async () => {
    const result = await callTool('search_repo_files', { owner: 'demo-user', repo: 'demo-repo', query: 'index' });
    // The tool reports the matches plus whether the tree was read completely.
    const payload = resultJson(result) as { files: { path?: string }[]; truncated: boolean };
    expect(payload.files.map((file) => file.path)).toEqual(['src/index.ts']);
    expect(payload.truncated).toBe(false);
  });

  it('round-trips list_pull_reviews', async () => {
    const result = await callTool('list_pull_reviews', { owner: 'demo-user', repo: 'demo-repo', index: 2 });
    const page = resultJson(result) as { items: { id?: number; state?: string }[] };
    expect(page.items).toHaveLength(1);
    expect(page.items[0].state).toBe('COMMENT');
  });

  it('round-trips whoami', async () => {
    const result = await callTool('whoami', {});
    const user = resultJson(result) as { login?: string };
    expect(user.login).toBe('demo-user');
  });

  it('renders API failures as tool errors without leaking the token', async () => {
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/issues', () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 }),
      ),
    );
    const result = await callTool('list_issues', { owner: 'demo-user', repo: 'demo-repo' });
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('boom');
    expect(text).not.toContain('mock-token');
  });

  it('truncates oversized fields in tool results', async () => {
    const hugeBody = 'x'.repeat(20 * 1024);
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/issues/:index', () =>
        HttpResponse.json({ ...mockIssueDetail, body: hugeBody }),
      ),
    );
    const result = await callTool('get_issue', { owner: 'demo-user', repo: 'demo-repo', index: 1 });
    const data = resultJson(result) as { issue: { body?: string } };
    expect(data.issue.body).toContain('truncated');
    expect(data.issue.body!.length).toBeLessThan(hugeBody.length);
  });

  it('rejects a hostile repository name in every tool that takes one', async () => {
    const server = createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token'));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'mcp-test-client', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const allProperties = (tool: (typeof tools)[number]) =>
        ((tool.inputSchema as { properties?: Record<string, JsonSchemaProperty> }).properties ?? {}) as Record<
          string,
          JsonSchemaProperty
        >;
      const repoTools = tools.filter((tool) => 'repo' in allProperties(tool));
      // Every repository-scoped tool must be covered; the generated client
      // interpolates these values straight into the request path, so an
      // unguarded tool is an arbitrary same-origin GET.
      expect(repoTools.length).toBeGreaterThanOrEqual(20);

      for (const tool of repoTools) {
        const result = await callTool(tool.name, hostileArgs(tool.inputSchema, allProperties(tool)));
        // A schema rejection carries the guard's message; an API error would
        // not, so this also proves the request never reached the network.
        expect(result.isError, tool.name).toBe(true);
        expect(result.content[0].text ?? '', tool.name).toContain('single path segment');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

interface JsonSchemaProperty {
  type?: string;
  enum?: unknown[];
  anyOf?: { type?: string }[];
}

/** Minimal valid arguments for a tool, with `repo` forced to a hostile value. */
function hostileArgs(inputSchema: unknown, properties: Record<string, JsonSchemaProperty>): Record<string, unknown> {
  const required = ((inputSchema as { required?: string[] }).required ?? []) as string[];
  const args: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(properties)) {
    if (key === 'owner') {
      args.owner = 'demo-user';
      continue;
    }
    if (key === 'repo') {
      args.repo = 'x/../../admin/users';
      continue;
    }
    if (!required.includes(key)) {
      continue;
    }
    if (key === 'path') {
      args.path = 'src/index.ts';
      continue;
    }
    if (Array.isArray(property.enum)) {
      args[key] = property.enum[0];
      continue;
    }
    const type = property.anyOf?.find((option) => option.type && option.type !== 'null')?.type ?? property.type;
    if (type === 'number' || type === 'integer') {
      args[key] = 1;
    } else if (type === 'boolean') {
      args[key] = true;
    } else if (type === 'array') {
      args[key] = [];
    } else {
      args[key] = 'x';
    }
  }
  return args;
}
