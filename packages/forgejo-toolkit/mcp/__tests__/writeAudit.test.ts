import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  appendMcpWriteAuditLine,
  createMcpWriteAuditSink,
  formatMcpWriteAuditRecord,
  MCP_WRITE_AUDIT_MAX_BYTES,
  MCP_WRITE_AUDIT_ROLLED_FILES,
} from '../../src/mcpWriteAudit';
import type { McpWriteAuditRecord } from '../writeTools';
import { removeTempDir } from '../../src/__tests__/tempDir';

const RECORD: McpWriteAuditRecord = {
  at: '2026-09-28T10:00:00.000Z',
  caller: 'extension host (broker session for instance-1, cwd D:\\work\\demo)',
  instance: 'instance-1',
  repo: 'demo-user/demo-repo',
  target: 'demo-user/demo-repo#12',
  tool: 'create_issue_comment',
  dryRun: false,
  bytes: 83,
  sha256: 'a'.repeat(64),
  result: 'ok',
  ms: 42,
};

describe('write audit serialization', () => {
  it('emits the fixed field set in one JSON line', () => {
    const line = formatMcpWriteAuditRecord(RECORD);
    expect(line).not.toContain('\n');
    expect(Object.keys(JSON.parse(line) as Record<string, unknown>)).toEqual([
      'at',
      'caller',
      'instance',
      'repo',
      'target',
      'tool',
      'dryRun',
      'bytes',
      'sha256',
      'result',
      'ms',
    ]);
  });

  it('omits the body fields when the call carried no body at all', () => {
    // A refusal before the body existed is still audited; `undefined` fields
    // must not serialize as `null` and read as "zero-byte body".
    const { bytes: _bytes, sha256: _sha256, ...rest } = RECORD;
    const parsed = JSON.parse(formatMcpWriteAuditRecord(rest)) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('bytes');
    expect(parsed).not.toHaveProperty('sha256');
  });

  it('never carries the comment text — only its size and digest', () => {
    // §8: an Output Channel is something users paste into issues verbatim.
    const secret = 'THIS-IS-THE-COMMENT-BODY';
    const line = formatMcpWriteAuditRecord({ ...RECORD, bytes: Buffer.byteLength(secret, 'utf8') });
    expect(line).not.toContain(secret);
  });

  it('carries the review id only for the tool that has one', () => {
    // The review tool refines `target` with the review it submits; leaving the
    // field out of the serializer would drop it from both sinks, since both are
    // written from this one function.
    const review = formatMcpWriteAuditRecord({
      ...RECORD,
      tool: 'submit_pull_review',
      reviewId: 100,
      bytes: undefined,
      sha256: undefined,
    });
    const parsed = JSON.parse(review) as Record<string, unknown>;
    expect(parsed.reviewId).toBe(100);
    expect(parsed.target).toBe('demo-user/demo-repo#12');
    expect(parsed.tool).toBe('submit_pull_review');
    expect(parsed).not.toHaveProperty('bytes');
    expect(parsed).not.toHaveProperty('sha256');
    // The stage-1 line is unchanged: no `reviewId` key at all.
    expect(JSON.parse(formatMcpWriteAuditRecord(RECORD))).not.toHaveProperty('reviewId');
  });
});

describe('write audit sink', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-write-audit-'));
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  function makeLogger() {
    return { info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  }

  it('logs to the Output Channel and appends the identical text to the file', async () => {
    const logger = makeLogger();
    const filePath = path.join(dir, 'mcp-write-audit.jsonl');
    const sink = createMcpWriteAuditSink({ logger, filePath });
    sink.recordFilePath();
    await sink.record(RECORD);
    sink.recordFilePath();

    const line = formatMcpWriteAuditRecord(RECORD);
    expect(logger.info).toHaveBeenCalledWith(line);
    const fileLines = (await fs.promises.readFile(filePath, 'utf8')).trimEnd().split('\n');
    // Byte-identical: the channel line and the file line are the same string.
    expect(fileLines).toEqual([line]);
    // The file-path line goes to the channel only, once, and names the file.
    const pathLines = logger.info.mock.calls.filter((call) => String(call[0]).includes(filePath));
    expect(pathLines).toHaveLength(1);
    expect(String(pathLines[0][0])).toContain('1 MB');
  });

  it('stays Output-Channel-only when no file is configured', async () => {
    const logger = makeLogger();
    const sink = createMcpWriteAuditSink({ logger });
    sink.recordFilePath();
    await sink.record(RECORD);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(await fs.promises.readdir(dir)).toEqual([]);
  });

  it('rolls the audit file at the cap, keeping two rolled files', async () => {
    const filePath = path.join(dir, 'mcp-write-audit.jsonl');
    // Real records, not synthetic lines: the roll must not depend on a guessed
    // byte count, and each record is `line#<n>` so the content is traceable.
    const record = formatMcpWriteAuditRecord(RECORD);
    const recordBytes = Buffer.byteLength(`${record}#0\n`, 'utf8');
    const lineAt = (index: number) => `${record}#${index}`;
    /** How many whole records a fresh file may hold before the next append rolls. */
    const capacity = 3;
    const maxBytes = recordBytes * capacity;

    for (let index = 0; index < capacity * 3; index += 1) {
      await appendMcpWriteAuditLine({ filePath, line: lineAt(index), maxBytes });
      // The invariant the roll exists for: the active file never grows past the
      // cap, because the roll happens *before* the append that would.
      expect((await fs.promises.stat(filePath)).size).toBeLessThanOrEqual(maxBytes);
    }

    expect((await fs.promises.readdir(dir)).sort()).toEqual([
      'mcp-write-audit.jsonl',
      'mcp-write-audit.jsonl.1',
      'mcp-write-audit.jsonl.2',
    ]);
    const linesOf = async (suffix: string) =>
      (await fs.promises.readFile(`${filePath}${suffix}`, 'utf8').catch(() => ''))
        .split('\n')
        .filter((line) => line !== '');
    // 9 records, 3 per file: the active file holds the newest three, `.1` the
    // three before them, `.2` the three before those — and the fourth batch is
    // what the two-file limit drops.
    expect(await linesOf('')).toEqual([6, 7, 8].map(lineAt));
    expect(await linesOf('.1')).toEqual([3, 4, 5].map(lineAt));
    expect(await linesOf('.2')).toEqual([0, 1, 2].map(lineAt));
    // A tenth append drops index 0 and slides everything down by one batch.
    await appendMcpWriteAuditLine({ filePath, line: lineAt(9), maxBytes });
    expect(await linesOf('')).toEqual([9].map(lineAt));
    expect(await linesOf('.1')).toEqual([6, 7, 8].map(lineAt));
    expect(await linesOf('.2')).toEqual([3, 4, 5].map(lineAt));
  });

  it('uses the decided cap and roll count', () => {
    expect(MCP_WRITE_AUDIT_MAX_BYTES).toBe(1024 * 1024);
    expect(MCP_WRITE_AUDIT_ROLLED_FILES).toBe(2);
  });

  it('reports an unwritable audit file once and keeps logging to the channel', async () => {
    const logger = makeLogger();
    // A directory where the file should be: every append fails with EISDIR,
    // which is the shape of a log folder that cannot be written.
    const filePath = path.join(dir, 'mcp-write-audit.jsonl');
    await fs.promises.mkdir(filePath);
    const sink = createMcpWriteAuditSink({ logger, filePath });

    await expect(sink.record(RECORD)).resolves.toBeUndefined();
    await sink.record(RECORD);

    // The record itself is still in the channel; only the failure is reported,
    // and only once, so a broken sink cannot flood the log.
    expect(logger.info).toHaveBeenCalledWith(formatMcpWriteAuditRecord(RECORD));
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0][0])).toMatch(/audit file append failed/i);
  });
});
