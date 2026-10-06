import { describe, expect, it } from 'vitest';
import { PR_REVIEW_MAX_DIFF_FILES } from '../../mcp/tools';
import {
  PR_DESCRIPTION_DIFF_BUDGET,
  PR_DESCRIPTION_MAX_CHARACTERS,
  PR_DESCRIPTION_MAX_COMMITS,
  PR_DESCRIPTION_MAX_SUBJECT_CHARACTERS,
  PR_DESCRIPTION_SYSTEM_PROMPT,
  buildPrDescriptionBrief,
  buildPrDescriptionDiff,
  buildPrDescriptionFileContents,
  buildPrDescriptionPromptText,
  buildPrDescriptionSystemPrompt,
  parsePrDescriptionAnswer,
  renderPrDescriptionFileContents,
} from '../prDescriptionBrief';

/**
 * The pure half of the PR-description draft: what the prompt carries, what the
 * budget cuts, and what an answer has to be to become a body.
 *
 * Nothing here touches `vscode`, which is the point of the split: these are the
 * two pieces that decide what leaves the machine and what the user's body field
 * ends up holding, so they are tested with malformed input rather than through a
 * run.
 */

const COMMIT = {
  sha: 'abcdef0123456789',
  subject: 'Add the retry helper',
  body: 'It retries twice, then gives up and reports the status.',
  author: 'Demo User',
  date: '2026-08-17T09:00:00Z',
};

const FILE = { path: 'src/retry.ts', status: 'modified' };

describe('the PR-description instruction block', () => {
  it('states the prose contract, the cap and the language', () => {
    const english = buildPrDescriptionSystemPrompt('en');
    const chinese = buildPrDescriptionSystemPrompt('zh');

    // The three things a usable description needs, in the order it has them.
    expect(english).toContain('one short paragraph');
    expect(english).toContain('"Changes" list');
    expect(english).toContain('"Notes" list');
    // Never invent a file, a symbol or a motivation: the model has no repository
    // access, so anything it was not given is a fabrication.
    expect(english).toContain('Never name a file, a function, a symbol or a test that is not shown there');
    // An explicit way out, and the cap, so a thin comparison does not become
    // invented material and an over-long answer is refused rather than cut.
    expect(english).toContain('answer with one line saying what is missing');
    expect(english).toContain(`at most ${PR_DESCRIPTION_MAX_CHARACTERS} characters`);
    // The language rule, because nothing else in the request carries it.
    expect(english).toContain('Write the prose in English');
    expect(chinese).toContain('Write the prose in 简体中文');
    expect(PR_DESCRIPTION_SYSTEM_PROMPT).toBe(english);
  });
});

describe('the PR-description brief', () => {
  it('carries the branch names, the typed title and the comparison', () => {
    const brief = buildPrDescriptionBrief({
      repository: 'demo-user/demo-repo',
      baseBranch: 'main',
      headBranch: 'feature',
      title: '  Retry failed requests  ',
      commits: [COMMIT],
      files: [FILE],
    });

    expect(brief.text).toContain('repository: demo-user/demo-repo');
    expect(brief.text).toContain('base branch: main');
    expect(brief.text).toContain('head branch: feature');
    // Trimmed: the title is prose the user typed, and the comparison is what the
    // draft is about either way.
    expect(brief.text).toContain('title (typed by the user, may still change): Retry failed requests');
    // The commit's own line and its body, so "what changed and why" is answerable
    // from the commit alone.
    expect(brief.text).toContain('- abcdef012345 (2026-08-17T09:00:00Z, Demo User): Add the retry helper');
    expect(brief.text).toContain('  It retries twice, then gives up and reports the status.');
    // The changed-file row, with the status the comparison endpoint reported.
    expect(brief.text).toContain('- modified: src/retry.ts');
    // The prompt says what the comparison is, so the model does not describe the
    // fields as if the pull request already existed.
    expect(brief.text).toContain('this pull request does not exist yet');
    expect(brief.commitsShown).toBe(1);
    expect(brief.filesShown).toBe(1);
    expect(brief.truncatedBy).toBeUndefined();
  });

  it('omits the title line when the user has typed none', () => {
    const brief = buildPrDescriptionBrief({
      repository: 'demo-user/demo-repo',
      baseBranch: 'main',
      headBranch: 'feature',
      commits: [],
      files: [],
    });

    expect(brief.text).not.toContain('title (typed by the user');
    // An empty comparison says so rather than leaving the section dangling: a
    // model shown nothing must not fill the gap itself.
    expect(brief.text).toContain('(the comparison reports no commit');
    expect(brief.text).toContain('(the comparison reports no changed file)');
  });

  it('cuts the commit list from the end and says so in the prompt', () => {
    const commits = Array.from({ length: PR_DESCRIPTION_MAX_COMMITS + 5 }, (_value, index) => ({
      sha: `sha-${index}`,
      subject: `Commit ${index}`,
    }));
    const brief = buildPrDescriptionBrief({
      repository: 'demo-user/demo-repo',
      baseBranch: 'main',
      headBranch: 'feature',
      commits,
      files: [],
    });

    expect(brief.commitsShown).toBe(PR_DESCRIPTION_MAX_COMMITS);
    expect(brief.commitsTotal).toBe(commits.length);
    expect(brief.truncatedBy).toBe('commit-limit');
    expect(brief.text).toContain(`[truncated: only the newest ${PR_DESCRIPTION_MAX_COMMITS} commit(s) are shown]`);
    // The oldest commits are the ones dropped: the list is newest first, and the
    // prompt says how many of how many.
    expect(brief.text).toContain('- sha-0: Commit 0');
    expect(brief.text).not.toContain(`- sha-${commits.length - 1}: Commit ${commits.length - 1}`);
  });

  it('cuts a long subject and a long commit body, announcing each', () => {
    const longSubject = 'x'.repeat(PR_DESCRIPTION_MAX_SUBJECT_CHARACTERS + 20);
    const longBody = 'y'.repeat(2_000);
    const brief = buildPrDescriptionBrief({
      repository: 'demo-user/demo-repo',
      baseBranch: 'main',
      headBranch: 'feature',
      commits: [{ sha: 'abcdef0123456789', subject: longSubject, body: longBody }],
      files: [],
    });

    expect(brief.text).toContain(`${'x'.repeat(PR_DESCRIPTION_MAX_SUBJECT_CHARACTERS)}…`);
    expect(brief.text).toContain('[commit message truncated]');
  });
});

describe('the changed-file-contents section', () => {
  it('shows the file texts at the head branch and counts what it left out', () => {
    const contents = buildPrDescriptionFileContents({
      paths: ['src/retry.ts', 'src/gone.ts'],
      texts: new Map([['src/retry.ts', 'export const retry = 1;\n']]),
    });
    const text = renderPrDescriptionFileContents(contents);

    expect(text).toContain('[changed-file-contents]');
    expect(text).toContain('at the head branch version');
    expect(text).toContain('--- src/retry.ts ---');
    expect(text).toContain('export const retry = 1;');
    // "We could not read it" and "the budget cut it" are different facts.
    expect(text).toContain('[1 changed file(s) had no readable text at the head branch and are not shown]');
    expect(text).not.toContain('src/gone.ts');
  });

  it('says so when no changed file could be read', () => {
    const text = renderPrDescriptionFileContents(buildPrDescriptionFileContents({ paths: [], texts: new Map() }));
    expect(text).toContain('(no changed file could be read at the head branch)');
  });
});

describe('the measured prompt text', () => {
  it('is the instruction block, the brief, and the file texts when the scope allows them', () => {
    const contents = buildPrDescriptionFileContents({
      paths: ['src/retry.ts'],
      texts: new Map([['src/retry.ts', 'export const retry = 1;']]),
    });
    const without = buildPrDescriptionPromptText(PR_DESCRIPTION_SYSTEM_PROMPT, 'BRIEF');
    const with_ = buildPrDescriptionPromptText(PR_DESCRIPTION_SYSTEM_PROMPT, 'BRIEF', {
      kind: 'files',
      fileContents: contents,
    });

    // `commits-only`: the instruction block and the brief, and no file text.
    expect(without).toBe(`${PR_DESCRIPTION_SYSTEM_PROMPT}\n\nBRIEF`);
    // `commits-and-files`: the same bytes plus the file section, so "what we
    // counted" and "what we sent" stay the same string.
    expect(with_.startsWith(without)).toBe(true);
    expect(with_).toContain('[changed-file-contents]');
    expect(with_).toContain('export const retry = 1;');
  });

  it('keeps the two scopes that shipped their exact bytes', () => {
    // The regression the diff tier must not break: a run whose scope adds no
    // material, and one that adds the file texts, produce the same strings the
    // assembly produced before the material parameter existed. Pinned against the
    // old expression itself rather than against a recorded literal, so a change to
    // the joining rule is caught even if the literal were updated to match.
    const contents = buildPrDescriptionFileContents({
      paths: ['src/retry.ts'],
      texts: new Map([['src/retry.ts', 'export const retry = 1;']]),
    });
    expect(buildPrDescriptionPromptText(PR_DESCRIPTION_SYSTEM_PROMPT, 'BRIEF')).toBe(
      `${PR_DESCRIPTION_SYSTEM_PROMPT}\n\nBRIEF`,
    );
    expect(
      buildPrDescriptionPromptText(PR_DESCRIPTION_SYSTEM_PROMPT, 'BRIEF', { kind: 'files', fileContents: contents }),
    ).toBe(`${PR_DESCRIPTION_SYSTEM_PROMPT}\n\nBRIEF\n\n${renderPrDescriptionFileContents(contents)}`);
  });
});

describe('the whole-pull-request diff section', () => {
  const SERVER_DIFF = [
    'diff --git a/src/index.ts b/src/index.ts',
    'index 1111111..2222222 100644',
    '--- a/src/index.ts',
    '+++ b/src/index.ts',
    '@@ -1,2 +1,3 @@',
    ' const a = 1;',
    '+const retry = 1;',
    ' export default a;',
    'diff --git a/assets/logo.png b/assets/logo.png',
    'index 3333333..4444444 100644',
    'Binary files a/assets/logo.png and b/assets/logo.png differ',
  ].join('\n');

  it("carries the server's bytes verbatim and says what it is", () => {
    const diff = buildPrDescriptionDiff(SERVER_DIFF);

    expect(diff.filesTotal).toBe(2);
    expect(diff.filesShown).toBe(2);
    expect(diff.truncatedBy).toBeUndefined();
    // Verbatim: the hunk header, the added line and the binary detection line are
    // the server's own text, and nothing here reconstructs a hunk.
    expect(diff.text).toContain('[diff]');
    expect(diff.text).toContain('@@ -1,2 +1,3 @@');
    expect(diff.text).toContain('+const retry = 1;');
    expect(diff.text).toContain('Binary files a/assets/logo.png and b/assets/logo.png differ');
    expect(diff.text).toContain('diff --git a/src/index.ts b/src/index.ts');
    // The preamble names the two facts a reader has to know: the diff is the
    // server's, and a binary file's change arrives without hunks.
    expect(diff.text).toContain('exactly as the server reports it');
    expect(diff.text).toContain('without hunks');
  });

  it('says so when the server reports no change', () => {
    const diff = buildPrDescriptionDiff('');
    expect(diff.filesShown).toBe(0);
    expect(diff.filesTotal).toBe(0);
    expect(diff.text).toContain('(the server reported no change)');
  });

  it('keeps a block whose path it cannot decode instead of dropping it', () => {
    // The pre-review's `splitDiffByFile` is path-keyed and therefore discards a
    // block whose `+++` line it cannot read. This section's promise is "here is the
    // diff", so a quoted (non-ASCII) path must survive: a dropped file here is a
    // silent omission, not a safe one.
    const quoted = [
      'diff --git "a/\\346\\226\\207.txt" "b/\\346\\226\\207.txt"',
      '--- "a/\\346\\226\\207.txt"',
      '+++ "b/\\346\\226\\207.txt"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    const diff = buildPrDescriptionDiff(quoted);
    expect(diff.filesTotal).toBe(1);
    expect(diff.filesShown).toBe(1);
    expect(diff.text).toContain('@@ -1 +1 @@');
  });

  it('drops whole files from the end when the budget runs out, and announces it', () => {
    // Two blocks, the second of which cannot fit: the kept one is whole, and the
    // announcement names how many of how many are shown.
    const first = `diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b`;
    const filler = 'x'.repeat(PR_DESCRIPTION_DIFF_BUDGET);
    const diff = buildPrDescriptionDiff(`${first}\ndiff --git a/b.ts b/b.ts\n@@ -1 +1 @@\n${filler}`);

    expect(diff.filesTotal).toBe(2);
    expect(diff.filesShown).toBe(1);
    expect(diff.truncatedBy).toBe('budget');
    expect(diff.text).toContain('diff --git a/a.ts b/a.ts');
    expect(diff.text).not.toContain('diff --git a/b.ts');
    expect(diff.text).toContain('[truncated: only 1 of 2 file(s) in the diff are shown]');
  });

  it('cuts a first file larger than the whole budget rather than sending no diff', () => {
    // The pathological case the file-contents section also handles: dropping this
    // block would send no diff at all under a scope whose whole content is the diff.
    const huge = `diff --git a/huge.ts b/huge.ts\n@@ -1 +1 @@\n-${'y'.repeat(PR_DESCRIPTION_DIFF_BUDGET * 2)}`;
    const diff = buildPrDescriptionDiff(huge);

    expect(diff.filesShown).toBe(1);
    expect(diff.truncatedBy).toBe('budget');
    expect(diff.text).toContain('diff --git a/huge.ts b/huge.ts');
    expect(diff.text).toContain("this file's diff is longer than the whole diff budget");
  });

  it('cuts the file list at the shared file cap, not only at the budget', () => {
    // A diff of many tiny files never reaches the character budget, so the cap has
    // to be its own limit — the same one the pre-review's brief uses.
    const blocks = Array.from(
      { length: PR_REVIEW_MAX_DIFF_FILES + 1 },
      (_, index) => `diff --git a/f${index}.ts b/f${index}.ts\n@@ -1 +1 @@\n-a\n+b`,
    );
    const diff = buildPrDescriptionDiff(blocks.join('\n'));

    expect(diff.filesTotal).toBe(PR_REVIEW_MAX_DIFF_FILES + 1);
    expect(diff.filesShown).toBe(PR_REVIEW_MAX_DIFF_FILES);
    expect(diff.truncatedBy).toBe('file-limit');
    expect(diff.text).toContain(
      `[truncated: only ${PR_REVIEW_MAX_DIFF_FILES} of ${PR_REVIEW_MAX_DIFF_FILES + 1} file(s)`,
    );
  });

  it('appends the diff section instead of the file texts, never both', () => {
    const diff = buildPrDescriptionDiff(SERVER_DIFF);
    const text = buildPrDescriptionPromptText(PR_DESCRIPTION_SYSTEM_PROMPT, 'BRIEF', { kind: 'diff', diff });

    expect(text.startsWith(`${PR_DESCRIPTION_SYSTEM_PROMPT}\n\nBRIEF`)).toBe(true);
    expect(text).toContain('[diff]');
    expect(text).not.toContain('[changed-file-contents]');
  });
});

describe('the model answer as a draft', () => {
  it('trims the ends and keeps everything else byte for byte', () => {
    const answer = parsePrDescriptionAnswer('\n\nAdds retry.\n\n- One thing\n  - indented\n');
    expect(answer).toEqual({ kind: 'ok', description: 'Adds retry.\n\n- One thing\n  - indented' });
  });

  it('refuses an empty answer', () => {
    expect(parsePrDescriptionAnswer('   \n\t ')).toEqual({ kind: 'failed', reason: 'empty', characterCount: 0 });
  });

  it('refuses an answer that is nothing but a code fence', () => {
    // A whole-answer fence would put three literal backticks into the body field.
    // A **partially** fenced answer (prose, then a snippet) is a good draft and is
    // deliberately not refused.
    expect(parsePrDescriptionAnswer('```markdown\nAdds retry.\n```')).toMatchObject({
      kind: 'failed',
      reason: 'code-fence',
    });
    expect(parsePrDescriptionAnswer('Adds retry.\n\n```ts\nconst a = 1;\n```')).toMatchObject({ kind: 'ok' });
  });

  it('refuses an answer longer than the cap rather than cutting it', () => {
    const answer = parsePrDescriptionAnswer('x'.repeat(PR_DESCRIPTION_MAX_CHARACTERS + 1));
    expect(answer).toEqual({
      kind: 'failed',
      reason: 'too-long',
      characterCount: PR_DESCRIPTION_MAX_CHARACTERS + 1,
    });
    expect(parsePrDescriptionAnswer('x'.repeat(PR_DESCRIPTION_MAX_CHARACTERS))).toMatchObject({ kind: 'ok' });
  });
});
