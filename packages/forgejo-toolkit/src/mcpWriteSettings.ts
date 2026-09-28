import * as vscode from 'vscode';
import { MCP_WRITE_TOOL_SETTING_KEYS, MCP_WRITE_TOOL_SETTINGS, type McpWriteTool } from '../mcp/writeTools';
import { createMcpWriteAuditSink, MCP_WRITE_AUDIT_FILE_NAME, type McpWriteAuditLogger } from './mcpWriteAudit';
import type { McpWriteAuditSink } from '../mcp/writeTools';

/**
 * The host-side half of the write-tool settings: reading the per-tool switches
 * and building the audit sink. Kept in one module so the two readers —
 * `src/mcpServerProvider.ts` (what a definition advertises) and
 * `src/mcpBroker.ts` (what a session is actually allowed to do) — cannot drift.
 *
 * The switches are read through the container object
 * (`forgejoToolkit.mcpWriteTools`) rather than one `get` per tool for the same
 * reason `src/mcpServerProvider.ts` reads `mcpEnabled` as `unknown`: a
 * hand-edited `settings.json` can hold any JSON type under a key, and only an
 * explicit `true` may enable a write tool. Anything else — missing, `false`,
 * `"true"`, `1` — is off, which is the safe direction for a switch that lets an
 * agent leave public records on an instance.
 */

/** The settings section every key of this extension lives under. */
const SETTINGS_SECTION = 'forgejoToolkit';

/** The container key holding one boolean per write tool. */
export const MCP_WRITE_TOOLS_KEY = 'mcpWriteTools';

/** The fully-qualified setting that turns write-tool file logging on. */
export const MCP_WRITE_AUDIT_TO_FILE_SETTING = `${SETTINGS_SECTION}.mcpWriteAuditToFile`;

/**
 * The write tools this window's settings enable, in the stable order of
 * `MCP_WRITE_TOOL_SETTINGS`. Read fresh on every call: a switch turned on in a
 * running window applies to the next broker session without a reload, because
 * the value is computed at session establishment (see createBrokerMcpServer).
 */
export function enabledMcpWriteTools(): McpWriteTool[] {
  let raw: unknown;
  try {
    raw = vscode.workspace.getConfiguration(SETTINGS_SECTION).get(MCP_WRITE_TOOLS_KEY);
  } catch {
    // A configuration read that throws must mean "nothing enabled", never a
    // failed activation.
    return [];
  }
  if (typeof raw !== 'object' || raw === null) {
    return [];
  }
  const container = raw as Record<string, unknown>;
  return MCP_WRITE_TOOL_SETTINGS.filter((setting) => container[MCP_WRITE_TOOL_SETTING_KEYS[setting.name]] === true).map(
    (setting) => setting.name,
  );
}

/** Whether the window wants the write-tool audit mirrored to a file. */
export function isMcpWriteAuditToFileEnabled(): boolean {
  try {
    return vscode.workspace.getConfiguration(SETTINGS_SECTION).get<boolean>('mcpWriteAuditToFile', false) === true;
  } catch {
    return false;
  }
}

/**
 * The audit sink for this window: the Output Channel always, plus
 * `mcp-write-audit.jsonl` under `context.logUri` when
 * `forgejoToolkit.mcpWriteAuditToFile` is on. Built once per MCP surface start
 * and handed to every broker session (`src/mcpBroker.ts`), so all sessions of
 * one window append to the same file.
 */
export function createWindowWriteAuditSink(
  context: vscode.ExtensionContext,
  logger: McpWriteAuditLogger,
): McpWriteAuditSink {
  return createMcpWriteAuditSink({
    logger,
    filePath: isMcpWriteAuditToFileEnabled() ? mcpWriteAuditFilePath(context) : undefined,
  });
}

/**
 * `context.logUri` holds the extension's own log directory — the one VS Code's
 * "Open Logs Folder" command opens — so the audit file sits next to the
 * extension's other logs rather than in globalStorage. `logUri` is optional on
 * older hosts; without it the audit stays in the Output Channel.
 */
function mcpWriteAuditFilePath(context: vscode.ExtensionContext): string | undefined {
  const logDirectory = context.logUri?.fsPath;
  if (!logDirectory) {
    return undefined;
  }
  return vscode.Uri.joinPath(context.logUri, MCP_WRITE_AUDIT_FILE_NAME).fsPath;
}
