import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ForgejoClient } from '../../src/api/client';
import { createMcpServer } from '../mcpServer';
import { startMockServer, stopMockServer, resetMockServer, mockServer } from '../../src/test/mocks/server';
import {
  mockIssueDetail,
  mockPullRequestDetail,
  mockPullRequestCommit,
  mockTimelineComment,
  mockRepository,
} from '../../src/test/mocks/data';

interface TextToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

/** Round-trips one tool call over an in-memory client/server pair backed by MSW. */
async function callTool(name: string, args: Record<string, unknown>): Promise<TextToolResult> {
  const server = createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token'));
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

  it('lists exactly the read-only tool surface', async () => {
    const server = createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token'));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'mcp-test-client', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'get_action_job_log',
        'get_action_run_artifacts',
        'get_action_run_jobs',
        'get_file_content',
        'get_file_history',
        'get_issue',
        'get_pr_diff',
        'get_pr_timeline',
        'get_pull_request',
        'get_pull_review_comments',
        'get_repo',
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
      ]);
      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.annotations?.readOnlyHint).toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('round-trips list_issues', async () => {
    const result = await callTool('list_issues', { owner: 'demo-user', repo: 'demo-repo' });
    const issues = resultJson(result) as { title?: string }[];
    expect(issues).toHaveLength(1);
    expect(issues[0].title).toBe('Fix login bug');
  });

  it('round-trips get_issue with comments', async () => {
    const result = await callTool('get_issue', { owner: 'demo-user', repo: 'demo-repo', index: 1 });
    const data = resultJson(result) as { issue: { number?: number }; comments: { body?: string }[] };
    expect(data.issue.number).toBe(mockIssueDetail.number);
    expect(data.comments[0].body).toBe(mockTimelineComment.body);
  });

  it('round-trips list_pull_requests', async () => {
    const result = await callTool('list_pull_requests', { owner: 'demo-user', repo: 'demo-repo' });
    const pulls = resultJson(result) as { title?: string }[];
    expect(pulls).toHaveLength(1);
    expect(pulls[0].title).toBe('Add dark mode');
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
    const timeline = resultJson(result) as { body?: string }[];
    expect(timeline[0].body).toBe(mockTimelineComment.body);
  });

  it('round-trips list_notifications', async () => {
    const result = await callTool('list_notifications', {});
    const notifications = resultJson(result) as { id?: number }[];
    expect(notifications.map((n) => n.id)).toEqual([101, 102]);
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
    expect(runs.workflow_runs).toHaveLength(1);
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
    const files = resultJson(result) as { path?: string }[];
    expect(files.map((file) => file.path)).toEqual(['src/index.ts']);
  });

  it('round-trips list_pull_reviews', async () => {
    const result = await callTool('list_pull_reviews', { owner: 'demo-user', repo: 'demo-repo', index: 2 });
    const reviews = resultJson(result) as { id?: number; state?: string }[];
    expect(reviews).toHaveLength(1);
    expect(reviews[0].state).toBe('COMMENT');
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
});
