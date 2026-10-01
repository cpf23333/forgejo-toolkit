import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME,
  aiPreReviewDiagnosticsFilePath,
  createAiPreReviewDiagnostics,
  formatAiPreReviewDiagnosticsAttempt,
  formatAiPreReviewDiagnosticsSection,
  type AiPreReviewDiagnosticsAttempt,
} from '../aiPreReviewDiagnostics';
import { removeTempDir } from './tempDir';

/**
 * The debug-only dump. Two things have to hold and they pull in opposite
 * directions, which is why both halves are here:
 *
 * 1. **Off by default, and off means nothing on disk.** The feature's promise
 *    that an answer never reaches the Output Channel only holds if the escape
 *    hatch is shut: with `forgejoToolkit.debug` off there must be no file, no
 *    directory, no partial write — so "disabled" is a sink with no path at all.
 * 2. **On means the real thing.** When it is on, the file has to be worth
 *    handing over: the exact text of every message, the full raw answer, who
 *    answered and when, and a header that says what the file is — otherwise the
 *    next diagnosis round is spent re-asking for it.
 *
 * The formatting is a pure function, so the shape assertions do not touch the
 * filesystem; the gating and the "full answer, not a prefix" assertions read the
 * real file the sink wrote.
 */

let directory: string;

beforeEach(async () => {
  directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-pre-review-diagnostics-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeTempDir(directory);
});

function attempt(overrides: Partial<AiPreReviewDiagnosticsAttempt> = {}): AiPreReviewDiagnosticsAttempt {
  return {
    label: 'attempt 1/2 for this model (call 1/6 of the run)',
    model: { name: 'DeepSeek V4 Pro', vendor: 'deepseek', family: 'deepseek-v4', id: 'deepseek-v4-pro' },
    messages: [{ role: 'user', text: MESSAGE_TEXT }],
    startedAt: new Date('2026-10-01T09:00:00.000Z'),
    finishedAt: new Date('2026-10-01T09:00:01.250Z'),
    answer: 'comments[]',
    outcome: 'contract violation: the answer is not JSON',
    ...overrides,
  };
}

/** The one message the default attempt sent: the instruction half, then the brief. */
const MESSAGE_TEXT = 'RULES\n\n[changed-files]\n- src/index.ts (+10 -2, modified)';

describe('the dump states what it is and what it saw', () => {
  it('names the section kind, the time and the facts behind it', () => {
    const text = formatAiPreReviewDiagnosticsSection({
      kind: 'run',
      startedAt: new Date('2026-10-01T09:00:00.000Z'),
      facts: ['target: inst:demo-user/demo-repo#11', '  model 1: DeepSeek V4 Pro maxInputTokens=128000'],
    });

    expect(text).toContain('[run] started=2026-10-01T09:00:00.000Z');
    expect(text).toContain('target: inst:demo-user/demo-repo#11');
    // The notice is part of every section: a rolled file that no longer holds the
    // first one still has to say that it contains prompts and model output.
    expect(text).toContain('contains the prompt text sent to chat models and their raw answers');
    expect(text).toContain('"forgejoToolkit.debug"');
  });

  it('prints every message with its role and character count, and the answer verbatim', () => {
    const text = formatAiPreReviewDiagnosticsAttempt(attempt());

    expect(text).toContain('attempt 1/2 for this model (call 1/6 of the run)');
    expect(text).toContain('model: DeepSeek V4 Pro (vendor=deepseek, family=deepseek-v4, id=deepseek-v4-pro)');
    expect(text).toContain('messages sent: 1');
    expect(text).toContain(`--- message 1/1 role=user chars=${MESSAGE_TEXT.length} ---`);
    expect(text).toContain(MESSAGE_TEXT);
    expect(text).toContain('--- end message 1/1 ---');
    expect(text).toContain('requested: 2026-10-01T09:00:00.000Z');
    expect(text).toContain('answered: 2026-10-01T09:00:01.250Z (1250 ms)');
    expect(text).toContain('answer chars: 10');
    expect(text).toContain('outcome: contract violation: the answer is not JSON');
    expect(text).toContain('--- raw answer begin (10 chars) ---\ncomments[]\n--- raw answer end ---');
  });

  it('tells two asks of the same model apart, which is what makes a retry visible', () => {
    // The labels the host builds: the ask of this model, and the call of the run.
    const first = formatAiPreReviewDiagnosticsAttempt(
      attempt({ label: 'attempt 1/2 for this model (call 3/6 of the run)' }),
    );
    const second = formatAiPreReviewDiagnosticsAttempt(
      attempt({
        label: 'attempt 2/2 for this model (call 4/6 of the run)',
        answer: '{"comments":[]}',
        outcome: 'the contracted JSON, with 0 proposed comment(s)',
      }),
    );

    expect(first).toContain('attempt 1/2 for this model (call 3/6 of the run)');
    expect(first).not.toContain('attempt 2/2 for this model');
    expect(second).toContain('attempt 2/2 for this model (call 4/6 of the run)');
    expect(second).toContain('outcome: the contracted JSON, with 0 proposed comment(s)');
    // Same model, different answers: the blocks are distinguished by the labels,
    // not by the identity line, which is identical in both.
    const identity = 'model: DeepSeek V4 Pro (vendor=deepseek, family=deepseek-v4, id=deepseek-v4-pro)';
    expect(first).toContain(identity);
    expect(second).toContain(identity);
  });

  it('keeps both halves of a two-message request apart', () => {
    const text = formatAiPreReviewDiagnosticsAttempt(
      attempt({
        messages: [
          { role: 'user', text: 'INSTRUCTIONS' },
          { role: 'user', text: 'REQUEST' },
        ],
      }),
    );

    expect(text).toContain('messages sent: 2');
    expect(text).toContain('--- message 1/2 role=user chars=12 ---\nINSTRUCTIONS');
    expect(text).toContain('--- message 2/2 role=user chars=7 ---\nREQUEST');
  });

  it('prints the notes the run added, and never truncates a long answer', () => {
    const answer = `${'x'.repeat(5_000)}\nend`;
    const text = formatAiPreReviewDiagnosticsAttempt(
      attempt({ answer, notes: ['answer shape: length=5004, startsWithBrace=false, firstLine="xxx"'] }),
    );

    expect(text).toContain(`--- raw answer begin (${answer.length} chars) ---\n${answer}\n--- raw answer end ---`);
    expect(text).toContain('note: answer shape: length=5004');
  });

  it('names an unknown model rather than printing nothing for it', () => {
    const text = formatAiPreReviewDiagnosticsAttempt(attempt({ model: { name: '', vendor: '', family: '', id: '' } }));

    expect(text).toContain('model: unknown (vendor=unknown, family=unknown, id=unknown)');
  });
});

describe('the dump is off unless debug is on', () => {
  it('has no file path and writes nothing at all when it is disabled', async () => {
    const diagnostics = createAiPreReviewDiagnostics({ directory, enabled: false });

    expect(diagnostics.filePath).toBeUndefined();
    await diagnostics.section({ kind: 'run', startedAt: new Date(), facts: [] });
    await diagnostics.attempt(attempt());

    expect(await fs.promises.readdir(directory)).toEqual([]);
  });

  it('stays off when the host offers no log directory, even with debug on', async () => {
    const diagnostics = createAiPreReviewDiagnostics({ directory: undefined, enabled: true });

    expect(diagnostics.filePath).toBeUndefined();
    await diagnostics.attempt(attempt());

    expect(await fs.promises.readdir(directory)).toEqual([]);
  });

  it('derives the file path from the log directory it is given', () => {
    expect(aiPreReviewDiagnosticsFilePath(directory)).toBe(path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME));
    expect(aiPreReviewDiagnosticsFilePath(undefined)).toBeUndefined();
    expect(AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME.endsWith('.log')).toBe(true);
  });
});

describe('the dump writes what was asked for when it is on', () => {
  it('appends the section and the call it recorded to the file under the log directory', async () => {
    const diagnostics = createAiPreReviewDiagnostics({ directory, enabled: true });

    expect(diagnostics.filePath).toBe(path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME));
    await diagnostics.section({
      kind: 'probe',
      startedAt: new Date('2026-10-01T09:00:00.000Z'),
      facts: ['shapes asked of every model: 3'],
    });
    await diagnostics.attempt(attempt());

    const text = await fs.promises.readFile(diagnostics.filePath ?? '', 'utf8');
    // The section header and the call are both there, in order.
    expect(text.indexOf('[probe] started=')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('[probe] started=')).toBeLessThan(text.indexOf('attempt 1/2 for this model'));
    expect(text).toContain('shapes asked of every model: 3');
    // The instruction half and the request half are both in the file, and the
    // answer is complete rather than a shape description.
    expect(text).toContain('[changed-files]');
    expect(text).toContain('comments[]');
    expect(text).toContain('id=deepseek-v4-pro');
  });

  it('keeps a failing dump from failing the run', async () => {
    // A directory where the file should be: the append cannot work, which is the
    // case the sink promises to swallow.
    const blocked = path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME);
    await fs.promises.mkdir(blocked);
    const onError = vi.fn();
    const diagnostics = createAiPreReviewDiagnostics({ directory, enabled: true, onError });

    await expect(diagnostics.attempt(attempt())).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]?.[0])).toContain('could not be written');
    // The failure line names the path and the error, never the answer.
    expect(String(onError.mock.calls[0]?.[0])).not.toContain('comments[]');
  });
});
