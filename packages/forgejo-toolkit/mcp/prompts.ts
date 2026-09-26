import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * MCP prompts: parameterised instruction templates a user (through the agent
 * host's prompt picker) can invoke to start a well-defined read-only workflow on
 * top of the tool surface in tools.ts.
 *
 * A prompt performs no work itself — it expands into one user message that names
 * the tools to call, the order to call them in, and the answer shape to produce —
 * so unlike the tools it needs no client, no annotations and no result budget.
 * The templates therefore stay honest about the tool layer's own limits (result
 * truncation, read-only access) instead of implying a capability it does not have.
 *
 * Prompt names, descriptions and text are English literals on purpose: they are
 * read by LLM agents, not by users.
 */

/**
 * Prompt arguments arrive as strings.
 *
 * The MCP protocol types the arguments of `prompts/get` as
 * `Record<string, string>` (see GetPromptRequestSchema in the SDK) and the SDK
 * parses them against the registered schema before this module's handlers run,
 * so `index` and `runId` are strings as well — a `z.number()` here would reject
 * every value a conforming client can send. The templates turn the string back
 * into the number the tools expect.
 *
 * Every argument is optional: a prompt must stay invocable with no values
 * supplied, and the template then tells the agent how to resolve the missing
 * value instead of failing.
 *
 * Note the shape a caller has to use: the SDK parses the arguments of
 * `prompts/get` against the object built from this shape, so a request that
 * omits the `arguments` field entirely is rejected before the handler runs — a
 * client with no values to pass must send an empty object. That is the SDK's
 * behaviour in the installed version, not a constraint of these templates, and
 * the templates themselves treat a missing value and an empty string alike.
 */
const ownerArgument = z
  .string()
  .optional()
  .describe('Repository owner (user or organization). Omit to resolve the repository the editor has open.');
const repoArgument = z
  .string()
  .optional()
  .describe('Repository name. Omit to resolve the repository the editor has open.');
const pullRequestIndexArgument = z
  .string()
  .optional()
  .describe('Pull request number, written as a string (for example "42"). Omit to let the agent find it.');
const issueIndexArgument = z
  .string()
  .optional()
  .describe('Issue number, written as a string (for example "7"). Omit to let the agent find it.');
const runIdArgument = z
  .string()
  .optional()
  .describe(
    'Actions workflow run ID, written as a string (for example "1234"). Omit to let the agent find the failing run.',
  );

/** The repository-scoped arguments every prompt accepts. */
interface RepositoryPromptArgs {
  owner?: string;
  repo?: string;
}

/** A prompt about one numbered record (issue or pull request). */
interface IndexedPromptArgs extends RepositoryPromptArgs {
  index?: string;
}

/** The `analyze-ci-failure` arguments. */
interface RunPromptArgs extends RepositoryPromptArgs {
  runId?: string;
}

/**
 * The repository the prompt acts on, in the two cases a caller can be in.
 *
 * The no-argument case is spelled out rather than interpolating an empty value:
 * a prompt invoked from the picker usually carries no context, and every
 * repository-scoped tool needs owner and repo, so the agent has to resolve them
 * from the workspace before its first read. `get_workspace_repository` is the
 * tool that does this without the user typing anything (see tools.ts).
 */
function repositoryTarget(owner?: string, repo?: string): string {
  return owner && repo
    ? `Target repository: \`${owner}/${repo}\`. Pass these exact values as the \`owner\` and \`repo\` arguments of every tool call below.`
    : 'No repository was given. Call `get_workspace_repository` first to determine the repository the editor currently has open, and pass the `owner` and `repo` it returns to every repository-scoped tool below. If it answers that no workspace information is available, ask the user which repository to use instead of guessing.';
}

/** The pull request number, or how to obtain it when the caller omitted it. */
function pullRequestTarget(index?: string): string {
  return index
    ? `Target pull request: #${index}. Pass \`${index}\` as the \`index\` argument of the pull request tools below.`
    : 'No pull request number was given. If the user named one, use it; otherwise call `list_pull_requests` for the target repository and work on the pull request the user is referring to (the most recent open one when the request is ambiguous), and say which number you reviewed. Ask the user when several fit equally.';
}

/** The issue number, or how to obtain it when the caller omitted it. */
function issueTarget(index?: string): string {
  return index
    ? `Target issue: #${index}. Pass \`${index}\` as the \`index\` argument of the issue tools below.`
    : 'No issue number was given. If the user named one, use it; otherwise call `list_issues` for the target repository and triage the issue the user is referring to, saying which number you triaged. Ask the user when several fit equally.';
}

/** The workflow run ID, or how to obtain it when the caller omitted it. */
function runTarget(runId?: string): string {
  return runId
    ? `Target workflow run: \`${runId}\`. Pass it as the \`runId\` argument of the action tools below.`
    : 'No workflow run ID was given. If the user named one, use it; otherwise find the failing run with `list_action_runs` (see the order below) and say which run you analysed.';
}

/** First step of the CI-failure workflow, which depends on whether the run is known. */
function findRunStep(runId?: string): string {
  return runId
    ? `- \`list_action_runs\` is optional here, because the run ID is known (${runId}): call it only if you also need the workflow name, branch or commit for the report.`
    : '- `list_action_runs` — find the failing run: normally the newest run whose status or conclusion says failure. Record its `id`, workflow name, branch and commit so the rest of the analysis stays anchored to one run.';
}

/** The `review-pull-request` template. */
function reviewPullRequestTemplate(args: IndexedPromptArgs): string {
  return [
    'Review a Forgejo pull request. This is a read-only review: never submit a review, approve it, request changes or post a comment — the tools available to you only read, and the finished review belongs in your answer to the user.',
    '',
    repositoryTarget(args.owner, args.repo),
    pullRequestTarget(args.index),
    '',
    'Gather the full context before judging anything, in this order:',
    "- `get_pr_review_brief` — start here: one call returns the pull request header, the diff statistics, each reviewer's latest conclusion and the unresolved inline review comments. Use it to see what you are about to review and what has already been said in code.",
    '- `get_pr_diff` — the unified diff; it is the primary evidence, so read all of it. The brief carries only the line counts.',
    '- `get_pr_timeline` — the comments, review remarks and status changes already on the pull request, so you do not repeat feedback that was already given. The brief carries only the unresolved inline review comments, with their file and line.',
    '- `get_pull_request` — the pull request detail the brief leaves out (the description, the commit list, the status-check list) when the review needs it.',
    "- `list_pull_reviews` — the raw review list, when the brief's `reviewStatus` is truncated or its summary needs checking against the individual reviews.",
    'When a hunk needs the code around it, read the touched file with `get_file_content` and locate related paths with `search_repo_files`.',
    '',
    'Answer with exactly these sections:',
    '- **Summary** — what the change does and what it is for, in 2-4 sentences.',
    '- **Findings** — one bullet per issue, ordered by severity (`critical`, `major`, `minor`, `nit`). Each bullet names the file and line, quotes the diff or code line it is about, states the concrete consequence (bug, regression, security or data-loss risk, missing test) and says whether it blocks the merge.',
    '- **Suggestions** — improvements that are not defects: tests to add, edge cases to cover, simpler alternatives. Keep these separate from the findings.',
    '- **Verdict** — `looks good to merge`, `needs changes` or `needs discussion`, with a one-sentence justification.',
    '',
    'Cite a file and line for every claim. Tool results announce their own truncation (~10 KB per string field, 64 KB per result): when the diff, a file or the timeline was cut off, say which part you could not see and ask for it instead of inferring it.',
  ].join('\n');
}

/** The `analyze-ci-failure` template. */
function analyzeCiFailureTemplate(args: RunPromptArgs): string {
  return [
    'Explain why a Forgejo Actions workflow run failed. Work read-only: inspect runs, jobs and logs, and do not re-run, cancel or otherwise change anything.',
    '',
    repositoryTarget(args.owner, args.repo),
    runTarget(args.runId),
    '',
    'Follow this order:',
    findRunStep(args.runId),
    "- `get_ci_failure_summary` — the preferred single call once the run ID is known: for every failed job it returns the error-looking lines (with context around each) and the last ~100 lines of that job's log, where a failing step prints its error, together with whether and how each log was cut. It needs one call per run and is budgeted, so a job may report that its extraction was shortened or skipped.",
    "- `get_action_run_jobs` — use it when you need the run's full job list with every status, for example to judge whether the failure is isolated or a whole matrix failed; the summary reports the passed jobs only when asked.",
    "- `get_action_job_log` — read one job's raw log only when you need the context around a line the summary flagged. It returns a single log truncated to the first ~10 KB, ending with an explicit truncation marker: for a large log that marker means the important tail was not shown, so do not diagnose from it — say which part you could not see. If a summary job reports `truncatedByClient`, even the summary could not see the real tail, so point the user at the full log in the Forgejo web UI instead of guessing.",
    '',
    'Then answer with:',
    '- **What failed** — the run, the failing job(s) and step(s), and the first concrete error line you actually saw (quoted).',
    '- **Root cause** — the underlying reason rather than the symptom, with the log evidence for it. When the evidence is incomplete, say which part was truncated or missing and present the most likely cause as a hypothesis, not as a fact.',
    '- **Suggested fix** — the change to the workflow, script or dependency that addresses the cause, and how to verify it (which command or job to run).',
    '- **Flakiness check** — whether the failure looks deterministic, judged from the run list and the job statuses, and what to compare against if it does not.',
  ].join('\n');
}

/** The `triage-issue` template. */
function triageIssueTemplate(args: IndexedPromptArgs): string {
  return [
    'Triage a Forgejo issue and propose labels, a priority and the next steps. Work read-only: do not edit the issue, add or remove labels, assign anyone or post a comment — the proposal goes back to the user to apply.',
    '',
    repositoryTarget(args.owner, args.repo),
    issueTarget(args.index),
    '',
    'Gather the facts first:',
    '- `get_issue` — the title, body, author and comment thread, including the labels, assignees and milestone the issue already carries.',
    '- `list_labels` — the labels this repository actually has. Only propose labels from that list, spelled exactly as it spells them; when none fits, say so and describe the label that would have to be created instead of inventing one.',
    '- `get_repo` — repository details (owner, default branch, recent activity) to judge how actively it is maintained and who the natural owner of the affected area is.',
    'Before proposing a priority, look for an existing duplicate with `search` (type "issues", keywords from the title); when one exists, say so and name its number.',
    '',
    'Then answer with:',
    '- **Suggested labels** — each proposed label with a one-line reason, all drawn from `list_labels`.',
    '- **Priority** — one of `critical`, `high`, `medium`, `low`, with the evidence behind it (crash, data loss, security, blocked users, regression, cosmetic) and whether the issue looks like a duplicate or a needs-information case.',
    '- **Next steps** — the concrete actions in order: who should look at it, what to reproduce, which files to read first, and whether it needs a milestone.',
    '- **Missing information** — what the issue does not say yet (version, steps to reproduce, logs, expected behavior) and the exact question to ask the reporter, when something is missing.',
  ].join('\n');
}

/**
 * Wraps a rendered template into the single user message a prompt returns. The
 * description is short and English, matching the prompt metadata, so a host that
 * shows only the expansion still has a summary of what it is.
 */
function promptMessage(description: string, text: string): GetPromptResult {
  return { description, messages: [{ role: 'user', content: { type: 'text', text } }] };
}

/**
 * Registers the read-only prompt templates. Kept next to `registerTools` and
 * called from the same place (see mcpServer.ts): the prompts are an entry point
 * onto the tool surface, not a second implementation of it, so a prompt may only
 * name tools that actually exist there.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'review-pull-request',
    {
      title: 'Review a pull request',
      description:
        'Read-only review of a pull request: start from the review brief (diff statistics, reviewer conclusions and unresolved inline comments), then read the diff and timeline as far as the review needs them, and report a summary, severity-ordered findings and suggestions. Never submits a review.',
      argsSchema: { owner: ownerArgument, repo: repoArgument, index: pullRequestIndexArgument },
    },
    (args) => promptMessage('Read-only review of a pull request.', reviewPullRequestTemplate(args)),
  );

  server.registerPrompt(
    'analyze-ci-failure',
    {
      title: 'Analyze a CI failure',
      description:
        'Diagnose why a Forgejo Actions run failed: find the run, read its CI failure summary (error-looking lines plus the tail of each failed job log), then report the root cause, a suggested fix and whether the failure looks flaky.',
      argsSchema: { owner: ownerArgument, repo: repoArgument, runId: runIdArgument },
    },
    (args) => promptMessage('Root-cause analysis of a failed Actions run.', analyzeCiFailureTemplate(args)),
  );

  server.registerPrompt(
    'triage-issue',
    {
      title: 'Triage an issue',
      description:
        'Triage an issue: read the issue and its comments, match the repository label set, then propose labels, a priority and the next steps for the user to apply.',
      argsSchema: { owner: ownerArgument, repo: repoArgument, index: issueIndexArgument },
    },
    (args) => promptMessage('Triage an issue into labels, priority and next steps.', triageIssueTemplate(args)),
  );
}
