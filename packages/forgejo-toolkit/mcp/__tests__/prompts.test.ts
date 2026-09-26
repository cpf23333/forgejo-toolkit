import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ForgejoClient } from '../../src/api/client';
import { createMcpServer } from '../mcpServer';

/**
 * The prompt surface as an agent host sees it: a real MCP client over
 * InMemoryTransport, so these tests cover the registered metadata
 * (prompts/list), the SDK's argument parsing, and the text the agent actually
 * receives (prompts/get). No MSW mock server is started — a prompt only expands
 * into a message and issues no HTTP request.
 */

/** The prompt surface, with the arguments each template declares. */
const EXPECTED_PROMPTS = [
  { name: 'analyze-ci-failure', arguments: ['owner', 'repo', 'runId'] },
  { name: 'review-pull-request', arguments: ['owner', 'repo', 'index'] },
  { name: 'triage-issue', arguments: ['owner', 'repo', 'index'] },
] as const;

interface PromptMessageResult {
  description?: string;
  messages: { role: string; content: { type: string; text?: string } }[];
}

/**
 * Runs one observation against a freshly wired server, then tears the pair
 * down. Each test builds its own server: prompt registration is per-server
 * state, and a shared instance would hide a template that only works after
 * another prompt was registered.
 */
async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const server = createMcpServer(new ForgejoClient('https://forgejo.example.com', 'mock-token'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcp-test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/** The text of every message a template returned, joined for substring checks. */
function messageText(result: PromptMessageResult): string {
  return result.messages.map((message) => message.content.text ?? '').join('\n');
}

/**
 * Fetches one prompt and asserts the shape every expansion must have.
 *
 * `arguments` is always sent, even when the test wants the no-values case: the
 * SDK parses `prompts/get` against the registered argument object, and a request
 * that omits the field entirely is rejected before the template runs. An empty
 * object is the protocol's way of passing no values, and is what a host sends
 * when the user leaves every argument blank.
 */
async function getPromptText(name: string, args: Record<string, string> = {}): Promise<string> {
  return withClient(async (client) => {
    const result = (await client.getPrompt({ name, arguments: args })) as unknown as PromptMessageResult;
    expect(result.messages.length).toBeGreaterThan(0);
    expect(
      result.messages.every((message) => message.role === 'user' && message.content.type === 'text'),
      `${name} must expand into user text messages`,
    ).toBe(true);
    return messageText(result);
  });
}

describe('MCP prompts over InMemoryTransport', () => {
  it('lists exactly the three prompt templates, each with only optional arguments', async () => {
    await withClient(async (client) => {
      const { prompts } = await client.listPrompts();
      expect(prompts.map((prompt) => prompt.name).sort()).toEqual(EXPECTED_PROMPTS.map((prompt) => prompt.name));

      for (const expected of EXPECTED_PROMPTS) {
        const prompt = prompts.find((candidate) => candidate.name === expected.name);
        expect(prompt?.description, expected.name).toBeTruthy();
        expect(prompt?.arguments?.map((argument) => argument.name).sort(), `${expected.name} argument names`).toEqual(
          [...expected.arguments].sort(),
        );
        // Every argument is optional: a host must be able to invoke a template
        // from an empty picker, and the template then resolves the value itself.
        expect(
          prompt?.arguments?.every((argument) => argument.required === false),
          `${expected.name} arguments must all be optional`,
        ).toBe(true);
        expect(
          prompt?.arguments?.every((argument) => Boolean(argument.description)),
          `${expected.name} arguments must be described`,
        ).toBe(true);
      }
    });
  });

  it('substitutes the repository and pull request number into review-pull-request', async () => {
    const text = await getPromptText('review-pull-request', {
      owner: 'demo-user',
      repo: 'demo-repo',
      index: '42',
    });

    expect(text).toContain('demo-user/demo-repo');
    expect(text).toContain('#42');
    expect(text).not.toContain('No repository was given');
    // The template has to name the tool sequence, not just ask for a review.
    for (const tool of ['get_pull_request', 'get_pr_diff', 'get_pr_timeline', 'list_pull_reviews']) {
      expect(text, tool).toContain(tool);
    }
    // The brief is the entry point and the detail tools the fallback: the
    // template must send the agent to the brief first.
    expect(text).toContain('`get_pr_review_brief`');
    expect(text.indexOf('`get_pr_review_brief`')).toBeLessThan(text.indexOf('`get_pr_diff`'));
    expect(text.indexOf('`get_pr_review_brief`')).toBeLessThan(text.indexOf('`get_pr_timeline`'));
    // A review prompt must not read as an invitation to submit one.
    expect(text).toContain('read-only');
    expect(text).toContain('never submit a review');
  });

  it('points review-pull-request at the workspace repository when no arguments were given', async () => {
    const text = await getPromptText('review-pull-request');

    expect(text).toContain('get_workspace_repository');
    expect(text).toContain('No repository was given');
    // Without a number the agent has to find the pull request first.
    expect(text).toContain('list_pull_requests');
    expect(text).toContain('No pull request number was given');
    // The workspace lookup must come before the first read of the pull request.
    expect(text.indexOf('get_workspace_repository')).toBeLessThan(text.indexOf('`get_pull_request`'));
  });

  it('substitutes the run ID into analyze-ci-failure and prefers the failure summary', async () => {
    const text = await getPromptText('analyze-ci-failure', {
      owner: 'demo-user',
      repo: 'demo-repo',
      runId: '1234',
    });

    expect(text).toContain('demo-user/demo-repo');
    expect(text).toContain('1234');
    expect(text).not.toContain('No repository was given');
    expect(text).not.toContain('No workflow run ID was given');
    for (const tool of ['list_action_runs', 'get_ci_failure_summary', 'get_action_run_jobs', 'get_action_job_log']) {
      expect(text, tool).toContain(tool);
    }
    // The summary is the preferred call and the raw log tool only the fallback
    // for a specific line: the template must not send the agent to the raw log
    // first.
    expect(text.indexOf('`get_ci_failure_summary`')).toBeLessThan(text.indexOf('`get_action_job_log`'));
    // The raw log tool truncates from the start, and the failure is at the end:
    // the template has to tell the agent which end it is missing.
    expect(text).toContain('truncation marker');
    expect(text).toContain('tail');
    expect(text).toContain('web UI');
  });

  it('walks analyze-ci-failure through list_action_runs when the run is unknown', async () => {
    const text = await getPromptText('analyze-ci-failure', { owner: 'demo-user', repo: 'demo-repo' });

    expect(text).toContain('No workflow run ID was given');
    expect(text).toContain('list_action_runs');
    expect(text).toContain('get_action_run_jobs');
  });

  it('falls back to the workspace repository for analyze-ci-failure without arguments', async () => {
    const text = await getPromptText('analyze-ci-failure');

    expect(text).toContain('get_workspace_repository');
    expect(text).toContain('No repository was given');
    expect(text.indexOf('get_workspace_repository')).toBeLessThan(text.indexOf('`list_action_runs`'));
  });

  it('substitutes the repository and issue number into triage-issue', async () => {
    const text = await getPromptText('triage-issue', {
      owner: 'demo-user',
      repo: 'demo-repo',
      index: '7',
    });

    expect(text).toContain('demo-user/demo-repo');
    expect(text).toContain('#7');
    expect(text).not.toContain('No repository was given');
    for (const tool of ['get_issue', 'list_labels', 'get_repo']) {
      expect(text, tool).toContain(tool);
    }
    // The requested output: labels, a priority and next steps.
    expect(text).toContain('Suggested labels');
    expect(text).toContain('Priority');
    expect(text).toContain('Next steps');
    // Triage is a proposal, not an edit.
    expect(text).toContain('read-only');
    expect(text).toContain('do not edit the issue');
  });

  it('resolves the repository and issue for triage-issue when no arguments were given', async () => {
    const text = await getPromptText('triage-issue');

    expect(text).toContain('get_workspace_repository');
    expect(text).toContain('No repository was given');
    expect(text).toContain('list_issues');
    expect(text).toContain('No issue number was given');
    expect(text.indexOf('get_workspace_repository')).toBeLessThan(text.indexOf('`get_issue`'));
  });

  it('keeps the prompt templates read-only across the whole surface', async () => {
    // Prompts have no side effects of their own, but they steer an agent that
    // does have tools: each template must repeat the read-only constraint so an
    // expansion cannot be read as permission to write.
    for (const { name } of EXPECTED_PROMPTS) {
      const text = await getPromptText(name);
      expect(text, name).toContain('read-only');
    }
  });
});
