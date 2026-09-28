import * as fs from 'fs';
import * as path from 'path';
import type { McpWriteAuditRecord, McpWriteAuditSink } from '../mcp/writeTools';

/**
 * Where a write tool's audit record goes (§8 and its 2026-09-28 decisions in
 * `docs/design/mcp-write-tools-confirmation.md`).
 *
 * Two destinations, one text:
 *
 * - the `Forgejo Toolkit` Output Channel, which is the default and needs no
 *   setting (the channel is the same one the extension logs to);
 * - optionally, `mcp-write-audit.jsonl` under the extension's log directory
 *   (`forgejoToolkit.mcpWriteAuditToFile`, default off, so the default
 *   behaviour is "Output Channel only"), appended as JSON Lines. The channel
 *   then also prints one line naming that path, so the user can find the file
 *   ("Open Logs Folder" opens the directory).
 *
 * The record text is identical in both places: one JSON object, one line. The
 * channel is *not* given the usual `[INFO] <timestamp>` prefix for these
 * lines — the design asks for the same text in both sinks, and the timestamp is
 * already inside the record as `at`. That is why this module writes through the
 * small `info`/`debug`/`error` shape below instead of a richer logger.
 *
 * This file is host-only (it imports `fs` and is only ever loaded inside the
 * extension host, by `src/mcpBroker.ts`); the child gets the sink as an injected
 * value via `mcp/tools.ts`'s `WorkspaceContextOptions.writeAudit`, which is why
 * the *pure* half — the record type and the JSON serialization — lives in
 * `mcp/writeTools.ts`.
 */

/** The fixed file name under the extension's log directory. */
export const MCP_WRITE_AUDIT_FILE_NAME = 'mcp-write-audit.jsonl';

/**
 * Size at which the active file is rolled before the next append. 1 MB is the
 * decided cap (§13.5); the roll happens *before* an append that would exceed
 * it, so the active file is bounded by construction.
 */
export const MCP_WRITE_AUDIT_MAX_BYTES = 1024 * 1024;

/**
 * How many rolled files are kept (`mcp-write-audit.jsonl.1`, `.2`). Together
 * with the active file that is "1 MB cap + two rolled files", so the directory
 * is bounded at roughly 3 MB.
 */
export const MCP_WRITE_AUDIT_ROLLED_FILES = 2;

/** The slice of `src/logger.ts` this module needs (and the mocks provide). */
export interface McpWriteAuditLogger {
  info(message: string): void;
  debug(message: string): void;
  error(message: string): void;
}

/**
 * Serializes one record as the single line both sinks receive. Exported so the
 * tests can assert the exact contract and so nothing re-implements the field
 * order.
 */
export function formatMcpWriteAuditRecord(record: McpWriteAuditRecord): string {
  // Field order is fixed for readability, not for semantics: `at` first (when),
  // then who/where, then what, then the outcome.
  const ordered: Record<string, unknown> = {
    at: record.at,
    caller: record.caller,
    instance: record.instance,
    repo: record.repo,
    target: record.target,
    tool: record.tool,
    dryRun: record.dryRun,
    ...(record.bytes === undefined ? {} : { bytes: record.bytes }),
    ...(record.sha256 === undefined ? {} : { sha256: record.sha256 }),
    result: record.result,
    ms: record.ms,
  };
  return JSON.stringify(ordered);
}

/** The rolled file a given index uses (`.1` is the newest). */
function rolledPath(filePath: string, index: number): string {
  return `${filePath}.${index}`;
}

/**
 * Appends one line, rolling the file first when it would grow past the cap.
 *
 * Rotation is rename-based and lossless in the direction that matters: the
 * newest rolled file is dropped only after the older ones have been shifted, so
 * a crash mid-rotation can lose at most the oldest records. Sizes come from
 * `stat`, i.e. the real file, not from a count kept in memory — several windows
 * can have the extension running and each of them appends.
 */
export async function appendMcpWriteAuditLine(lines: {
  filePath: string;
  line: string;
  maxBytes?: number;
  rolledFiles?: number;
}): Promise<void> {
  const maxBytes = lines.maxBytes ?? MCP_WRITE_AUDIT_MAX_BYTES;
  const rolled = lines.rolledFiles ?? MCP_WRITE_AUDIT_ROLLED_FILES;
  const data = `${lines.line}\n`;
  const size = await fs.promises
    .stat(lines.filePath)
    .then((stats) => stats.size)
    .catch(() => 0);
  if (size + Buffer.byteLength(data, 'utf8') > maxBytes) {
    // Shift .<n-1> → .<n> downwards, dropping the oldest, then rotate the active
    // file into .1. `rename` replaces an existing target on both Windows and
    // unix, so no unlink is needed first.
    await fs.promises.rm(rolledPath(lines.filePath, rolled), { force: true }).catch(() => undefined);
    for (let index = rolled - 1; index >= 1; index -= 1) {
      await fs.promises
        .rename(rolledPath(lines.filePath, index), rolledPath(lines.filePath, index + 1))
        .catch(() => undefined);
    }
    await fs.promises.rename(lines.filePath, rolledPath(lines.filePath, 1)).catch(() => undefined);
  }
  await fs.promises.mkdir(path.dirname(lines.filePath), { recursive: true });
  await fs.promises.appendFile(lines.filePath, data, 'utf8');
}

export interface McpWriteAuditSinkOptions {
  logger: McpWriteAuditLogger;
  /**
   * The audit file's absolute path, when file logging is on. Absent means
   * Output-Channel-only, which is the default.
   */
  filePath?: string | undefined;
}

/**
 * Builds the sink `mcp/tools.ts` records through.
 *
 * Both destinations are best-effort: a failing append logs one error line and
 * never propagates, because the audit describes a write that has already
 * happened — turning an unwritable log file into a failed tool call would be
 * the tail wagging the dog. (The tool surface also swallows a throwing sink, so
 * this is belt and braces.)
 */
export function createMcpWriteAuditSink(options: McpWriteAuditSinkOptions): McpWriteAuditSink {
  const { logger, filePath } = options;
  let announcedFilePath = false;
  let fileFailureLogged = false;

  return {
    async record(record) {
      const line = formatMcpWriteAuditRecord(record);
      logger.info(line);
      if (!filePath) {
        return;
      }
      try {
        await appendMcpWriteAuditLine({ filePath, line });
      } catch (error) {
        if (!fileFailureLogged) {
          fileFailureLogged = true;
          logger.error(
            `Write audit file append failed (${error instanceof Error ? error.message : String(error)}); the audit stays in this Output Channel only.`,
          );
        }
      }
    },
    recordFilePath() {
      if (!filePath || announcedFilePath) {
        return;
      }
      announcedFilePath = true;
      logger.info(
        `Write-tool audit records are also appended to ${filePath} (JSON Lines, 1 MB cap with ${MCP_WRITE_AUDIT_ROLLED_FILES} rolled files).`,
      );
    },
  };
}
