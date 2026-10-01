import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import {
  AI_PRE_REVIEW_ANSWER_PREFIX_LENGTH,
  AI_PRE_REVIEW_FILE_CONTENT_BUDGET,
  AI_PRE_REVIEW_MAX_BODY_LENGTH,
  AI_PRE_REVIEW_MAX_COMMENTS,
  AI_PRE_REVIEW_MAX_CONTENT_FILES,
  AI_PRE_REVIEW_SYSTEM_PROMPT,
  aiPreReviewBodyLanguageName,
  aiPreReviewPromptText,
  buildAiPreReviewBrief,
  buildAiPreReviewFileContents,
  buildAiPreReviewPromptMessages,
  buildAiPreReviewSystemPrompt,
  buildAiPreReviewUserPrompt,
  describeAiPreReviewAnswerShape,
  isSafeBriefPath,
  keepChangedLines,
  parseAiPreReviewResponse,
  splitDiffByFile,
  summarizePreReviewDrops,
  validatePreReviewComments,
  type AiPreReviewBrief,
  type AiPreReviewDropReason,
} from '../aiPreReviewBrief';
import {
  AI_PRE_REVIEW_PROMPT_SCOPES,
  aiPreReviewCommentBodyLanguage,
  aiPreReviewPromptScopeSettingValue,
  isAiPreReviewEnabled,
} from '../aiPreReviewSettings';
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

  it('drops the unchanged context lines, and says so, for the changed-lines-only scope', () => {
    const prompt = buildAiPreReviewUserPrompt(buildBrief(), { diffText: DIFF, diffBody: 'changed-lines-only' });

    // The added and removed lines travel…
    expect(prompt).toContain("+console.log('hello');");
    // …with the headers that make their line numbers unambiguous…
    expect(prompt).toContain('diff --git a/src/index.ts b/src/index.ts');
    expect(prompt).toContain('+++ b/src/index.ts');
    expect(prompt).toContain('@@ -1,2 +1,3 @@');
    // …and with none of the context around them.
    expect(prompt).not.toContain(' const a = 1;');
    expect(prompt).not.toContain(' const b = 2;');
    // A model shown an excerpt must be told it is one.
    expect(prompt).toContain('unchanged context lines around them are omitted');
  });

  it('removes context lines without touching metadata, additions or removals', () => {
    const block = `diff --git a/src/index.ts b/src/index.ts
index 1111111..2222222 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;

 const c = 4;
\\ No newline at end of file
`;

    const kept = keepChangedLines(block).split('\n');

    expect(kept).toContain('diff --git a/src/index.ts b/src/index.ts');
    expect(kept).toContain('index 1111111..2222222 100644');
    expect(kept).toContain('--- a/src/index.ts');
    expect(kept).toContain('+++ b/src/index.ts');
    expect(kept).toContain('@@ -1,3 +1,3 @@');
    expect(kept).toContain('-const b = 2;');
    expect(kept).toContain('+const b = 3;');
    expect(kept).toContain('\\ No newline at end of file');
    expect(kept).not.toContain(' const a = 1;');
    expect(kept).not.toContain(' const c = 4;');
    expect(kept).not.toContain('');
  });

  it('sends the changed files themselves for the changed-files scope', () => {
    const contents = buildAiPreReviewFileContents({
      paths: ['src/index.ts'],
      texts: new Map([
        ['src/index.ts', 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n'],
      ]),
    });

    const prompt = buildAiPreReviewUserPrompt(buildBrief(), {
      diffText: DIFF,
      diffBody: 'full',
      fileContents: contents,
    });

    expect(prompt).toContain('[changed-file-contents]');
    expect(prompt).toContain('export function greet(name: string): string {');
    // The scope is the diff *plus* the files: the context lines stay.
    expect(prompt).toContain('[diff]');
    expect(prompt).toContain(' const a = 1;');
    expect(contents.truncatedBy).toBeUndefined();
    expect(contents.unavailable).toBe(0);
  });

  it('adds no file-content section for the scopes that do not send it', () => {
    const metadataOnly = buildAiPreReviewUserPrompt(buildBrief());
    const fullDiff = buildAiPreReviewUserPrompt(buildBrief(), { diffText: DIFF, diffBody: 'full' });
    const changedLines = buildAiPreReviewUserPrompt(buildBrief(), {
      diffText: DIFF,
      diffBody: 'changed-lines-only',
    });

    for (const prompt of [metadataOnly, fullDiff, changedLines]) {
      expect(prompt).not.toContain('[changed-file-contents]');
    }
  });

  it('pre-sizes the file contents to the file cap and reports the cut', () => {
    const paths = Array.from({ length: AI_PRE_REVIEW_MAX_CONTENT_FILES + 3 }, (_, index) => `src/f${index}.ts`);
    const texts = new Map(paths.map((path) => [path, `export const ${path} = 1;\n`]));

    const contents = buildAiPreReviewFileContents({ paths, texts });

    expect(contents.sections).toHaveLength(AI_PRE_REVIEW_MAX_CONTENT_FILES);
    expect(contents.truncatedBy).toBe('row-limit');
    expect(contents.unavailable).toBe(0);
    // Kept in the brief's own order, like every other pre-sized list here.
    expect(contents.sections[0]?.path).toBe('src/f0.ts');
  });

  it('cuts the first oversized file rather than sending an empty section, and reports the budget', () => {
    const huge = 'x'.repeat(AI_PRE_REVIEW_FILE_CONTENT_BUDGET + 1_000);

    const contents = buildAiPreReviewFileContents({ paths: ['src/huge.ts'], texts: new Map([['src/huge.ts', huge]]) });

    expect(contents.truncatedBy).toBe('budget');
    expect(contents.sections).toHaveLength(1);
    expect(contents.sections[0]?.truncated).toBe(true);
    expect(contents.sections[0]?.text.length).toBeLessThanOrEqual(AI_PRE_REVIEW_FILE_CONTENT_BUDGET);
    // The prompt says out loud that the file it shows is only its beginning.
    expect(buildAiPreReviewUserPrompt(buildBrief(), { fileContents: contents })).toContain(
      '[truncated: only the beginning of src/huge.ts is shown]',
    );
  });

  it('drops later files at the budget and counts the unreadable ones separately', () => {
    const first = 'a'.repeat(Math.floor(AI_PRE_REVIEW_FILE_CONTENT_BUDGET / 2));
    const second = 'b'.repeat(AI_PRE_REVIEW_FILE_CONTENT_BUDGET);

    const contents = buildAiPreReviewFileContents({
      paths: ['src/big1.ts', 'src/gone.ts', 'src/big2.ts'],
      texts: new Map([
        ['src/big1.ts', first],
        ['src/big2.ts', second],
      ]),
    });

    expect(contents.sections.map((section) => section.path)).toEqual(['src/big1.ts']);
    expect(contents.truncatedBy).toBe('budget');
    // `src/gone.ts` was never read: that is not a budget cut, and the prompt
    // has to distinguish them.
    expect(contents.unavailable).toBe(1);
    const prompt = buildAiPreReviewUserPrompt(buildBrief(), { fileContents: contents });
    expect(prompt).toContain('[1 changed file(s) had no readable text at the head version and are not shown]');
    expect(prompt).toContain('truncatedBy=budget');
  });

  it('splits a diff by the paths the parser derives', () => {
    const blocks = splitDiffByFile(DIFF);

    expect([...blocks.keys()]).toEqual(['src/index.ts']);
    expect(blocks.get('src/index.ts')).toContain('@@ -1,2 +1,3 @@');
  });

  it('sends one user message: the instructions, a blank line, then the request', () => {
    const brief = buildBrief();

    // One message, not two. Two consecutive `User` messages become two user
    // turns in the provider's conversion, and the contract would then live in a
    // message a buggy conversion can drop (see `buildAiPreReviewPromptMessages`).
    const messages = buildAiPreReviewPromptMessages(AI_PRE_REVIEW_SYSTEM_PROMPT, brief.text);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.text).toBe(`${AI_PRE_REVIEW_SYSTEM_PROMPT}\n\n${brief.text}`);
    // Every rule still reaches the model, and the whole brief is behind them.
    expect(messages[0]?.text.startsWith(AI_PRE_REVIEW_SYSTEM_PROMPT)).toBe(true);
    expect(messages[0]?.text).toContain('[changed-files]');
    expect(messages[0]?.text).toContain('[task]');
  });

  it('measures exactly the text the one message carries', () => {
    const request = buildAiPreReviewUserPrompt(buildBrief(), { diffText: DIFF });

    // The text the budget is counted on is the text that is sent — not a sum of
    // the halves, which only approximates the concatenation.
    expect(aiPreReviewPromptText(AI_PRE_REVIEW_SYSTEM_PROMPT, request)).toBe(
      buildAiPreReviewPromptMessages(AI_PRE_REVIEW_SYSTEM_PROMPT, request)[0]?.text,
    );
    expect(aiPreReviewPromptText(AI_PRE_REVIEW_SYSTEM_PROMPT, request)).toContain("+console.log('hello');");
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

  it('truncates an oversized body to the cap with the announcement inside it', () => {
    // The cap has to hold the announcement too (2026-10-02): the confirmation
    // panel caps the text a user may edit into a body at this same constant and
    // the host re-validates it, so a body that came out longer than the cap could
    // not be created from the panel without an edit first.
    const body = 'x'.repeat(AI_PRE_REVIEW_MAX_BODY_LENGTH + 10);
    const { accepted } = validate([{ path: 'src/index.ts', line: 2, side: 'head', extraLines: 0, body }]);

    expect(accepted).toHaveLength(1);
    expect(accepted[0].bodyTruncated).toBe(true);
    expect(accepted[0].body.length).toBeLessThanOrEqual(PR_REVIEW_MAX_COMMENT_LENGTH);
    expect(accepted[0].body).toMatch(/\n\.\.\. \(truncated: \d+ more characters\)$/);

    // What was kept is a prefix of the model's own text, and the announcement
    // counts every character that was dropped — nothing is lost silently.
    const kept = accepted[0].body.slice(0, accepted[0].body.indexOf('\n... (truncated:'));
    const announced = Number(/\(truncated: (\d+) more characters\)$/.exec(accepted[0].body)?.[1]);
    expect(kept).toMatch(/^x+$/);
    expect(body.startsWith(kept)).toBe(true);
    expect(kept.length + announced).toBe(body.length);
  });

  it('leaves a body exactly at the cap untouched', () => {
    const body = 'y'.repeat(PR_REVIEW_MAX_COMMENT_LENGTH);
    const { accepted } = validate([{ path: 'src/index.ts', line: 2, side: 'head', extraLines: 0, body }]);

    expect(accepted[0].body).toBe(body);
    expect(accepted[0].bodyTruncated).toBeUndefined();
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
    // The language rule is part of the contract too: without it the model
    // answers an English instruction block in English whatever the editor's
    // language is (the acceptance run that found it produced English bodies on a
    // `zh-cn` editor). The English block names English and keeps the non-prose
    // values as specified.
    expect(AI_PRE_REVIEW_SYSTEM_PROMPT).toContain('Write every comment body in English');
    expect(AI_PRE_REVIEW_SYSTEM_PROMPT).toContain('every value that is not prose');
    expect(AI_PRE_REVIEW_SYSTEM_PROMPT).toContain('"head"/"base"');
  });

  it('builds one instruction block per language, naming it in its own script', () => {
    const english = buildAiPreReviewSystemPrompt('en');
    const chinese = buildAiPreReviewSystemPrompt('zh');

    // The whole point of the change: `简体中文` is what the model is told, not
    // "Chinese", and the Chinese block is not the English one with a word
    // swapped — it names Chinese and only Chinese.
    expect(chinese).toContain('简体中文');
    expect(chinese).not.toContain('body in English');
    expect(english).toContain('body in English');
    expect(english).not.toContain('简体中文');
    expect(aiPreReviewBodyLanguageName('en')).toBe('English');
    expect(aiPreReviewBodyLanguageName('zh')).toBe('简体中文');

    // The rule appears exactly **once** per block, not once per rule, and the
    // exported English constant is that same block rather than a second copy
    // that could drift from it.
    expect(chinese.match(/Write every comment body in/g)).toHaveLength(1);
    expect(english.match(/Write every comment body in/g)).toHaveLength(1);
    expect(AI_PRE_REVIEW_SYSTEM_PROMPT).toBe(english);

    // Everything that is not prose stays as specified in both: the schema, the
    // side value the validator matches literally, and the path rule. Only the
    // body is prose.
    for (const prompt of [english, chinese]) {
      expect(prompt).toContain(
        '{"comments":[{"path":string,"line":number,"side":"head"|"base","extraLines":number,"body":string}]}',
      );
      expect(prompt).toContain('Copy `path` exactly from the changed-file list');
      expect(prompt).toContain('every value that is not prose');
      expect(prompt).toContain('paths and the numbers');
    }
  });

  it('stays short enough for a small model budget', () => {
    // The instruction prompt is the run's fixed cost, and it is what made the
    // feature unusable on a machine whose offered models started with one
    // smaller than it. Choosing a model by budget is the real fix; this only
    // keeps the constant from growing back past the point where its words do no
    // work. The tightened wording was 781 characters with every rule intact
    // (892 before the tightening; measured 2026-09-29); the language rule is a
    // new load-bearing rule and brought the English block — the longer of the
    // two, since `English` is longer than `简体中文` — to 963 characters
    // (English) and 960 (Chinese), measured 2026-10-02.
    expect(buildAiPreReviewSystemPrompt('en').length).toBeLessThanOrEqual(1000);
    expect(buildAiPreReviewSystemPrompt('zh').length).toBeLessThanOrEqual(1000);
    expect(AI_PRE_REVIEW_SYSTEM_PROMPT.length).toBeLessThanOrEqual(1000);
  });
});

describe('the feature switch defaults to off', () => {
  beforeEach(() => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(() => undefined),
      update: vi.fn(),
    } as never);
  });

  it('reads "off" from an absent, non-boolean or throwing value', () => {
    expect(isAiPreReviewEnabled()).toBe(false);

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
  });
});

describe('the prompt scope setting', () => {
  /** One configured value, as `getConfiguration` would answer for every key. */
  function withValue(value: unknown): void {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(() => value),
      update: vi.fn(),
    } as never);
  }

  it('offers exactly the four values the manifest contributes, plus "ask"', () => {
    // The five values are one contract in three places (this constant, the
    // manifest enum, and both nls pairs). This pins the constant's half; the
    // manifest's is pinned by the i18n parity suite.
    expect([...AI_PRE_REVIEW_PROMPT_SCOPES]).toEqual([
      'ask',
      'metadata-only',
      'changed-lines-only',
      'full-diff',
      'changed-files',
    ]);
  });

  it('reads "ask" from an absent, unrecognized, non-string or throwing value', () => {
    withValue(undefined);
    expect(aiPreReviewPromptScopeSettingValue()).toBe('ask');

    // A typo, or a leftover from another version: asking again is the direction
    // that sends nothing, so it is the one every unknown reads as.
    withValue('changed-file');
    expect(aiPreReviewPromptScopeSettingValue()).toBe('ask');

    withValue(true);
    expect(aiPreReviewPromptScopeSettingValue()).toBe('ask');

    vi.mocked(vscode.workspace.getConfiguration).mockImplementation(() => {
      throw new Error('no configuration');
    });
    expect(aiPreReviewPromptScopeSettingValue()).toBe('ask');
  });

  it('reads a stated scope, ignoring letter case and surrounding spaces', () => {
    withValue('  Changed-Files ');
    expect(aiPreReviewPromptScopeSettingValue()).toBe('changed-files');

    withValue('metadata-only');
    expect(aiPreReviewPromptScopeSettingValue()).toBe('metadata-only');
  });
});

describe('the language the comment bodies are asked for', () => {
  /**
   * One `forgejoToolkit.locale` value, as `getConfiguration` would answer for
   * every key, and the VS Code display language the editor reports — the two
   * inputs `resolveLocale` reads. `vscode.env.language` is restored per case
   * because the shared mock is module-wide and every other suite reads `en`.
   */
  function withLocale(value: unknown, vscodeLanguage: string): void {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(() => value),
      update: vi.fn(),
    } as never);
    (vscode.env as { language: string }).language = vscodeLanguage;
  }

  afterEach(() => {
    (vscode.env as { language: string }).language = 'en';
  });

  it('follows the setting when it states a language, whatever VS Code says', () => {
    // The case the two resolutions disagree in, and the one this feature sides
    // with the setting on: every surface of this extension that shows these
    // bodies renders in `forgejoToolkit.locale`, so a user reading them in
    // Chinese gets Chinese bodies even from an English VS Code.
    withLocale('zh', 'en-US');
    expect(aiPreReviewCommentBodyLanguage()).toBe('zh');

    withLocale('en', 'zh-cn');
    expect(aiPreReviewCommentBodyLanguage()).toBe('en');
  });

  it('follows VS Code when the setting states nothing', () => {
    // `auto` is the setting's own default: unset (or empty), so the editor's
    // display language decides — the same input `vscode.l10n` follows.
    withLocale(undefined, 'zh-cn');
    expect(aiPreReviewCommentBodyLanguage()).toBe('zh');

    withLocale('', 'zh-Hans');
    expect(aiPreReviewCommentBodyLanguage()).toBe('zh');

    withLocale(undefined, 'en');
    expect(aiPreReviewCommentBodyLanguage()).toBe('en');
  });

  it('reads an unexpected value as "not stated" and falls back to English', () => {
    // A hand-edited `settings.json` can hold anything, including a locale the
    // manifest does not contribute. It is not a statement of a language, so the
    // display language decides — and a display language that is not a Chinese
    // one (a typo, an empty reading, or one the editor does not report) reads as
    // English rather than being guessed at.
    withLocale('de', 'de-DE');
    expect(aiPreReviewCommentBodyLanguage()).toBe('en');

    withLocale(42, '');
    expect(aiPreReviewCommentBodyLanguage()).toBe('en');

    withLocale('zh', '');
    expect(aiPreReviewCommentBodyLanguage()).toBe('zh');
  });

  it('lets the display language decide when the setting read throws', () => {
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation(() => {
      throw new Error('no configuration');
    });
    (vscode.env as { language: string }).language = 'zh-tw';

    // A read that throws is "not stated", not a failed run: the language is a
    // property of the wording, never of the consent that gates egress.
    expect(aiPreReviewCommentBodyLanguage()).toBe('zh');
  });
});
