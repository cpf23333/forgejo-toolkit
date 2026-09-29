import { describe, it, expect } from 'vitest';
import {
  decideWriteCall,
  isMcpWriteTool,
  MCP_ENV_WRITE_TOOLS,
  MCP_WRITE_TOOL_NAMES,
  MCP_WRITE_TOOL_SETTINGS,
  mcpWriteToolSettingKey,
  hasHostProvenance,
  sessionWriteToolsFromEnvironment,
  writeAuditRecord,
  writeInstanceLabel,
  writeRefusalMessage,
  writeRefusalReason,
  WRITE_TOOL_ANNOTATIONS,
} from '../writeTools';

/**
 * The write-tool contract is pure on purpose (mcp/writeTools.ts): these tests
 * run without `vscode`, without MSW and without a server, and they are the ones
 * that pin the two gates, the setting names and the annotation skeleton.
 */
describe('write tool surface', () => {
  it('names the tools and the settings the decision record fixed', () => {
    // §13.7: the underscore, verb-first names; §13.2: one switch per tool; the
    // third name is the second batch's first candidate (§13.3).
    expect([...MCP_WRITE_TOOL_NAMES]).toEqual(['create_issue_comment', 'submit_pull_review', 'cancel_action_run']);
    expect(MCP_WRITE_TOOL_SETTINGS.map((setting) => setting.settingKey)).toEqual([
      'forgejoToolkit.mcpWriteTools.createIssueComment',
      'forgejoToolkit.mcpWriteTools.submitPullReview',
      'forgejoToolkit.mcpWriteTools.cancelActionRun',
    ]);
    expect(mcpWriteToolSettingKey('create_issue_comment')).toBe('forgejoToolkit.mcpWriteTools.createIssueComment');
    expect(mcpWriteToolSettingKey('cancel_action_run')).toBe('forgejoToolkit.mcpWriteTools.cancelActionRun');
    expect(isMcpWriteTool('create_issue_comment')).toBe(true);
    expect(isMcpWriteTool('cancel_action_run')).toBe(true);
    expect(isMcpWriteTool('get_issue')).toBe(false);
  });

  it('never lets a write tool claim to be read-only or non-destructive', () => {
    // §3.2: the annotations are the first gate. Claiming read-only skips VS
    // Code's per-call confirmation; claiming `destructiveHint: false` would buy
    // a looser prompt for a call that leaves a public permanent record. A
    // regression here silently removes the human-in-the-loop step.
    expect(WRITE_TOOL_ANNOTATIONS).not.toHaveProperty('readOnlyHint');
    expect(WRITE_TOOL_ANNOTATIONS).not.toHaveProperty('destructiveHint');
    // §6.6: an idempotent hint would invite a client-side auto-retry that
    // duplicates a comment when the caller did not pass the same key.
    expect(WRITE_TOOL_ANNOTATIONS.idempotentHint).toBe(false);
    // …and read as the SDK's own annotation shape, where all five fields are
    // optional: an absent key is what the wire carries, and a set-but-wrong one
    // is what the next two assertions would have to catch.
    const annotations = WRITE_TOOL_ANNOTATIONS as {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
    };
    expect(annotations.readOnlyHint).not.toBe(true);
    expect(annotations.destructiveHint).not.toBe(false);
  });

  it('parses the provenance marker the extension host writes', () => {
    expect(MCP_ENV_WRITE_TOOLS).toBe('FORGEJO_MCP_WRITE_TOOLS');
    expect(sessionWriteToolsFromEnvironment('create_issue_comment')).toEqual(['create_issue_comment']);
    expect(sessionWriteToolsFromEnvironment(' create_issue_comment , submit_pull_review ')).toEqual([
      'create_issue_comment',
      'submit_pull_review',
    ]);
    // The third tool travels by the same name-only spelling, and the parsed
    // list keeps the contract's order rather than the marker's.
    expect(sessionWriteToolsFromEnvironment('cancel_action_run,create_issue_comment')).toEqual([
      'create_issue_comment',
      'cancel_action_run',
    ]);
    // A tool this build does not know is ignored, not fatal: a newer host may
    // advertise one, and the safe reading of "unknown" is "not enabled here".
    expect(sessionWriteToolsFromEnvironment('create_issue_comment,create_issue')).toEqual(['create_issue_comment']);
    // Unknown-to-this-build and empty mean the same thing to the gate.
    expect(sessionWriteToolsFromEnvironment('create_issue')).toEqual([]);
  });

  it('treats an absent, empty or non-string marker as "not host-established"', () => {
    // §5: every route that is not an extension-provided definition — the
    // zero-configuration launch, an anonymous direct server, a hand-written
    // mcp.json — lands here, and must not write.
    for (const value of [undefined, '', '   ', ',', ',,']) {
      expect(sessionWriteToolsFromEnvironment(value)).toEqual([]);
    }
    expect(hasHostProvenance([])).toBe(false);
    expect(hasHostProvenance(['create_issue_comment'])).toBe(true);
    expect(hasHostProvenance(['cancel_action_run'])).toBe(true);
  });

  it('checks provenance before the per-tool switch', () => {
    const tool = 'create_issue_comment';
    // No marker: even a switch that is on cannot help, because the session was
    // not established by the host.
    expect(decideWriteCall(tool, { writeTools: [], enabledTools: [tool] })).toBe('unprovenanced');
    // Marker present, switch off: the second gate.
    expect(decideWriteCall(tool, { writeTools: [tool], enabledTools: [] })).toBe('disabled');
    expect(decideWriteCall(tool, { writeTools: [tool], enabledTools: [tool] })).toBe('allowed');
    // The two lists are answered by different sides (the launch environment vs
    // this window's settings), so membership in both is required: a session
    // whose marker did not cover this tool is not a provenanced write session
    // for it, and a switch turned on where the tool was never established is off.
    expect(decideWriteCall(tool, { writeTools: ['submit_pull_review'], enabledTools: [tool] })).toBe('unprovenanced');
    expect(decideWriteCall(tool, { writeTools: [tool], enabledTools: ['submit_pull_review'] })).toBe('disabled');
    expect(writeRefusalReason('unprovenanced')).toBe('no-provenance');
    expect(writeRefusalReason('disabled')).toBe('tool-disabled');
  });

  it('names the setting to turn on, in both refusal texts', () => {
    // §13.8: the refusal must point the caller at the exact setting, so it can
    // tell the user instead of retrying in place.
    const disabled = writeRefusalMessage('disabled', 'create_issue_comment');
    expect(disabled).toContain('forgejoToolkit.mcpWriteTools.createIssueComment');
    expect(disabled).toMatch(/not enabled in this session/);
    expect(disabled).toMatch(/Do not retry/);

    const unprovenanced = writeRefusalMessage('unprovenanced', 'create_issue_comment');
    expect(unprovenanced).toContain('forgejoToolkit.mcpWriteTools.createIssueComment');
    expect(unprovenanced).toMatch(/not established by the Forgejo Toolkit extension host/);
    expect(unprovenanced).toMatch(/Do not retry/);

    // The stage-2 tool's message must name the stage-2 setting, not stage 1's.
    expect(writeRefusalMessage('disabled', 'submit_pull_review')).toContain(
      'forgejoToolkit.mcpWriteTools.submitPullReview',
    );

    // …and the second batch's tool names its own switch, not either of theirs.
    const cancel = writeRefusalMessage('disabled', 'cancel_action_run');
    expect(cancel).toContain('forgejoToolkit.mcpWriteTools.cancelActionRun');
    expect(cancel).not.toContain('createIssueComment');
    expect(cancel).not.toContain('submitPullReview');
    expect(writeRefusalMessage('unprovenanced', 'cancel_action_run')).toContain(
      'forgejoToolkit.mcpWriteTools.cancelActionRun',
    );
  });

  it('builds one audit record with the fixed field set, for either tool', () => {
    // §8/§13.5 fix the fields; both tools go through this one builder, so the
    // set cannot drift between them. The body is never a field: only its byte
    // count and digest are, and only when the call carried a body at all.
    const comment = writeAuditRecord(
      { writeCaller: 'extension host (broker session, cwd demo)', writeInstanceLabel: 'Demo (instance-1)' },
      {
        tool: 'create_issue_comment',
        repo: 'demo-user/demo-repo',
        target: 'demo-user/demo-repo#12',
        dryRun: false,
        bytes: 10,
        sha256: 'a'.repeat(64),
      },
      'ok',
      42,
    );
    expect(Object.keys(comment).sort()).toEqual(
      ['at', 'bytes', 'caller', 'dryRun', 'instance', 'ms', 'repo', 'result', 'sha256', 'target', 'tool'].sort(),
    );
    expect(comment.caller).toBe('extension host (broker session, cwd demo)');
    expect(comment.instance).toBe('Demo (instance-1)');
    expect(comment.result).toBe('ok');
    expect(comment.ms).toBe(42);
    expect(comment.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(comment).not.toHaveProperty('body');

    // The review tool adds exactly one field, `reviewId`, and with no body the
    // two body fields are absent rather than zero or an empty digest — a
    // body-less COMMENT review is a legitimate call.
    const review = writeAuditRecord(
      {},
      {
        tool: 'submit_pull_review',
        repo: 'demo-user/demo-repo',
        target: 'demo-user/demo-repo#12',
        reviewId: 7,
        dryRun: true,
      },
      'duplicate',
      0,
    );
    expect(Object.keys(review).sort()).toEqual(
      ['at', 'caller', 'dryRun', 'instance', 'ms', 'repo', 'result', 'reviewId', 'target', 'tool'].sort(),
    );
    expect(review.reviewId).toBe(7);
    expect(review.bytes).toBeUndefined();
    expect(review.sha256).toBeUndefined();
    // Defaults: the extension host is where the tool logic runs, and an
    // unknown instance is named as such rather than left empty.
    expect(review.caller).toBe('extension host');
    expect(review.instance).toBe('unknown');
    expect(writeInstanceLabel({ instanceId: 'instance-9' })).toBe('instance-9');
    expect(writeInstanceLabel({ writeInstanceLabel: 'Demo (instance-9)', instanceId: 'instance-9' })).toBe(
      'Demo (instance-9)',
    );

    // The third tool is body-less by construction, so its line carries the base
    // field set and nothing else — no `reviewId` and, with no body at all, no
    // `bytes`/`sha256` either. Absent, not zero: §8's rule for a call that
    // carried no body.
    const cancel = writeAuditRecord(
      {},
      { tool: 'cancel_action_run', repo: 'demo-user/demo-repo', target: 'demo-user/demo-repo#7', dryRun: false },
      'refused:tool-disabled',
      3,
    );
    expect(Object.keys(cancel).sort()).toEqual(
      ['at', 'caller', 'dryRun', 'instance', 'ms', 'repo', 'result', 'target', 'tool'].sort(),
    );
    expect(cancel.tool).toBe('cancel_action_run');
    expect(cancel.target).toBe('demo-user/demo-repo#7');
    expect(cancel.bytes).toBeUndefined();
    expect(cancel.sha256).toBeUndefined();
    expect(cancel.reviewId).toBeUndefined();
  });
});
