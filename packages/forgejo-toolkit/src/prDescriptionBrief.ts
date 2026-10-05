import {
  type AiPreReviewFileContents,
  type AiPreReviewPromptMessage,
  aiPreReviewBodyLanguageName,
  aiPreReviewPromptText,
  buildAiPreReviewFileContents,
  buildAiPreReviewPromptMessages,
} from './aiPreReviewBrief';
import { PR_REVIEW_DIFF_BUDGET } from '../mcp/tools';

/**
 * The pure half of "generate a pull request description": what is sent to the
 * model provider, how the comparison is pre-sized to the shared budget, and how
 * the answer becomes the draft the form fills in.
 *
 * Nothing here touches `vscode`, for the reason `src/aiPreReviewBrief.ts` gives
 * about its own half: the assembly and the validator are the two pieces that
 * decide what leaves the machine, and they are the two that must be exhaustively
 * testable with malformed input. The host-side caller
 * (`src/prDescription.ts`) only fetches, asks, and hands the text back.
 *
 * Two rules are encoded here and must not be relaxed:
 *
 * 1. **Never send more than the user agreed to.** The scope the user stated
 *    (`forgejoToolkit.prDescriptionPromptScope`, `docs/design/ai-model-transport.md`
 *    §7.6) decides what the caller may hand this module: `commits-only` passes no
 *    file text, so the prompt carries the branch names, the commit list and the
 *    changed-file table — never a file's own content — while `commits-and-files`
 *    adds the changed files' text at the head revision and nothing else. There is
 *    no scope under which a token, a host name or an existing comment's body may
 *    appear, and this module has no way to reach one.
 * 2. **The draft is prose, and an empty answer is not a draft.** The answer is
 *    Markdown text, so there is no JSON contract to repair; an answer that is
 *    empty after trimming, or that is nothing but a code fence, is refused
 *    outright rather than written into the user's body field as an empty or
 *    fenced string.
 */

/**
 * The languages this feature may write a draft in, which are the two the
 * extension presents. Re-exported under this feature's own name so the prompt
 * builder reads as this feature's own vocabulary while the two values stay the
 * ones `resolveLocale` returns.
 */
export type PrDescriptionBodyLanguage = 'en' | 'zh';

/**
 * The most the feature will write into the user's body field, and the number the
 * instruction block quotes. A description is prose a person then edits, and an
 * answer longer than this is refused rather than truncated: cutting a draft
 * mid-sentence and calling it a draft is worse than saying the answer was too
 * long.
 *
 * Declared before the instruction block below because that function reads it at
 * module load: a `const` used above its own declaration is a temporal-dead-zone
 * error, which is exactly the failure the first draft of this file had.
 */
export const PR_DESCRIPTION_MAX_CHARACTERS = 16_384;

/**
 * The one instruction block this feature sends, built from the language the user
 * reads (`buildPrDescriptionSystemPrompt`).
 *
 * It is deliberately a **prose** contract rather than the pre-review's JSON one:
 * the answer is going straight into a Markdown body field for a person to edit,
 * so a schema would only add a way to fail. Everything it states is something the
 * validator or the user would otherwise have to discover:
 *
 * - the three things a reviewer needs, in the order a description usually has
 *   them, so the draft is usable as it stands;
 * - "only what you were given", because the model has no repository access and
 *   would otherwise invent file paths and function names;
 * - an explicit way out ("say you cannot") so a thin comparison does not produce
 *   invented material — the caller turns a refusal into a message rather than
 *   into a body;
 * - the character cap, so `PR_DESCRIPTION_MAX_CHARACTERS` refuses rather than
 *   silently truncates;
 * - the language rule, for the reason the pre-review states its own: nothing else
 *   in the request carries the user's language, and the answer is prose.
 */
export function buildPrDescriptionSystemPrompt(language: PrDescriptionBodyLanguage): string {
  return [
    'You write the description of a pull request from the comparison you are given.',
    '',
    'Answer with Markdown prose only — no JSON, no code fence around the whole answer, and no preamble.',
    'Shape the answer as:',
    '- one short paragraph summarising what the change does and why it matters;',
    '- a "Changes" list, one bullet per meaningful change;',
    '- an optional "Notes" list for anything a reviewer has to know (a migration, a behaviour that changed, what was not tested).',
    '',
    'Rules:',
    '- Use only what the comparison below contains. Never name a file, a function, a symbol or a test that is not shown there.',
    '- Do not invent a motivation, an issue number or a test result that the comparison does not state.',
    `- Answer in at most ${PR_DESCRIPTION_MAX_CHARACTERS} characters.`,
    `- Write the prose in ${aiPreReviewBodyLanguageName(language)}. Code identifiers, paths and commit subjects stay exactly as they are given.`,
    '- If the comparison does not carry enough to describe the change honestly, answer with one line saying what is missing. Do not pad it.',
  ].join('\n');
}

/**
 * The **English** instruction block, kept as a constant for the readers that are
 * not a run of a specific user (the tests that pin the contract's wording). A run
 * never uses it: it builds its block for the language the user reads, exactly as
 * the pre-review does.
 */
export const PR_DESCRIPTION_SYSTEM_PROMPT = buildPrDescriptionSystemPrompt('en');

/**
 * The most the feature will send for one commit message. A commit body is
 * unbounded in principle (a merge commit can carry pages), and the brief has to
 * be pre-sized before it can be measured against a model's budget.
 */
export const PR_DESCRIPTION_MAX_COMMIT_MESSAGE_CHARACTERS = 1_000;

/**
 * How many commits one prompt may carry. Newest first, exactly as the server
 * lists them, and a cut drops whole commits from the end — the prompt says so.
 * Smaller than the shared list cap on purpose: a description is written from what
 * a person would read, not from a full history.
 */
export const PR_DESCRIPTION_MAX_COMMITS = 50;

/**
 * How much of one commit's subject line is kept. A subject is meant to be one
 * line; a commit whose first line is longer is cut rather than allowed to push
 * the rest of the list out of the prompt.
 */
export const PR_DESCRIPTION_MAX_SUBJECT_CHARACTERS = 200;

/**
 * How many changed-file rows one prompt may carry, and how much room the whole
 * changed-file table may take. The same budget the pre-review's brief uses, for
 * the same reason: it is the size of request this feature is willing to build,
 * and the token budget in the caller then cuts again if the model is smaller.
 */
export const PR_DESCRIPTION_MAX_FILES = 300;
export const PR_DESCRIPTION_FILE_TABLE_BUDGET = PR_REVIEW_DIFF_BUDGET;

/** One commit as the brief is allowed to carry. */
export interface PrDescriptionCommit {
  /** The full sha, as the server reports it. Shown short in the prompt. */
  sha: string;
  /** The first line of the commit message. */
  subject: string;
  /** The rest of the message, without its subject line. */
  body?: string;
  /** The author's display name or login, when the server reported one. */
  author?: string;
  /** The author date, as the server reported it. */
  date?: string;
}

/** One changed file as the brief is allowed to carry (§7.6). */
export interface PrDescriptionChangedFile {
  path: string;
  /** `added` / `removed` / `modified` from the comparison endpoint. */
  status?: string;
}

/** What one run knows about the comparison, before the prompt is assembled. */
export interface PrDescriptionBriefInput {
  /** The repository, as `owner/repo`, for the prompt's own header. */
  repository: string;
  baseBranch: string;
  headBranch: string;
  /** The title the user has typed into the form, when they have typed one. */
  title?: string;
  commits: readonly PrDescriptionCommit[];
  files: readonly PrDescriptionChangedFile[];
}

/**
 * The assembled prompt's user half plus the facts the run reports about it.
 *
 * `truncatedBy` is what lets the prompt state its own cuts, per the rule the
 * pre-review's brief follows: a model shown part of a comparison must know it is
 * part of one, or it will describe the part as the whole.
 */
export interface PrDescriptionBrief {
  /** The user half of the request, without any file-content section. */
  text: string;
  /** How many commits the comparison held, before the cap. */
  commitsTotal: number;
  /** How many commits the prompt carries. */
  commitsShown: number;
  /** How many changed files the comparison held, before the cap. */
  filesTotal: number;
  /** How many changed files the prompt carries. */
  filesShown: number;
  truncatedBy?: 'commit-limit' | 'file-limit' | 'file-budget';
}

/** The commit's own line: its short sha, its date, its author and its subject. */
function commitLine(commit: PrDescriptionCommit): string {
  const sha = commit.sha.slice(0, 12);
  const facts = [commit.date, commit.author].filter((value): value is string => (value ?? '') !== '');
  const prefix = facts.length === 0 ? `- ${sha}` : `- ${sha} (${facts.join(', ')})`;
  const subject = commit.subject.trim();
  const kept =
    subject.length <= PR_DESCRIPTION_MAX_SUBJECT_CHARACTERS
      ? subject
      : `${subject.slice(0, PR_DESCRIPTION_MAX_SUBJECT_CHARACTERS)}…`;
  return `${prefix}: ${kept}`;
}

/**
 * The commit's indented body, cut to
 * {@link PR_DESCRIPTION_MAX_COMMIT_MESSAGE_CHARACTERS}, or `undefined` when
 * there is nothing left of it after trimming.
 *
 * A cut is announced inside the text, so the model reading a truncated paragraph
 * knows it stopped rather than assuming the sentence ended.
 */
function commitBodyLines(commit: PrDescriptionCommit): string[] {
  const body = (commit.body ?? '').trim();
  if (body === '') {
    return [];
  }
  const kept =
    body.length <= PR_DESCRIPTION_MAX_COMMIT_MESSAGE_CHARACTERS
      ? body
      : `${body.slice(0, PR_DESCRIPTION_MAX_COMMIT_MESSAGE_CHARACTERS)}\n[commit message truncated]`;
  return kept.split('\n').map((line) => `  ${line}`.trimEnd());
}

/** The `[commits]` section, newest first as the server listed them. */
function renderCommitsSection(
  commits: readonly PrDescriptionCommit[],
  truncatedBy: PrDescriptionBrief['truncatedBy'],
): string {
  const lines = ['[commits]'];
  if (commits.length === 0) {
    lines.push('(the comparison reports no commit; it may be empty, or the branch may only be behind)');
    return lines.join('\n');
  }
  lines.push('(newest first, as the server lists them)');
  for (const commit of commits) {
    lines.push(commitLine(commit));
    lines.push(...commitBodyLines(commit));
  }
  if (truncatedBy === 'commit-limit') {
    lines.push(`[truncated: only the newest ${commits.length} commit(s) are shown]`);
  }
  return lines.join('\n');
}

/** One changed-file row: its status and its path. */
function fileRow(file: PrDescriptionChangedFile): string {
  const status = (file.status ?? '').trim();
  return status === '' ? `- ${file.path}` : `- ${status}: ${file.path}`;
}

/**
 * The `[changed-files]` section: the comparison's own file list, statuses
 * included, cut from the end when it exceeds either the row cap or the character
 * budget.
 *
 * A row costs far less than a file's text, so this section is bounded by the
 * shared diff budget the whole prompt's other halves also use rather than by a
 * smaller number of its own.
 */
function renderChangedFilesSection(
  files: readonly PrDescriptionChangedFile[],
  truncatedBy: PrDescriptionBrief['truncatedBy'],
): string {
  const lines = ['[changed-files]'];
  if (files.length === 0) {
    lines.push('(the comparison reports no changed file)');
    return lines.join('\n');
  }
  lines.push('(the files the comparison reports between the two branches, with the status it reports)');
  let used = 0;
  let shown = 0;
  for (const file of files) {
    const row = fileRow(file);
    if (used + row.length + 1 > PR_DESCRIPTION_FILE_TABLE_BUDGET) {
      break;
    }
    lines.push(row);
    used += row.length + 1;
    shown += 1;
  }
  if (truncatedBy === 'file-limit' || shown < files.length) {
    lines.push(`[truncated: only ${shown} of ${files.length} changed file(s) are shown]`);
  }
  return lines.join('\n');
}

/**
 * Assembles the user half of one request: the comparison's own facts, in the
 * order the prompt's instruction block asks for them.
 *
 * The prompt carries **no line-level diff**, and that is a fact about the
 * interface rather than a choice here: `GET /repos/{owner}/{repo}/compare/{basehead}`
 * reports the commits, their messages and the changed files with a status
 * (`added`/`removed`/`modified`) and nothing else — no hunks and no additions or
 * deletions, which only the pull request's own files endpoint reports
 * (`docs/api-verification-checklist.md`, the `repoCompareDiff` entry). A
 * pull request that does not exist yet has no index for that endpoint, so what
 * this feature can honestly send is the commit list and the changed-file set.
 * The record's §7.6 records that narrowing and `TODO.md` carries what remains.
 *
 * The title the user has already typed is passed through when it is non-empty:
 * it is what the form is about to submit, and a description that ignores it would
 * be about a pull request nobody is opening.
 */
export function buildPrDescriptionBrief(input: PrDescriptionBriefInput): PrDescriptionBrief {
  const commitsTotal = input.commits.length;
  const filesTotal = input.files.length;
  const commits = input.commits.slice(0, PR_DESCRIPTION_MAX_COMMITS);
  const files = input.files.slice(0, PR_DESCRIPTION_MAX_FILES);
  let truncatedBy: PrDescriptionBrief['truncatedBy'];
  if (commitsTotal > commits.length) {
    truncatedBy = 'commit-limit';
  }
  if (filesTotal > files.length) {
    truncatedBy = truncatedBy ?? 'file-limit';
  }

  const title = (input.title ?? '').trim();
  const header = [
    '[pull-request]',
    `repository: ${input.repository}`,
    `base branch: ${input.baseBranch}`,
    `head branch: ${input.headBranch}`,
    ...(title === '' ? [] : [`title (typed by the user, may still change): ${title}`]),
    '(this pull request does not exist yet: the comparison below is what its author is about to submit)',
  ].join('\n');

  const text = [header, renderCommitsSection(commits, truncatedBy), renderChangedFilesSection(files, truncatedBy)].join(
    '\n\n',
  );

  return {
    text,
    commitsTotal,
    commitsShown: commits.length,
    filesTotal,
    filesShown: files.length,
    ...(truncatedBy === undefined ? {} : { truncatedBy }),
  };
}

/**
 * The `[changed-file-contents]` section of the `commits-and-files` scope.
 *
 * It reuses the **shaping** the pre-review's file-content section uses
 * (`buildAiPreReviewFileContents`: the same file cap, the same character budget,
 * the same drop-from-the-end rule and the same `unavailable` accounting) and
 * writes its own heading, because the wording of that section names a pull
 * request head and this feature has no pull request yet. Reusing the shaping is
 * the point: the two features must not disagree about how much of a file text is
 * too much.
 */
export function renderPrDescriptionFileContents(contents: AiPreReviewFileContents): string {
  const lines: string[] = ['[changed-file-contents]'];
  if (contents.sections.length === 0) {
    lines.push('(no changed file could be read at the head branch)');
  } else {
    lines.push('(the changed file(s) below are shown in full, at the head branch version)');
    for (const section of contents.sections) {
      lines.push(`--- ${section.path} ---`);
      lines.push(section.text);
      if (section.truncated) {
        lines.push(`[truncated: only the beginning of ${section.path} is shown]`);
      }
    }
  }
  if (contents.unavailable > 0) {
    lines.push(`[${contents.unavailable} changed file(s) had no readable text at the head branch and are not shown]`);
  }
  if (contents.truncatedBy !== undefined) {
    lines.push(
      `[truncated: the file-content list is incomplete (truncatedBy=${contents.truncatedBy}); treat what is shown as part of the change]`,
    );
  }
  return lines.join('\n');
}

/**
 * Pre-sizes the `commits-and-files` payload with the pre-review's own builder.
 *
 * Exported as a thin re-export rather than a copy so the two features cannot
 * acquire two different file caps: the caller hands this the paths and the texts
 * it managed to read, and gets back the sections plus the facts its prompt has to
 * state.
 */
export function buildPrDescriptionFileContents(input: {
  paths: readonly string[];
  texts: ReadonlyMap<string, string>;
}): AiPreReviewFileContents {
  return buildAiPreReviewFileContents(input);
}

/**
 * The whole text one request sends: the instruction block, a blank line, then the
 * caller's half (plus the file texts when the scope allows them).
 *
 * It reuses `aiPreReviewPromptText`'s exact joining rule so "what we counted" and
 * "what we sent" cannot drift, and the two features cannot disagree about the
 * shape of a request.
 */
export function buildPrDescriptionPromptText(
  systemPrompt: string,
  briefText: string,
  fileContents?: AiPreReviewFileContents,
): string {
  const userPrompt =
    fileContents === undefined ? briefText : `${briefText}\n\n${renderPrDescriptionFileContents(fileContents)}`;
  return aiPreReviewPromptText(systemPrompt, userPrompt);
}

/**
 * The messages one request sends: **exactly one** `User` message, through the
 * pre-review's builder.
 *
 * One message rather than two, for the reasons that builder documents at length
 * (no system role in `@types/vscode` 1.102, and a provider converts each `User`
 * message to its own `user` role, so a second one is a second turn a conversion
 * may handle loosely). This feature has no reason to differ, and a shared
 * function is what keeps it from drifting.
 */
export function buildPrDescriptionPromptMessages(systemPrompt: string, userPrompt: string): AiPreReviewPromptMessage[] {
  return buildAiPreReviewPromptMessages(systemPrompt, userPrompt);
}

/** Why an answer cannot become a draft. Every reason is reported in its own words. */
export type PrDescriptionAnswerFailure =
  /** Nothing but whitespace came back. */
  | 'empty'
  /** Nothing but a Markdown code fence came back. */
  | 'code-fence'
  /** The answer is longer than {@link PR_DESCRIPTION_MAX_CHARACTERS}. */
  | 'too-long';

/** The answer as a usable draft, or the reason it is not one. */
export type PrDescriptionAnswer =
  | { kind: 'ok'; description: string }
  | { kind: 'failed'; reason: PrDescriptionAnswerFailure; characterCount: number };

/**
 * Whether the trimmed answer is nothing but a code fence.
 *
 * A model that wraps the whole description in ``` fences would otherwise put
 * three literal backticks into the body field, where the user then has to remove
 * them. A fenced answer is refused rather than unwrapped: the same instruction
 * block already says "no code fence around the whole answer", so unwrapping it
 * here would be this module quietly correcting a model the user was told not to
 * expect that from — and a partially fenced answer (prose, then a snippet) is a
 * perfectly good draft, which is why only the all-fence case is refused.
 */
function isWholeAnswerACodeFence(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length < 2) {
    return false;
  }
  const first = lines[0]?.trim() ?? '';
  const last = lines[lines.length - 1]?.trim() ?? '';
  return first.startsWith('```') && last === '```';
}

/**
 * The model's answer as the draft the form fills in — or the reason it is not a
 * draft (§7.6, and the instruction block's own two sentences).
 *
 * Trimming the ends is the only normalisation: leading and trailing blank lines
 * are an artefact of how a model emits text, not content, and the form's body
 * field shows the rest byte for byte. Nothing else is repaired — no unwrapping,
 * no re-flowing, no cutting to the cap — because the answer goes in front of a
 * person who can edit it, and a silent repair would make the draft differ from
 * what the model said without saying so.
 */
export function parsePrDescriptionAnswer(text: string): PrDescriptionAnswer {
  const trimmed = text.trim();
  const characterCount = trimmed.length;
  if (trimmed === '') {
    return { kind: 'failed', reason: 'empty', characterCount };
  }
  if (isWholeAnswerACodeFence(trimmed)) {
    return { kind: 'failed', reason: 'code-fence', characterCount };
  }
  if (characterCount > PR_DESCRIPTION_MAX_CHARACTERS) {
    return { kind: 'failed', reason: 'too-long', characterCount };
  }
  return { kind: 'ok', description: trimmed };
}

export type { AiPreReviewFileContentSection } from './aiPreReviewBrief';
