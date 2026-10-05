import { describe, expect, it } from 'vitest';
import {
  PR_DESCRIPTION_MAX_CHARACTERS,
  PR_DESCRIPTION_MAX_COMMITS,
  PR_DESCRIPTION_MAX_SUBJECT_CHARACTERS,
  PR_DESCRIPTION_SYSTEM_PROMPT,
  buildPrDescriptionBrief,
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
    const with_ = buildPrDescriptionPromptText(PR_DESCRIPTION_SYSTEM_PROMPT, 'BRIEF', contents);

    // `commits-only`: the instruction block and the brief, and no file text.
    expect(without).toBe(`${PR_DESCRIPTION_SYSTEM_PROMPT}\n\nBRIEF`);
    // `commits-and-files`: the same bytes plus the file section, so "what we
    // counted" and "what we sent" stay the same string.
    expect(with_.startsWith(without)).toBe(true);
    expect(with_).toContain('[changed-file-contents]');
    expect(with_).toContain('export const retry = 1;');
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
