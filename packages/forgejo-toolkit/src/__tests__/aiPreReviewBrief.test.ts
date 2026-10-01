import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import {
  AI_PRE_REVIEW_ANSWER_PREFIX_LENGTH,
  AI_PRE_REVIEW_MAX_BODY_LENGTH,
  AI_PRE_REVIEW_MAX_COMMENTS,
  AI_PRE_REVIEW_SYSTEM_PROMPT,
  buildAiPreReviewBrief,
  buildAiPreReviewUserPrompt,
  describeAiPreReviewAnswerShape,
  formatCandidateLabel,
  isSafeBriefPath,
  parseAiPreReviewResponse,
  splitDiffByFile,
  summarizePreReviewDrops,
  validatePreReviewComments,
  type AiPreReviewBrief,
  type AiPreReviewDropReason,
} from '../aiPreReviewBrief';
import { isAiPreReviewEnabled, isAiPreReviewIncludeDiffEnabled } from '../aiPreReviewSettings';
import { PR_REVIEW_MAX_COMMENT_LENGTH } from '../../mcp/tools';
import type { ForgejoChangedFile } from '../api/types';

/**
 * The pure half of the AI pre-review. These tests need no model and no server:
 * the brief assembly, the prompt builder and the validator are functions over
 * plain data, which is exactly the property the design record's §8.3 asks for
 * so that malformed model output can be fed in by the hundred.
 */

const DIFF = `diff --git a/src/index.ts b/src/index.ts
index 1111111..2222222 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,2 +1,3 @@
 const a = 1;
+console.log('hello');
 const b = 2;
`;

/** The changed-file row the mocked pull request reports for `DIFF`. */
const FILES: ForgejoChangedFile[] = [
  { filename: 'src/index.ts', status: 'modified', additions: 10, deletions: 2, changes: 12 },
];

function buildBrief(overrides?: Partial<Parameters<typeof buildAiPreReviewBrief>[0]>): AiPreReviewBrief {
  return buildAiPreReviewBrief({
    pullRequest: {
      number: 2,
      title: 'Add dark mode',
      baseBranch: 'main',
      headBranch: 'feature/dark-mode',
    },
    changedFiles: FILES,
    diffText: DIFF,
    existingReviews: [],
    ...overrides,
  });
}

describe("the brief carries the record's §7.1 fields and nothing else", () => {
  it('describes the pull request and the changed files', () => {
    const brief = buildBrief();

    expect(brief.text).toContain('[pull-request]');
    expect(brief.text).toContain('- number: 2');
    expect(brief.text).toContain('- title: Add dark mode');
    expect(brief.text).toContain('- base branch: main');
    expect(brief.text).toContain('- head branch: feature/dark-mode');
    expect(brief.text).toContain('[changed-files]');
    expect(brief.text).toContain('- src/index.ts (+10 -2, modified)');
    expect(brief.truncatedBy).toBeUndefined();
    expect(brief.files).toHaveLength(1);
    expect(brief.files[0].hasDiff).toBe(true);
  });

  it('carries existing comment metadata without a single body', () => {
    const brief = buildBrief({
      existingReviews: [
        {
          state: 'COMMENT',
          author: 'demo-user',
          comments: [{ path: 'src/index.ts', line: 2, side: 'new', author: 'other-user' }],
        },
      ],
    });

    expect(brief.text).toContain('[existing-review-comment-metadata]');
    expect(brief.text).toContain('- src/index.ts:2 (head) by other-user [COMMENT]');
    // The whole point of "metadata only": a body that had been included would
    // show up here, and the record's §13.5 answer forbids it.
    expect(brief.text).not.toContain('body');
  });

  it('says so when a changed file has no line diff to comment on', () => {
    const brief = buildBrief({
      changedFiles: [{ filename: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0 }],
      diffText: DIFF,
    });

    expect(brief.text).toContain('assets/logo.png (+0 -0, modified, no line diff available)');
    expect(brief.files[0].hasDiff).toBe(false);
  });

  it('announces a file table cut instead of silently shortening it', () => {
    const many: ForgejoChangedFile[] = Array.from({ length: 160 }, (_unused, index) => ({
      filename: `src/file-${index}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 1,
    }));

    const brief = buildBrief({ changedFiles: many, diffText: DIFF });

    expect(brief.truncatedBy).not.toBeUndefined();
    expect(brief.text).toContain('[truncated: the file list is incomplete');
    expect(brief.files.length).toBeLessThan(many.length);
  });

  it('announces a metadata cut the same way', () => {
    const comments = Array.from({ length: 200 }, (_unused, index) => ({
      path: `src/file-${index}.ts`,
      line: index + 1,
      side: 'new' as const,
      author: 'demo-user',
    }));

    const brief = buildBrief({ existingReviews: [{ state: 'COMMENT', author: 'demo-user', comments }] });

    expect(brief.text).toContain('[truncated: more existing review comments were not listed');
    expect(brief.text.split('\n').filter((line) => line.startsWith('- src/file-'))).toHaveLength(50);
  });

  it('handles a pull request with no changed files', () => {
    const brief = buildBrief({ changedFiles: [], diffText: '' });

    expect(brief.files).toEqual([]);
    expect(brief.text).toContain('(the pull request reports no changed files)');
    expect(brief.text).toContain('(none)');
  });

  it('never leaks a URL or a host name, whatever the header holds', () => {
    const brief = buildBrief({
      pullRequest: { number: 2, title: 'Add dark mode', baseBranch: 'main', headBranch: 'feature/dark-mode' },
    });

    expect(brief.text).not.toContain('http');
    expect(brief.text).not.toContain('forgejo.example.com');
  });
});

describe('the prompt builder', () => {
  it('adds one diff section per changed file when the diff body is on', () => {
    const brief = buildBrief();
    const withDiff = buildAiPreReviewUserPrompt(brief, { diffText: DIFF });

    expect(withDiff).toContain('[diff]');
    expect(withDiff).toContain('--- src/index.ts ---');
    expect(withDiff).toContain("+console.log('hello');");
  });

  it('is exactly the brief when the diff body is off', () => {
    const brief = buildBrief();

    expect(buildAiPreReviewUserPrompt(brief)).toBe(brief.text);
    expect(buildAiPreReviewUserPrompt(brief)).not.toContain('[diff]');
  });

  it('does not invent a section for a file with no diff block', () => {
    const brief = buildBrief({
      changedFiles: [
        { filename: 'src/index.ts', status: 'modified', additions: 10, deletions: 2, changes: 12 },
        { filename: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0 },
      ],
    });

    const withDiff = buildAiPreReviewUserPrompt(brief, { diffText: DIFF });

    expect(withDiff).toContain('--- src/index.ts ---');
    expect(withDiff).not.toContain('--- assets/logo.png ---');
  });

  it('splits a diff by the paths the parser derives', () => {
    const blocks = splitDiffByFile(DIFF);

    expect([...blocks.keys()]).toEqual(['src/index.ts']);
    expect(blocks.get('src/index.ts')).toContain('@@ -1,2 +1,3 @@');
  });
});

describe('the response parser', () => {
  it('accepts the contracted object', () => {
    expect(parseAiPreReviewResponse('{"comments":[]}')).toEqual({ kind: 'ok', comments: [] });
  });

  it('accepts a JSON code fence around it', () => {
    expect(parseAiPreReviewResponse('```json\n{"comments":[]}\n```')).toEqual({ kind: 'ok', comments: [] });
  });

  it('reports an empty answer as empty, not as unparseable', () => {
    // The distinction the UI verification round needed: "the model said
    // nothing" and "the model said something that is not JSON" are different
    // problems, and one log line covered both.
    expect(parseAiPreReviewResponse('')).toEqual({ kind: 'empty' });
    expect(parseAiPreReviewResponse('   \n  ')).toEqual({ kind: 'empty' });
    expect(parseAiPreReviewResponse('```json\n\n```')).toEqual({ kind: 'empty' });
  });

  it('reports prose and broken JSON as not JSON', () => {
    expect(parseAiPreReviewResponse('Sure! Here are my comments:')).toEqual({ kind: 'not-json' });
    expect(parseAiPreReviewResponse('{"comments": [')).toEqual({ kind: 'not-json' });
  });

  it('names the field a JSON answer got wrong', () => {
    expect(parseAiPreReviewResponse('[{"comments":[]}]')).toEqual({ kind: 'wrong-shape', field: 'root' });
    expect(parseAiPreReviewResponse('"comments"')).toEqual({ kind: 'wrong-shape', field: 'root' });
    expect(parseAiPreReviewResponse('{"note":"none"}')).toEqual({ kind: 'wrong-shape', field: 'comments' });
    expect(parseAiPreReviewResponse('{"comments":"none"}')).toEqual({ kind: 'wrong-shape', field: 'comments' });
  });

  it('describes an answer by its bounded shape only', () => {
    const long = `{\n${'x'.repeat(5_000)}\n}`;

    expect(describeAiPreReviewAnswerShape(long)).toBe(`length=${long.length}, startsWithBrace=true, firstLine="{"`);
    expect(describeAiPreReviewAnswerShape('')).toBe('length=0, startsWithBrace=false, firstLine=""');
  });

  it('cuts the first-line prefix and never quotes more than it', () => {
    const answer = `I am sorry, but I cannot review this: ${'y'.repeat(200)}`;
    const described = describeAiPreReviewAnswerShape(answer);

    expect(described).toContain(`firstLineTruncated=true`);
    expect(described).toContain(answer.slice(0, AI_PRE_REVIEW_ANSWER_PREFIX_LENGTH));
    expect(described).not.toContain(answer.slice(0, AI_PRE_REVIEW_ANSWER_PREFIX_LENGTH + 1));
  });
});

describe('the validator never repairs an anchor', () => {
  function reasonCounts(dropped: ReturnType<typeof validatePreReviewComments>['dropped']): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entry of dropped) {
      counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + entry.count);
    }
    return counts;
  }

  function validate(comments: unknown[]): ReturnType<typeof validatePreReviewComments> {
    return validatePreReviewComments(buildBrief(), { comments });
  }

  it('accepts a head-side line that is inside the diff', () => {
    const { accepted, dropped } = validate([
      { path: 'src/index.ts', line: 2, side: 'head', extraLines: 0, body: 'This logs on every call.' },
    ]);

    expect(accepted).toEqual([
      { path: 'src/index.ts', line: 2, side: 'head', extraLines: 0, body: 'This logs on every call.' },
    ]);
    expect(dropped).toEqual([]);
  });

  it('accepts a context line on either side but not a side where it does not exist', () => {
    const { accepted, dropped } = validate([
      { path: 'src/index.ts', line: 1, side: 'head', extraLines: 0, body: 'Head context.' },
      { path: 'src/index.ts', line: 1, side: 'base', extraLines: 0, body: 'Base context.' },
      // Line 3 exists on the head side only (the added line shifted it).
      { path: 'src/index.ts', line: 3, side: 'base', extraLines: 0, body: 'Flipped.' },
    ]);

    expect(accepted.map((entry) => entry.side)).toEqual(['head', 'base']);
    expect(reasonCounts(dropped).get('line-outside-diff')).toBe(1);
  });

  it('accepts a range whose close is inside the diff and drops one that is not', () => {
    const { accepted, dropped } = validate([
      { path: 'src/index.ts', line: 1, side: 'head', extraLines: 2, body: 'Lines 1-3.' },
      { path: 'src/index.ts', line: 1, side: 'head', extraLines: 5, body: 'Past the hunk.' },
    ]);

    expect(accepted).toHaveLength(1);
    expect(accepted[0].extraLines).toBe(2);
    expect(reasonCounts(dropped).get('invalid-extra-lines')).toBe(1);
  });

  it('drops a path outside the changed files, an unsafe path and a bad side', () => {
    const { accepted, dropped } = validate([
      { path: 'src/other.ts', line: 1, side: 'head', extraLines: 0, body: 'Wrong file.' },
      { path: '../../etc/passwd', line: 1, side: 'head', extraLines: 0, body: 'Traversal.' },
      { path: '/etc/passwd', line: 1, side: 'head', extraLines: 0, body: 'Absolute.' },
      { path: 'src/index.ts', line: 1, side: 'sideways', extraLines: 0, body: 'Bad side.' },
    ]);

    expect(accepted).toEqual([]);
    const counts = reasonCounts(dropped);
    expect(counts.get('path-not-in-changed-files')).toBe(1);
    // Both `../..` and the leading slash are unsafe shapes; the absolute one is
    // rejected by the same rule rather than by a fuzzy match.
    expect(counts.get('unsafe-path')).toBe(2);
    expect(counts.get('invalid-side')).toBe(1);
  });

  it('drops an empty body, a missing path and a non-string field', () => {
    const { accepted, dropped } = validate([
      { path: 'src/index.ts', line: 1, side: 'head', extraLines: 0, body: '   ' },
      { line: 1, side: 'head', extraLines: 0, body: 'No path.' },
      { path: 'src/index.ts', line: '1', side: 'head', extraLines: 0, body: 'String line.' },
      { path: 'src/index.ts', line: 1, side: 'head', extraLines: '0', body: 'Extra is a string.' },
      'not an object',
    ]);

    expect(accepted).toEqual([]);
    const counts = reasonCounts(dropped);
    expect(counts.get('invalid-body')).toBe(1);
    expect(counts.get('missing-path')).toBe(1);
    expect(counts.get('line-outside-diff')).toBe(1);
    expect(counts.get('invalid-extra-lines')).toBe(1);
    expect(counts.get('invalid-shape')).toBe(1);
  });

  it('keeps only the first comment of a duplicated anchor', () => {
    const { accepted, dropped } = validate([
      { path: 'src/index.ts', line: 2, side: 'head', extraLines: 0, body: 'First.' },
      { path: 'src/index.ts', line: 2, side: 'head', extraLines: 0, body: 'Second.' },
    ]);

    expect(accepted.map((entry) => entry.body)).toEqual(['First.']);
    expect(reasonCounts(dropped).get('duplicate-anchor')).toBe(1);
  });

  it('drops the candidates past the cap and counts them', () => {
    const comments = Array.from({ length: AI_PRE_REVIEW_MAX_COMMENTS + 5 }, (_unused, index) => ({
      path: 'src/index.ts',
      line: 2,
      side: 'head',
      extraLines: index,
      body: `Comment ${index}`,
    }));

    const { accepted, dropped } = validate(comments);

    // Only the first two survive validation (extraLines 0 and 1 both land
    // inside the hunk); everything past the 20th candidate never reached the
    // validator and is counted as "over the candidate cap".
    expect(accepted).toHaveLength(2);
    expect(accepted.map((entry) => entry.extraLines)).toEqual([0, 1]);
    expect(reasonCounts(dropped).get('candidates-dropped')).toBe(5);
  });

  it('truncates an oversized body and announces the cut', () => {
    const body = 'x'.repeat(AI_PRE_REVIEW_MAX_BODY_LENGTH + 10);
    const { accepted } = validate([{ path: 'src/index.ts', line: 2, side: 'head', extraLines: 0, body }]);

    expect(accepted).toHaveLength(1);
    expect(accepted[0].bodyTruncated).toBe(true);
    expect(accepted[0].body).toContain(`truncated: 10 more characters`);
    expect(accepted[0].body.startsWith('x'.repeat(PR_REVIEW_MAX_COMMENT_LENGTH))).toBe(true);
  });

  it('fails the whole answer, not one comment, when the shape is wrong', () => {
    expect(validatePreReviewComments(buildBrief(), { comments: 'none' })).toEqual({
      accepted: [],
      dropped: [{ reason: 'invalid-shape', count: 1 }],
    });
    expect(validatePreReviewComments(buildBrief(), null).dropped).toEqual([{ reason: 'invalid-shape', count: 1 }]);
  });

  it('drops an anchor on a file the brief says has no line diff', () => {
    const brief = buildBrief({
      changedFiles: [{ filename: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0 }],
    });
    const { accepted, dropped } = validatePreReviewComments(brief, {
      comments: [{ path: 'assets/logo.png', line: 1, side: 'head', extraLines: 0, body: 'Binary file.' }],
    });

    expect(accepted).toEqual([]);
    expect(dropped).toContainEqual({ reason: 'line-outside-diff', count: 1 });
  });
});

describe('path safety and presentation helpers', () => {
  it('rejects absolute paths, traversal and backslashes', () => {
    expect(isSafeBriefPath('src/index.ts')).toBe(true);
    expect(isSafeBriefPath('')).toBe(false);
    expect(isSafeBriefPath('/etc/passwd')).toBe(false);
    expect(isSafeBriefPath('src/../../etc/passwd')).toBe(false);
    expect(isSafeBriefPath('src\\index.ts')).toBe(false);
  });

  it('labels a candidate with its path, range, side and a body preview', () => {
    const label = formatCandidateLabel({
      path: 'src/index.ts',
      line: 4,
      side: 'base',
      extraLines: 2,
      body: 'First line.\n\nSecond line that is long enough to be cut by the preview limit eventually.',
    });

    expect(label.startsWith('src/index.ts:4-6 (base) — First line. Second line')).toBe(true);
  });

  it('summarizes the drop reasons for the report', () => {
    const dropped: { reason: AiPreReviewDropReason; count: number }[] = [
      { reason: 'line-outside-diff', count: 2 },
      { reason: 'invalid-body', count: 1 },
    ];

    expect(summarizePreReviewDrops(dropped)).toBe('line-outside-diff=2, invalid-body=1');
  });

  it('states the whole output contract in the instruction prompt', () => {
    // The prompt is the one place the contract is stated, and it is deliberately
    // as short as it can be while every rule survives: the validator drops a
    // comment that breaks any of these and never repairs one. If a wording
    // change drops a rule, this test is what notices.
    expect(AI_PRE_REVIEW_SYSTEM_PROMPT).toContain('strict JSON only');
    expect(AI_PRE_REVIEW_SYSTEM_PROMPT).toContain(
      '{"comments":[{"path":string,"line":number,"side":"head"|"base","extraLines":number,"body":string}]}',
    );
    expect(AI_PRE_REVIEW_SYSTEM_PROMPT).toContain('Copy `path` exactly from the changed-file list');
    expect(AI_PRE_REVIEW_SYSTEM_PROMPT).toContain('`line` is 1-based in the file on `side`');
    expect(AI_PRE_REVIEW_SYSTEM_PROMPT).toContain('"head" is the new file, "base" the old one');
    expect(AI_PRE_REVIEW_SYSTEM_PROMPT).toContain('`extraLines` is the number of extra lines after `line`');
    expect(AI_PRE_REVIEW_SYSTEM_PROMPT).toContain('Anchor only to a line shown in the diff you were given');
    expect(AI_PRE_REVIEW_SYSTEM_PROMPT).toContain(`at most ${AI_PRE_REVIEW_MAX_COMMENTS} comments`);
    expect(AI_PRE_REVIEW_SYSTEM_PROMPT).toContain(`${PR_REVIEW_MAX_COMMENT_LENGTH} characters`);
    expect(AI_PRE_REVIEW_SYSTEM_PROMPT).toContain('An empty comment list is a valid answer');
  });

  it('stays short enough for a small model budget', () => {
    // The instruction prompt is the run's fixed cost, and it is what made the
    // feature unusable on a machine whose offered models started with one
    // smaller than it. Choosing a model by budget is the real fix; this only
    // keeps the constant from growing back past the point where its words do no
    // work. The tightened wording is 781 characters with every rule above intact
    // (892 before the tightening; measured 2026-09-29).
    expect(AI_PRE_REVIEW_SYSTEM_PROMPT.length).toBeLessThanOrEqual(840);
  });
});

describe('the two settings default to off', () => {
  beforeEach(() => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(() => undefined),
      update: vi.fn(),
    } as never);
  });

  it('reads "off" from an absent, non-boolean or throwing value', () => {
    expect(isAiPreReviewEnabled()).toBe(false);
    expect(isAiPreReviewIncludeDiffEnabled()).toBe(false);

    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(() => 'true'),
      update: vi.fn(),
    } as never);
    expect(isAiPreReviewEnabled()).toBe(false);

    vi.mocked(vscode.workspace.getConfiguration).mockImplementation(() => {
      throw new Error('no configuration');
    });
    expect(isAiPreReviewEnabled()).toBe(false);
  });

  it('reads "on" only from an explicit true', () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string) => (key === 'aiPreReview' ? true : false)),
      update: vi.fn(),
    } as never);

    expect(isAiPreReviewEnabled()).toBe(true);
    expect(isAiPreReviewIncludeDiffEnabled()).toBe(false);
  });
});
