/**
 * The write-tool contract, as a pure module: no `vscode`, no Node built-ins, no
 * I/O. `mcp/tools.ts` (bundled into the headless server *and* run inside the
 * extension host by the broker) and `mcp/server.ts` (the child's launch
 * environment) both import it, and the bundler plugin that walks the MCP
 * entry's chunks would fail the build if anything reachable from it pulled
 * `vscode` in — so the
 * settings-bound half of this feature lives on the host side
 * (`src/mcpServerProvider.ts` reads the switches, `src/mcpWriteAudit.ts`
 * appends the audit file) and this file stays importable from the child.
 *
 * What is decided here, following
 * `docs/design/mcp-write-tools-confirmation.md` (2026-09-28 decision record):
 *
 * - **Two gates, in this order.** Every write tool — the first batch's two and
 *   the second batch's `cancel_action_run` alike — must be opted into per tool
 *   (`forgejoToolkit.mcpWriteTools.<name>`, default `false`) *and* run in a
 *   session the extension host itself established. The second gate — the
 *   "provenance marker" — exists because the first one is unenforceable
 *   without it: the child cannot read extension settings, so the opt-in travels
 *   as `FORGEJO_MCP_WRITE_TOOLS`, and a hand-written `mcp.json` could set that
 *   variable itself. Only a host-established session may write; a token the
 *   child read off its own configuration never authorizes a write (§2, §5).
 * - **A refusal is a successful tool result, not an error** (§5): `isError:
 *   true` reads as "retry and it may work", and the whole point is to make the
 *   agent stop and ask the user for the named setting.
 * - **Write tools carry neither `readOnlyHint: true` nor `destructiveHint:
 *   false`** (§3.2). VS Code shows its per-call confirmation dialog for every
 *   tool that does not claim to be read-only; claiming `destructiveHint: false`
 *   would buy a looser prompt for a call that leaves a public, permanent record
 *   on the server, which is the wrong direction. They also must not claim
 *   `idempotentHint` — the tool has an idempotency key, but only when the caller
 *   passes the same key, and a client that takes the hint at face value would
 *   auto-retry into a duplicate (§6.6).
 */

/**
 * The write tools that have shipped, in the order the stages landed: the first
 * batch's `create_issue_comment` (stage 1) and `submit_pull_review` (stage 2),
 * then the second batch's first candidate `cancel_action_run`, which the
 * decision record reserved for its own switch (§4.1, §13.3). Each has its own
 * switch, and this list is the single spelling used for the tool names, the
 * settings and the provenance marker.
 */
export const MCP_WRITE_TOOL_NAMES = ['create_issue_comment', 'submit_pull_review', 'cancel_action_run'] as const;

export type McpWriteTool = (typeof MCP_WRITE_TOOL_NAMES)[number];

/**
 * The launch-environment key that marks a session as host-established, carrying
 * the comma-separated **tool names** the host enabled (not setting keys — one
 * spelling end to end, so `FORGEJO_MCP_WRITE_TOOLS=createIssueComment` cannot
 * silently mean "no tool named that").
 *
 * `serve_write_tools_from_environment` treats "the variable is absent" as "not
 * established by the extension host". The extension sets it on every
 * definition it provides for an instance that has at least one write switch on
 * (`src/mcpServerProvider.ts`); nothing else ever sets it.
 */
export const MCP_ENV_WRITE_TOOLS = 'FORGEJO_MCP_WRITE_TOOLS';

/**
 * Longest accepted write body, in UTF-8 bytes. Forgejo itself accepts more, so
 * this is not a server contract: it bounds what one approved tool call can push
 * through the stdio/pipe channel and into the audit line, and it keeps a runaway
 * model from turning a comment or review into a megabyte upload. A body over the
 * cap is refused with a validation error before anything is sent.
 */
export const MCP_WRITE_BODY_MAX_BYTES = 64 * 1024;

/** The per-tool switch of one write tool: the key the refusal text names. */
export interface McpWriteToolSetting {
  /** Tool name as it appears in `tools/list`. */
  name: McpWriteTool;
  /** Fully-qualified setting key (`forgejoToolkit.mcpWriteTools.<key>`). */
  settingKey: string;
}

/**
 * The configuration key under `forgejoToolkit.mcpWriteTools` for each tool.
 * Exported because the host reads exactly these (via the fully-qualified key
 * below) and the tests assert the refusal names them.
 */
export const MCP_WRITE_TOOL_SETTING_KEYS: Readonly<Record<McpWriteTool, string>> = {
  create_issue_comment: 'createIssueComment',
  submit_pull_review: 'submitPullReview',
  cancel_action_run: 'cancelActionRun',
};

/** Every write tool with the switch that owns it, in a stable order. */
export const MCP_WRITE_TOOL_SETTINGS: readonly McpWriteToolSetting[] = MCP_WRITE_TOOL_NAMES.map((name) => ({
  name,
  settingKey: `forgejoToolkit.mcpWriteTools.${MCP_WRITE_TOOL_SETTING_KEYS[name]}`,
}));

/** The switch that owns one write tool. */
export function mcpWriteToolSettingKey(tool: McpWriteTool): string {
  return `forgejoToolkit.mcpWriteTools.${MCP_WRITE_TOOL_SETTING_KEYS[tool]}`;
}

/** Narrows a tool name to a write tool. */
export function isMcpWriteTool(name: string): name is McpWriteTool {
  return (MCP_WRITE_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * The annotations of a write tool. Deliberately minimal: `readOnlyHint` is left
 * unset (so VS Code asks before each call — the first gate), `destructiveHint`
 * is left unset rather than `false` (a public, permanent record is not what
 * that hint is for), and `idempotentHint` is `false` so no client retries a
 * mutating call on its own (§3.2, §6.6).
 */
export const WRITE_TOOL_ANNOTATIONS = { idempotentHint: false, openWorldHint: true } as const;

/**
 * One write tool call, as the audit log records it. The field set is fixed by
 * §8/§13.5 — `at`, `caller`, `instance`, `repo`, `target`, `tool`, `dryRun`,
 * `bytes`, `sha256`, `result`, `ms` — and **never** the comment/review body: an
 * Output Channel is something users paste into issues verbatim.
 */
export interface McpWriteAuditRecord {
  /** ISO timestamp of the completed call. */
  at: string;
  /** Who ran the tool: the extension host, or which broker session (§8). */
  caller: string;
  /** `name (id)` of the instance the session serves, or `unknown`. */
  instance: string;
  /** `owner/repo`. */
  repo: string;
  /** `owner/repo#index`; a review's own number travels in `reviewId` (§8). */
  target: string;
  tool: McpWriteTool;
  /** The review a `submit_pull_review` call submits; absent on the other tool. */
  reviewId?: number;
  dryRun: boolean;
  /** UTF-8 bytes of the body; absent when the call carried no body at all. */
  bytes?: number;
  /** SHA-256 (hex) of the body; absent when the call carried no body at all. */
  sha256?: string;
  /** `ok` / `http:<status>` / `refused:<reason>` / `duplicate`. */
  result: string;
  /** Wall-clock duration of the call, milliseconds. */
  ms: number;
}

/**
 * What the caller asked for, as the audit line and the idempotency table both
 * see it. Deliberately not the whole audit record: everything in here is known
 * before the call runs, and `ms`/`result`/`at` are not — so this is what the
 * idempotency table stores besides the replayable response, and what every
 * audit line is built from.
 */
export interface McpWriteAuditDraft {
  tool: McpWriteTool;
  repo: string;
  target: string;
  reviewId?: number;
  dryRun: boolean;
  bytes?: number;
  sha256?: string;
}

/**
 * Who and where an audit line names. `caller` defaults to the extension host
 * because that is the process the tool logic runs in — a broker session passes
 * a more specific string (`extension host (broker session …, cwd …)`), and the
 * instance is a display label that never carries a token or a URL with userinfo.
 */
export function writeAuditRecord(
  workspaceContext: {
    writeCaller?: string;
    writeInstanceLabel?: string;
    instanceId?: string;
  },
  draft: McpWriteAuditDraft,
  result: string,
  ms: number,
): McpWriteAuditRecord {
  return {
    ...draft,
    caller: workspaceContext.writeCaller ?? 'extension host',
    instance: workspaceContext.writeInstanceLabel ?? workspaceContext.instanceId ?? 'unknown',
    at: new Date().toISOString(),
    result,
    ms,
  };
}

/**
 * The instance the plan and the audit line name. Exported so a dry run can label
 * the target exactly the way the audit record of the real call would.
 */
export function writeInstanceLabel(workspaceContext: { writeInstanceLabel?: string; instanceId?: string }): string {
  return workspaceContext.writeInstanceLabel ?? workspaceContext.instanceId ?? 'unknown';
}

/**
 * The replay text of an idempotency hit. Shared because "this is the same
 * logical operation as the one that already ran, and here is its result" is the
 * same sentence for every write tool — only the noun differs, and the noun is
 * carried by the tool that built the response.
 */
export const WRITE_IDEMPOTENCY_REPLAY_MESSAGE =
  'This is a repeat of an earlier call with the same idempotencyKey and the same target and body; ' +
  'the earlier result is returned and nothing new was created.';

/** The reason an audit line carries when a key was reused for a different call. */
export const WRITE_IDEMPOTENCY_REUSE_REASON = 'idempotency-key-reused';

/** The error a key reused for a different call produces. */
export function writeIdempotencyReuseMessage(key: string): string {
  return (
    `idempotencyKey "${key}" was already used in this session for a different call (another tool, ` +
    'or a different target, review, run or body). ' +
    'Generate a new key for a different operation; reuse a key only when retrying the same logical operation.'
  );
}

/**
 * Where an audit record goes, injected into the tool surface so `mcp/tools.ts`
 * can stay free of `vscode` and of the host's logger. The host supplies the
 * Output Channel + optional file implementation (`src/mcpWriteAudit.ts`); the
 * headless child supplies nothing and therefore logs nothing it cannot see,
 * which is correct — a child never writes.
 */
export interface McpWriteAuditSink {
  /** Appends one record. Implementations swallow their own I/O failures. */
  record(entry: McpWriteAuditRecord): Promise<void>;
  /**
   * Appends one line to the Output Channel naming the audit file, the first
   * time it exists (§13.5: "the channel prints one line naming that path").
   * Only the very first record has to carry it.
   */
  recordFilePath(): void;
}

/** The result of the provenance check that gates every write tool call. */
export type McpWriteDecision = 'allowed' | 'disabled' | 'unprovenanced';

/**
 * Whether this session holds the host's provenance marker, and which tools it
 * covers. The marker is a comma-separated list of tool names; unknown names are
 * ignored rather than rejected (a newer host naming a tool this build does not
 * know is not an error), and the variable being **absent or empty** means "not
 * a host-established write session" — which is exactly what the zero-config
 * launch, the anonymous child and a hand-written `mcp.json` all look like.
 */
export function sessionWriteToolsFromEnvironment(value: string | undefined): McpWriteTool[] {
  if (typeof value !== 'string' || value.trim() === '') {
    return [];
  }
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return MCP_WRITE_TOOL_NAMES.filter((name) => names.includes(name));
}

/** True when the launch environment marks the session as host-established. */
export function hasHostProvenance(writeTools: readonly McpWriteTool[]): boolean {
  return writeTools.length > 0;
}

/**
 * The two gates, in the order a user experiences them: provenance first (there
 * is nothing to enable in a session the host did not establish), then the
 * per-tool switch.
 *
 * Membership in both lists is required, and the two are answered by different
 * sides on purpose: `writeTools` is what the launch established this session
 * for, `enabledTools` is what the window's settings currently enable. A forged
 * or stale entry in either one alone therefore never authorizes a write.
 */
export function decideWriteCall(
  tool: McpWriteTool,
  context: { writeTools: readonly McpWriteTool[]; enabledTools: readonly McpWriteTool[] },
): McpWriteDecision {
  if (!context.writeTools.includes(tool)) {
    return 'unprovenanced';
  }
  return context.enabledTools.includes(tool) ? 'allowed' : 'disabled';
}

/** `refused:<reason>` value for the audit line, kept next to the decision. */
export function writeRefusalReason(decision: Exclude<McpWriteDecision, 'allowed'>): string {
  return decision === 'unprovenanced' ? 'no-provenance' : 'tool-disabled';
}

/**
 * The refusal text (§5, §13.8). Rendered as a **successful** tool result so the
 * agent reads it as an answer and asks the user, not as a transient failure to
 * retry. Both branches name the exact setting to turn on.
 */
export function writeRefusalMessage(decision: Exclude<McpWriteDecision, 'allowed'>, tool: McpWriteTool): string {
  const setting = mcpWriteToolSettingKey(tool);
  const tail = 'Do not retry this call: ask the user to change it, then call again.';
  if (decision === 'unprovenanced') {
    return (
      `Tool "${tool}" was refused: this session was not established by the Forgejo Toolkit extension host, so it is not allowed to write. ` +
      `Writing requires a session the extension host itself created (an extension-provided MCP server, or a static mcp.json launch forwarded into the host's broker); ` +
      `a session that only carries a token from your own configuration, or no token at all, can read but never write. ` +
      `If the extension is installed, open a VS Code window with it enabled and enable the setting "${setting}". ${tail}`
    );
  }
  return (
    `Tool "${tool}" was refused: the write tool is not enabled in this session. ` +
    `Ask the user to turn on "${setting}" in the Forgejo Toolkit settings (it is off by default, so the first write of every tool is an explicit opt-in) and call again. ${tail}`
  );
}
