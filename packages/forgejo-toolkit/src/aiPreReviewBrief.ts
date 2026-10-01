import {
  PR_REVIEW_COMMENT_BUDGET,
  PR_REVIEW_DIFF_BUDGET,
  PR_REVIEW_MAX_COMMENT_LENGTH,
  PR_REVIEW_MAX_COMMENTS,
  PR_REVIEW_MAX_DIFF_FILES,
} from '../mcp/tools';
import { parsePullDiff, type FileDiffMap, type ParsedPullDiff } from './utils/parseDiff';
import type { ForgejoChangedFile } from './api/types';

/**
 * The pure half of the AI pre-review: what is sent to the model provider, how
 * the changed files are pre-sized to the shared budget, and how the model's
 * JSON is turned into comment candidates.
 *
 * Nothing here touches `vscode`. The design record
 * (`docs/design/ai-prereview.md`, §8.3) asks for exactly this split: the
 * validator and the brief assembly are the two pieces that must be exhaustively
 * testable with malformed input, and they are also the two pieces that decide
 * what leaves the machine. The host-side caller (`src/aiPreReview.ts`) only
 * fetches, calls the model and writes — it never remaps an anchor.
 *
 * Two rules from the record are encoded here and must not be relaxed:
 *
 * 1. **Never send more than the user agreed to.** The scope the user stated
 *    (`forgejoToolkit.aiPreReviewPromptScope`) decides what the caller may hand
 *    this module: `metadata-only` passes no diff and no file text, so the prompt
 *    carries the changed-file table and the *metadata* of existing review
 *    comments — never a comment body, never a URL or host name; the other three
 *    scopes add the diff body, the changed lines of that diff, or the changed
 *    files' own head text, and nothing else. There is no scope under which a
 *    token, a host name or an existing comment's body may appear.
 * 2. **Never repair a model anchor.** A comment whose path, side, line or range
 *    does not survive validation is dropped and counted; nothing is moved to a
 *    nearby line, flipped to the other side, fuzzy-matched by name or clamped
 *    from a range to a single line.
 */

/** Which side of the diff a candidate comment anchors to. */
export type AiPreReviewSide = 'head' | 'base';

/** A comment candidate that survived validation. */
export interface AiPreReviewCandidate {
  path: string;
  /** 1-based file line the comment anchors to, on `side`. */
  line: number;
  side: AiPreReviewSide;
  /** Extra lines the comment covers after `line`; `0` means a single line. */
  extraLines: number;
  body: string;
  /** True when the body was cut to `PR_REVIEW_MAX_COMMENT_LENGTH`. */
  bodyTruncated?: boolean;
}

/** Why a model comment was dropped. Every reason is counted separately. */
export type AiPreReviewDropReason =
  | 'comment-limit'
  | 'duplicate-anchor'
  | 'invalid-body'
  | 'invalid-extra-lines'
  | 'invalid-shape'
  | 'invalid-side'
  | 'line-outside-diff'
  | 'missing-path'
  | 'path-not-in-changed-files'
  | 'unsafe-path';

/** `candidates-dropped` is the §6.5 count cap: the extras never reached validation. */
export type AiPreReviewDrop =
  | { reason: 'candidates-dropped'; count: number }
  | { reason: AiPreReviewDropReason; count: number };

/** One changed file as the brief reports it, with the diff map of its own hunks. */
export interface AiPreReviewBriefFile {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  /**
   * Whether the diff carries hunks for this path. A file can be listed by the
   * pull request without a hunk block (a binary change, or a server that
   * answered a partial diff); such a file is described in the brief but can
   * never receive a line comment, which the prompt has to say.
   */
  hasDiff: boolean;
  /** Line tables of the file's hunks; `undefined` when `hasDiff` is false. */
  diff?: FileDiffMap;
}

/** The assembled pre-review brief: the prompt text plus the file table behind it. */
export interface AiPreReviewBrief {
  /** The brief itself, without any diff-body section. */
  text: string;
  files: AiPreReviewBriefFile[];
  /**
   * Which limit cut the file table: the shared row cap, the shared character
   * budget, or the caller's token budget (which drops whole files, including
   * their diff sections, from the end of the list).
   */
  truncatedBy?: 'row-limit' | 'budget' | 'token-budget';
  /**
   * The prompt halves that do not depend on the file list, rendered once.
   * `text` is these plus `files`; keeping them apart is what lets the token
   * budget re-render the brief with fewer files without rebuilding — or
   * re-reading — the review metadata.
   */
  readonly header: string;
  readonly commentMetadata: string;
}

/** The pull request fields the brief is allowed to carry (§7.1). */
export interface AiPreReviewPullRequestHeader {
  number?: number;
  title?: string;
  baseBranch?: string;
  headBranch?: string;
}

/** The metadata of one existing review comment — never its body (§7.1, §13.5). */
export interface AiPreReviewExistingComment {
  path?: string;
  /** 1-based file line, or `undefined` for a comment with no usable anchor. */
  line?: number;
  side?: 'new' | 'old';
  author?: string;
  /** Review state the comment belongs to (`COMMENT`, `APPROVED`, `PENDING`, …). */
  reviewState?: string;
}

/** One existing review's metadata: its state, author and comment count. */
export interface AiPreReviewExistingReview {
  state?: string;
  author?: string;
  comments: AiPreReviewExistingComment[];
}

/**
 * How many comment candidates one run keeps (§6.5). Deliberately a separate
 * number from `PR_REVIEW_MAX_COMMENTS`: that one bounds what an agent reads
 * from an existing discussion, this one bounds what a *person* is asked to
 * review one by one.
 */
export const AI_PRE_REVIEW_MAX_COMMENTS = 20;

/**
 * The two UI languages this extension presents to a user, which are exactly the
 * two `resolveLocale` returns. The instruction block is built for one of them;
 * nothing else in this module depends on `vscode`, so the type lives here rather
 * than in the host-side settings module that reads the setting.
 */
export type AiPreReviewBodyLanguage = 'en' | 'zh';

/**
 * The name of one language **as the prompt names it**, in the language's own
 * script: a model has to be told `简体中文`, not `Chinese`, to reliably answer in
 * Simplified Chinese.
 *
 * Only these two names exist because only these two languages do: the extension
 * ships an English and a Chinese UI, and `src/utils/resolveLocale.ts` reads
 * anything that is not one of the two as English.
 */
export function aiPreReviewBodyLanguageName(language: AiPreReviewBodyLanguage): string {
  return language === 'zh' ? '简体中文' : 'English';
}

/**
 * The instruction half of the prompt, built **once per run** for the language
 * the user reads (see `aiPreReviewSettings.ts`'s
 * `aiPreReviewCommentBodyLanguage`). It is a function rather than a constant
 * because the language is per user, and it is called once because the same bytes
 * have to go to both attempts of the one model.
 *
 * Every rule here is load-bearing — the validator drops, and never repairs, a
 * comment that breaks one — so the wording is kept as short as it can be while
 * still stating all of them. The language rule is one of them: without it the
 * model answers an English instruction block in English whatever the editor's
 * language is, which is what an acceptance run on a `zh-cn` editor showed (the
 * bodies came back in English). It is stated explicitly rather than left to the
 * model's own reading of the conversation, because nothing else in the request
 * carries the user's language: the brief is file paths, counts and code.
 *
 * The rule draws the line the JSON contract draws: every comment's `body` is
 * prose and is written in that language, while the keys and every value that is
 * not prose — the schema's field names, `"head"`/`"base"`, `path` and the
 * numbers — stay exactly as specified, because the validator matches them
 * literally and `path` has to equal a changed file's path byte for byte.
 *
 * It travels as the first part of the request's one `User` message
 * (`buildAiPreReviewPromptMessages`), not as a message of its own:
 * `@types/vscode` 1.102 declares `LanguageModelChatMessageRole` with only `User`
 * and `Assistant` and `LanguageModelChatMessage` with no `System` factory, and
 * the API guide's note still reads "Currently, the Language Model API doesn't
 * support the use of system messages" — so splitting the contract off would not
 * buy it a system turn, only a second user turn that a provider's conversion is
 * free to mishandle. The budget that matters is checked with `countTokens`
 * against `maxInputTokens` in `src/aiPreReview.ts`, which also picks a model
 * that can hold this text.
 */
export function buildAiPreReviewSystemPrompt(language: AiPreReviewBodyLanguage): string {
  return [
    'You review a Forgejo pull request and propose line-level review comments.',
    '',
    'Rules:',
    '- Answer with strict JSON only. No prose, no Markdown code fence.',
    '- Shape: {"comments":[{"path":string,"line":number,"side":"head"|"base","extraLines":number,"body":string}]}',
    '- Copy `path` exactly from the changed-file list; never invent or adjust a path.',
    '- `line` is 1-based in the file on `side`: "head" is the new file, "base" the old one.',
    '- `extraLines` is the number of extra lines after `line`; use 0 for a single line.',
    '- Anchor only to a line shown in the diff you were given; never guess an unseen line.',
    `- Return at most ${AI_PRE_REVIEW_MAX_COMMENTS} comments; prefer the few that matter most.`,
    `- Keep each body under ${PR_REVIEW_MAX_COMMENT_LENGTH} characters.`,
    `- Write every comment body in ${aiPreReviewBodyLanguageName(language)}. The JSON keys, and every value that is not prose — the schema's field names, "head"/"base", paths and the numbers — stay exactly as specified.`,
    '- An empty comment list is a valid answer: say nothing when nothing is worth saying.',
  ].join('\n');
}

/**
 * The **English** instruction block: `buildAiPreReviewSystemPrompt('en')`, kept
 * as a constant for the two readers that are not a review run of a specific
 * user — the probe command's two "instructions" shapes, which measure whether a
 * provider can carry an instruction block and a request at all and whose wording
 * is therefore irrelevant (`aiPreReviewProbeShapes`), and the tests that pin the
 * contract's wording. A run never uses this constant: it builds its block for
 * the language the user reads.
 */
export const AI_PRE_REVIEW_SYSTEM_PROMPT = buildAiPreReviewSystemPrompt('en');

/**
 * One message of one request: the role and the exact text.
 *
 * A plain shape rather than a `vscode.LanguageModelChatMessage`, because this
 * module stays free of `vscode`: the same value is what the host turns into a
 * real message, what the debug dump prints as "what was sent", and what the
 * tests can assert without an editor.
 */
export interface AiPreReviewPromptMessage {
  role: 'user';
  text: string;
}

/**
 * The whole text one request sends: the instructions the caller built once
 * (`buildAiPreReviewSystemPrompt`), a blank line, then the caller's half (the
 * brief, with the diff body when the scope allows it).
 *
 * This is the string the prompt budget is measured on *and* the string the
 * request carries, so "what we counted" and "what we sent" cannot drift. The
 * instruction text is an argument rather than a re-derivation from a language:
 * the run prepares those bytes once and hands the same value to the token
 * counter, to both attempts and to the diagnostics dump.
 */
export function aiPreReviewPromptText(systemPrompt: string, userPrompt: string): string {
  return `${systemPrompt}\n\n${userPrompt}`;
}

/**
 * The messages one request sends: **exactly one** `User` message.
 *
 * The feature used to send two `User` messages (the instructions, then the
 * brief). One message is what the API's own facts support:
 *
 * - There is no system role to put the instructions in (see the note on
 *   `buildAiPreReviewSystemPrompt`), and a provider does not receive messages
 *   verbatim: it gets role + content parts (`LanguageModelChatRequestMessage`)
 *   and converts them to its own API's roles. The documented conversion maps
 *   *every* `User` message to the same `user` role, so two `User` messages
 *   become two consecutive user turns — a shape some providers and the chat
 *   templates behind them handle loosely, and one that puts the contract in a
 *   message a conversion is free to drop.
 * - With one message there is no earlier message to lose: whatever a provider
 *   does with a single user turn, the model sees both the rules and the pull
 *   request, or it sees nothing at all and the answer fails the contract loudly.
 * - The budget is then measured on the exact text that goes out
 *   (`aiPreReviewPromptText`) rather than on the sum of two separate
 *   `countTokens` calls, which only approximates the concatenation.
 *
 * What does not change: the rules themselves, the two halves of the prompt, and
 * the validation on the way back. The file-granularity cut still rewrites only
 * the caller's half.
 */
export function buildAiPreReviewPromptMessages(systemPrompt: string, userPrompt: string): AiPreReviewPromptMessage[] {
  return [{ role: 'user', text: aiPreReviewPromptText(systemPrompt, userPrompt) }];
}

/**
 * Character cap on one body, **announcement included**, matching the brief's own
 * discipline.
 *
 * The announcement is inside the cap on purpose (2026-10-02). The confirmation
 * panel caps the text a user may edit into a body at this same constant and the
 * host enforces it on everything the webview sends, so a body that ended up
 * longer than the cap could not be created from the panel without an edit first —
 * and an unedited card that cannot be created is a trap the user has no way to
 * explain. Cutting the model's text to `cap - announcement` instead keeps every
 * offered body creatable as it stands; the dropped count is still exact, so
 * nothing is lost silently.
 */
export const AI_PRE_REVIEW_MAX_BODY_LENGTH = PR_REVIEW_MAX_COMMENT_LENGTH;

/** The exact wording appended to a body the cap cut. */
function bodyTruncationAnnouncement(droppedCharacters: number): string {
  return `\n... (truncated: ${droppedCharacters} more characters)`;
}

/**
 * The model's body, cut to {@link AI_PRE_REVIEW_MAX_BODY_LENGTH} with its
 * announcement inside that budget, or unchanged when it already fits.
 *
 * How many characters can be kept depends on how many digits the dropped count
 * needs, so the kept length is settled by shrinking it until the announcement
 * fits. Each step strictly shrinks the kept prefix, so the loop terminates; the
 * cap is 1024 characters, so it settles in a couple of steps.
 */
function cutAiPreReviewBody(body: string): { body: string; truncated: boolean } {
  if (body.length <= AI_PRE_REVIEW_MAX_BODY_LENGTH) {
    return { body, truncated: false };
  }
  let kept = AI_PRE_REVIEW_MAX_BODY_LENGTH;
  while (kept > 0 && kept + bodyTruncationAnnouncement(body.length - kept).length > AI_PRE_REVIEW_MAX_BODY_LENGTH) {
    kept -= 1;
  }
  return { body: body.slice(0, kept) + bodyTruncationAnnouncement(body.length - kept), truncated: true };
}

const PATH_SEGMENT_SEPARATOR = '/';

/**
 * Whether a model-supplied path is safe to use as an anchor. Mirrors the
 * `pathSegmentSchema`/`isSafePathSegment` discipline of the MCP tool surface:
 * absolute paths and `..` segments are rejected outright rather than resolved.
 * The caller additionally requires an exact match against a changed file, so
 * this only rules out shapes that must never reach a request body at all.
 */
export function isSafeBriefPath(path: string): boolean {
  if (!path || path.startsWith(PATH_SEGMENT_SEPARATOR)) {
    return false;
  }
  if (path.includes('\\') || path.includes('\u0000')) {
    return false;
  }
  return !path.split(PATH_SEGMENT_SEPARATOR).some((segment) => segment === '..');
}

/** The comment metadata line of the brief. Bodies are never included. */
function formatExistingComment(comment: AiPreReviewExistingComment): string {
  const location =
    comment.path === undefined
      ? '(no file)'
      : `${comment.path}:${comment.line ?? '?'} (${comment.side === 'old' ? 'base' : comment.side === 'new' ? 'head' : 'unknown side'})`;
  const author = comment.author ?? 'unknown';
  const state = comment.reviewState ?? 'unknown';
  return `- ${location} by ${author} [${state}]`;
}

/**
 * Assembles the brief (§7.1, §7.2).
 *
 * The changed-file table is pre-sized with the same constants and the same
 * keep-the-start discipline `get_pr_review_brief` uses (`PR_REVIEW_DIFF_BUDGET`
 * characters, `PR_REVIEW_MAX_DIFF_FILES` rows), and the existing-comment
 * metadata with `PR_REVIEW_COMMENT_BUDGET`. Every cut is announced in the text
 * itself, because the model has to know when it is looking at part of the
 * change rather than all of it.
 *
 * `diff` is required even though its body is not sent: it is what supplies the
 * per-file line tables the validator checks anchors against, and a file whose
 * path is not in it is reported as having no commentable lines.
 */
export function buildAiPreReviewBrief(input: {
  pullRequest: AiPreReviewPullRequestHeader;
  changedFiles: readonly ForgejoChangedFile[];
  diffText: string;
  existingReviews: readonly AiPreReviewExistingReview[];
}): AiPreReviewBrief {
  const parsedDiff: ParsedPullDiff = parsePullDiff(input.diffText);
  const files: AiPreReviewBriefFile[] = [];
  let used = 0;
  let truncatedBy: AiPreReviewBrief['truncatedBy'];

  for (const file of input.changedFiles) {
    if (files.length >= PR_REVIEW_MAX_DIFF_FILES) {
      truncatedBy = 'row-limit';
      break;
    }
    const path = file.filename ?? '';
    const fileDiff = parsedDiff.files.get(path);
    const cost =
      JSON.stringify({ path, status: file.status, additions: file.additions, deletions: file.deletions }).length + 1;
    if (used + cost > PR_REVIEW_DIFF_BUDGET) {
      truncatedBy = 'budget';
      break;
    }
    used += cost;
    files.push({
      path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      hasDiff: fileDiff !== undefined,
      diff: fileDiff,
    });
  }
  // A break is not the only way the table can be short: the caller hands in the
  // list it fetched, which the client's own 500-row page cap may already have
  // cut. The note is what tells the model it is looking at part of the change.
  if (truncatedBy === undefined && files.length < input.changedFiles.length) {
    truncatedBy = 'row-limit';
  }

  // Existing review metadata, pre-sized to the comment budget and cut
  // newest-last like the file table. Bodies stay out by construction: only the
  // fields of `AiPreReviewExistingComment` are ever formatted.
  const commentLines: string[] = [];
  let commentUsed = 0;
  let commentTruncated = false;
  let commentCount = 0;
  for (const review of input.existingReviews) {
    for (const comment of review.comments) {
      if (commentCount >= PR_REVIEW_MAX_COMMENTS) {
        commentTruncated = true;
        break;
      }
      const withState = { ...comment, reviewState: comment.reviewState ?? review.state };
      const rendered = formatExistingComment(withState);
      const cost = rendered.length + 1;
      if (commentUsed + cost > PR_REVIEW_COMMENT_BUDGET) {
        commentTruncated = true;
        break;
      }
      commentUsed += cost;
      commentCount += 1;
      commentLines.push(rendered);
    }
    if (commentTruncated) {
      break;
    }
  }

  const metadataLines = ['[existing-review-comment-metadata]'];
  if (commentLines.length === 0) {
    metadataLines.push('(none)');
  } else {
    metadataLines.push(...commentLines);
  }
  if (commentTruncated) {
    metadataLines.push(
      '[truncated: more existing review comments were not listed; do not repeat the ones you were shown]',
    );
  }

  const brief: AiPreReviewBrief = {
    header: formatPullRequestHeader(input.pullRequest),
    files,
    truncatedBy,
    commentMetadata: metadataLines.join('\n'),
    text: '',
  };
  return { ...brief, text: renderAiPreReviewBriefText(brief) };
}

/**
 * Renders the brief's text from its current file list.
 *
 * Called by `buildAiPreReviewBrief` for the whole table and again by the token
 * budget for a shorter one: a cut that dropped files has to be visible in the
 * text, not only in the array the caller happens to hold.
 */
export function renderAiPreReviewBriefText(brief: AiPreReviewBrief): string {
  const lines: string[] = ['[changed-files]'];
  if (brief.files.length === 0) {
    lines.push('(the pull request reports no changed files)');
  }
  for (const file of brief.files) {
    const counts = `+${file.additions ?? '?'} -${file.deletions ?? '?'}`;
    const status = file.status ? `, ${file.status}` : '';
    const commentable = file.hasDiff ? '' : ', no line diff available';
    lines.push(`- ${file.path} (${counts}${status}${commentable})`);
  }
  if (brief.truncatedBy !== undefined) {
    lines.push(
      `[truncated: the file list is incomplete (truncatedBy=${brief.truncatedBy}); treat it as part of the change]`,
    );
  }

  return [
    brief.header,
    lines.join('\n'),
    '',
    brief.commentMetadata,
    '',
    '[task]',
    'Propose line-level review comments for this pull request. Respect the file list above as the complete set of',
    'paths you may comment on, and the diff excerpts (if any) as the complete set of lines you may anchor to.',
  ].join('\n');
}

function formatPullRequestHeader(pullRequest: AiPreReviewPullRequestHeader): string {
  const parts: string[] = ['[pull-request]'];
  parts.push(`- number: ${pullRequest.number ?? 'unknown'}`);
  parts.push(`- title: ${pullRequest.title ?? ''}`);
  parts.push(`- base branch: ${pullRequest.baseBranch ?? 'unknown'}`);
  parts.push(`- head branch: ${pullRequest.headBranch ?? 'unknown'}`);
  return parts.join('\n');
}

/**
 * Splits a raw unified diff into one block per file, keyed by the path
 * `parsePullDiff` derives for the same block, so a diff-body file can be
 * dropped by the file the brief lists.
 *
 * The split mirrors `parsePullDiff`'s own (`diff --git` starts a block) instead
 * of re-deriving paths, so the two can never disagree about which path a block
 * belongs to.
 */
export function splitDiffByFile(diffText: string): Map<string, string> {
  const blocks = new Map<string, string>();
  if (!diffText) {
    return blocks;
  }
  const lines = diffText.split(/\r?\n/);
  const current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    const block = current.join('\n');
    const path = extractBlockPath(block);
    if (path !== undefined && !blocks.has(path)) {
      blocks.set(path, block);
    }
    current.length = 0;
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ') && current.length > 0) {
      flush();
    }
    current.push(line);
  }
  flush();
  return blocks;
}

/**
 * The `+++ b/<path>` field of a diff block, unquoted only for the simple
 * `b/path` form. `parsePullDiff` owns the full C-quoting decoder; this only has
 * to agree with it on the paths it can read, and returns `undefined` for a
 * block whose heading it cannot read (that block simply has no diff body to
 * send, which fails toward sending less).
 */
function extractBlockPath(block: string): string | undefined {
  const match = /^\+\+\+ (.+)$/m.exec(block);
  if (!match) {
    return undefined;
  }
  const field = match[1].replace(/\t+$/, '');
  if (field.startsWith('"')) {
    // Quoted (non-ASCII / escaped) names are left to `parsePullDiff`'s decoder:
    // this function must not grow a second, subtly different one.
    return undefined;
  }
  const path = field.startsWith('b/') ? field.slice(2) : field;
  return path === '/dev/null' ? undefined : path;
}

/**
 * The two ways a diff body may be rendered: `full` is the whole unified diff
 * (the historical behaviour of the old diff-body switch), and
 * `changed-lines-only` keeps the added and removed lines plus the file and hunk
 * headers, dropping the unchanged context lines around them.
 *
 * The headers are not decoration: the hunk header is the only thing in the
 * prompt that says which file line a shown `+`/`-` line has, and the model has
 * to answer in those numbers for an anchor to survive validation. What is
 * dropped is only the surrounding context, which is the largest part of a
 * typical hunk.
 */
export type AiPreReviewDiffBodyMode = 'full' | 'changed-lines-only';

/** The note `changed-lines-only` puts above its (deliberately partial) diff. */
export const AI_PRE_REVIEW_CHANGED_LINES_ONLY_NOTE =
  '(only the added and removed lines are shown, each with its file and hunk headers so the line numbers stay unambiguous; the unchanged context lines around them are omitted)';

/**
 * One changed file's head text, as the `changed-files` scope sends it.
 *
 * `truncated` is set only for the single pathological case below: one file
 * larger than the whole content budget, which is cut rather than dropped so the
 * scope does not silently degrade into "no file text at all".
 */
export interface AiPreReviewFileContentSection {
  path: string;
  text: string;
  truncated?: boolean;
}

/**
 * The pre-sized `changed-files` payload: the sections themselves plus the facts
 * the brief has to state about them.
 *
 * Every cut is announced in the prompt text (`renderFileContentsSection`),
 * because a model shown part of a change must know it is part of a change — the
 * same rule the changed-file table and the diff section already follow.
 */
export interface AiPreReviewFileContents {
  sections: AiPreReviewFileContentSection[];
  /** Which limit cut the list: the file cap, or the character budget. */
  truncatedBy?: 'row-limit' | 'budget';
  /** How many of the offered files the caller had no readable head text for. */
  unavailable: number;
}

/**
 * How many changed files' head texts one prompt may carry. Smaller than
 * `PR_REVIEW_MAX_DIFF_FILES` on purpose: a diff row costs one line, and a file's
 * whole text costs its file. The cap also bounds the number of content requests
 * the run makes, so a pull request with 500 changed files cannot turn into 500
 * round trips.
 */
export const AI_PRE_REVIEW_MAX_CONTENT_FILES = 20;

/**
 * How much changed-file text one prompt may carry, in characters. The same
 * shared budget the changed-file table is pre-sized with, for the same reason:
 * it is the size of the request the feature is willing to build, and the token
 * budget in the caller (`preparePrompt`) then cuts whole files again if the
 * model itself is smaller.
 */
export const AI_PRE_REVIEW_FILE_CONTENT_BUDGET = PR_REVIEW_DIFF_BUDGET;

/**
 * Pre-sizes the `changed-files` payload to the budget above.
 *
 * Files are kept in the order the brief lists them (the server's own order), and
 * a cut drops whole files **from the end**, exactly as the diff section and the
 * token budget already do; `truncatedBy` is what lets the prompt say so. A file
 * no text was offered for is not a dropped file: it is counted in `unavailable`
 * and reported separately, because "we could not read it" and "the budget cut
 * it" are different facts and lead to different reading of the brief.
 *
 * The one exception to "drop from the end" is the first file: if a single file
 * alone exceeds the whole budget, its text is cut and the section is kept with
 * `truncated`. An empty contents section would make this scope indistinguishable
 * from `changed-lines-only` for a reason the user cannot see.
 */
export function buildAiPreReviewFileContents(input: {
  paths: readonly string[];
  texts: ReadonlyMap<string, string>;
}): AiPreReviewFileContents {
  const sections: AiPreReviewFileContentSection[] = [];
  let used = 0;
  let truncatedBy: AiPreReviewFileContents['truncatedBy'];
  let unavailable = 0;

  for (const path of input.paths) {
    if (sections.length >= AI_PRE_REVIEW_MAX_CONTENT_FILES) {
      truncatedBy = 'row-limit';
      break;
    }
    const text = input.texts.get(path);
    if (text === undefined) {
      unavailable += 1;
      continue;
    }
    const cost = contentSectionCost(path, text);
    if (used + cost > AI_PRE_REVIEW_FILE_CONTENT_BUDGET) {
      truncatedBy = 'budget';
      if (sections.length === 0) {
        const header = contentSectionHeader(path).length;
        const remaining = Math.max(0, AI_PRE_REVIEW_FILE_CONTENT_BUDGET - used - header);
        sections.push({ path, text: text.slice(0, remaining), truncated: true });
      }
      break;
    }
    used += cost;
    sections.push({ path, text });
  }

  return { sections, truncatedBy, unavailable };
}

/** The header line one file's content section starts with. */
function contentSectionHeader(path: string): string {
  return `--- ${path} ---\n`;
}

/** What one file's content section costs the character budget. */
function contentSectionCost(path: string, text: string): number {
  return contentSectionHeader(path).length + text.length + 1;
}

/**
 * The user half of the prompt: the brief, then the sections the stated scope
 * allows.
 *
 * The brief's text is rendered from `brief.files` here rather than read from
 * `brief.text`, so the caller's own file-granularity cut (§7.2) is reflected in
 * the prompt: dropping a file sets `truncatedBy`, and the truncation note then
 * tells the model the lines it does not see are missing rather than unchanged.
 * The diff and content sections are built from the same `brief.files` for the
 * same reason — a file cut from the prompt loses every section it would have
 * had, in one place.
 */
export function buildAiPreReviewUserPrompt(
  brief: AiPreReviewBrief,
  options: {
    diffText?: string;
    diffBody?: AiPreReviewDiffBodyMode;
    fileContents?: AiPreReviewFileContents;
  } = {},
): string {
  const parts = [renderAiPreReviewBriefText(brief)];
  if (options.diffText !== undefined) {
    parts.push(renderDiffSection(brief, options.diffText, options.diffBody ?? 'full'));
  }
  if (options.fileContents !== undefined) {
    parts.push(renderFileContentsSection(options.fileContents));
  }
  return parts.join('\n\n');
}

/** The `[diff]` section, whole or cut to the changed lines only. */
function renderDiffSection(brief: AiPreReviewBrief, diffText: string, mode: AiPreReviewDiffBodyMode): string {
  const blocks = splitDiffByFile(diffText);
  const sections: string[] = [];
  for (const file of brief.files) {
    const block = blocks.get(file.path);
    if (block === undefined) {
      continue;
    }
    sections.push(`--- ${file.path} ---\n${mode === 'changed-lines-only' ? keepChangedLines(block) : block}`);
  }
  const body = sections.length === 0 ? '(no diff text was available)' : sections.join('\n\n');
  const note = mode === 'changed-lines-only' ? `${AI_PRE_REVIEW_CHANGED_LINES_ONLY_NOTE}\n` : '';
  return `[diff]\n${note}${body}`;
}

/** The `[changed-file-contents]` section of the `changed-files` scope. */
function renderFileContentsSection(contents: AiPreReviewFileContents): string {
  const lines: string[] = ['[changed-file-contents]'];
  if (contents.sections.length === 0) {
    lines.push('(no changed file could be read at the pull request head version)');
  } else {
    lines.push('(the changed file(s) below are shown in full, at the pull request head version)');
    for (const section of contents.sections) {
      lines.push(contentSectionHeader(section.path).trimEnd());
      lines.push(section.text);
      if (section.truncated) {
        lines.push(`[truncated: only the beginning of ${section.path} is shown]`);
      }
    }
  }
  if (contents.unavailable > 0) {
    lines.push(`[${contents.unavailable} changed file(s) had no readable text at the head version and are not shown]`);
  }
  if (contents.truncatedBy !== undefined) {
    lines.push(
      `[truncated: the file-content list is incomplete (truncatedBy=${contents.truncatedBy}); treat what is shown as part of the change]`,
    );
  }
  return lines.join('\n');
}

/**
 * The added and removed lines of one diff block, with every line that is not a
 * changed line or a header dropped.
 *
 * A context line is the one that starts with a single space, and an empty line
 * is a context line too on servers that trim the trailing space — both go. Every
 * other line stays: `diff --git`, `index`, `---`, `+++`, the `@@` hunk headers,
 * the file-mode and rename metadata, the `+`/`-` lines themselves and the
 * `\ No newline at end of file` marker. Removing anything else would make a
 * hunk header point at lines the model cannot count.
 */
export function keepChangedLines(diffBlock: string): string {
  return diffBlock
    .split(/\r?\n/)
    .filter((line) => line !== '' && !line.startsWith(' '))
    .join('\n');
}

/**
 * Validates the model's parsed JSON against the brief (§8.2).
 *
 * Every field is checked explicitly — type, range and enum — because the model
 * output is untrusted input of the same rank as a webview message. A comment
 * that fails any check is dropped with a counted reason; the record forbids
 * every repair this function deliberately does not perform.
 *
 * The line check is the diff parser's own table (`baseLines`/`headLines`, 0-based
 * keys), which is what the interactive path asserts before it creates a comment:
 * `sideLines.get(line - 1)` must exist. The record's "within the file's actual
 * line count" is enforced from the same table rather than by fetching each
 * file's contents: a line inside a hunk is by construction inside the file, and
 * a line the table does not hold cannot be proven to be, so it is dropped
 * rather than guessed (see the record's §8.2 row "行在 diff 内", which is the
 * operative check the interactive path applies too).
 */
export function validatePreReviewComments(
  brief: AiPreReviewBrief,
  raw: unknown,
): { accepted: AiPreReviewCandidate[]; dropped: AiPreReviewDrop[] } {
  const dropped: AiPreReviewDrop[] = [];
  const accepted: AiPreReviewCandidate[] = [];
  const counts = new Map<AiPreReviewDropReason, number>();
  const recordDrop = (reason: AiPreReviewDropReason): void => {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  };

  const filesByPath = new Map(brief.files.map((file) => [file.path, file]));
  const rawComments = extractRawComments(raw);
  if (rawComments === undefined) {
    return { accepted, dropped: [{ reason: 'invalid-shape', count: 1 }] };
  }

  // §6.5: the cap is applied before validation, so the notes say how many the
  // model proposed and how many of those were never considered.
  const considered = rawComments.slice(0, AI_PRE_REVIEW_MAX_COMMENTS);
  if (rawComments.length > considered.length) {
    dropped.push({ reason: 'candidates-dropped', count: rawComments.length - considered.length });
  }

  const seenAnchors = new Set<string>();
  for (const entry of considered) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      recordDrop('invalid-shape');
      continue;
    }
    const comment = entry as Record<string, unknown>;

    const path = comment.path;
    if (typeof path !== 'string' || path.trim() === '') {
      recordDrop('missing-path');
      continue;
    }
    if (!isSafeBriefPath(path)) {
      recordDrop('unsafe-path');
      continue;
    }
    const file = filesByPath.get(path);
    if (file === undefined) {
      recordDrop('path-not-in-changed-files');
      continue;
    }

    const side = comment.side;
    if (side !== 'head' && side !== 'base') {
      recordDrop('invalid-side');
      continue;
    }

    const line = comment.line;
    // `Number.isInteger` alone accepts `-0` and huge values; the range check
    // below is the real one, and the type check must reject `"2"` and `2.5`.
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
      recordDrop('line-outside-diff');
      continue;
    }

    const extraLines = comment.extraLines;
    if (typeof extraLines !== 'number' || !Number.isInteger(extraLines) || extraLines < 0) {
      recordDrop('invalid-extra-lines');
      continue;
    }

    const body = comment.body;
    if (typeof body !== 'string' || body.trim() === '') {
      recordDrop('invalid-body');
      continue;
    }

    if (!file.hasDiff || file.diff === undefined) {
      // The brief tells the model this file has no line diff; an anchor on it
      // can never be checked, so it is dropped instead of sent unchecked.
      recordDrop('line-outside-diff');
      continue;
    }
    const sideLines = side === 'base' ? file.diff.baseLines : file.diff.headLines;
    if (!sideLines.has(line - 1)) {
      recordDrop('line-outside-diff');
      continue;
    }
    if (extraLines > 0 && !sideLines.has(line + extraLines - 1)) {
      // Deliberately not clamped to a single line: a range whose end is not in
      // the diff is a different comment from the one the model proposed.
      recordDrop('invalid-extra-lines');
      continue;
    }

    const anchor = `${path}\u0000${side}\u0000${line}\u0000${extraLines}`;
    if (seenAnchors.has(anchor)) {
      recordDrop('duplicate-anchor');
      continue;
    }
    seenAnchors.add(anchor);

    const cut = cutAiPreReviewBody(body);
    accepted.push({
      path,
      line,
      side,
      extraLines,
      body: cut.body,
      bodyTruncated: cut.truncated ? true : undefined,
    });
  }

  for (const [reason, count] of counts) {
    dropped.push({ reason, count });
  }
  return { accepted, dropped };
}

/** Which part of the contracted answer shape a JSON answer failed on (§8.1). */
export type AiPreReviewShapeField = 'root' | 'comments';

/**
 * Why one model's answer is not the contracted JSON object (§8.1). The three
 * cases are kept apart because each one means something different to the person
 * reading the failure and to whoever is diagnosing it: an **empty** answer is
 * the model saying nothing at all, a **non-JSON** answer is prose or an
 * unclosed code fence, and a **wrong shape** names the field that was missing
 * or mistyped. A single "not the contracted JSON object" line covered all three
 * and told nobody which had happened.
 */
export type AiPreReviewContractFailure =
  | { kind: 'empty' }
  | { kind: 'not-json' }
  | { kind: 'wrong-shape'; field: AiPreReviewShapeField };

/** One answer's parse: the contracted `comments` array, or why it is not one. */
export type AiPreReviewResponseParse = { kind: 'ok'; comments: unknown[] } | AiPreReviewContractFailure;

/**
 * Parses a model answer against the contract (§8.1: a shape failure fails that
 * model's attempt, it is not "zero comments").
 *
 * A JSON code fence is tolerated around the object. That is not a repair of a
 * *comment*: the record forbids repairing anchors, and the validator below is
 * unchanged — but a fenced answer is a serialization mistake a model makes
 * routinely, and treating it as an unparseable run would fail the whole feature
 * for a cosmetic reason. Prose around the JSON is still a failure.
 *
 * The `JSON.parse` error itself is deliberately **not** part of the result.
 * V8's message quotes the start of the offending input, which would smuggle
 * answer text — possibly repository code — into a log line; the caller logs the
 * bounded shape description instead.
 */
export function parseAiPreReviewResponse(text: string): AiPreReviewResponseParse {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { kind: 'empty' };
  }
  const unfenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed)?.[1] ?? trimmed;
  if (unfenced.trim() === '') {
    return { kind: 'empty' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return { kind: 'not-json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'wrong-shape', field: 'root' };
  }
  const comments = (parsed as { comments?: unknown }).comments;
  if (!Array.isArray(comments)) {
    return { kind: 'wrong-shape', field: 'comments' };
  }
  return { kind: 'ok', comments };
}

/**
 * How much of a model answer the **debug-level shape description** quotes. The
 * answer is model output that may quote the repository, and the output channel
 * is user-visible, so this diagnostic is a **bounded shape description**: how
 * long it was, whether it looks like JSON at all, and a short prefix of its
 * first line.
 *
 * This is not the whole of the answer-text policy any more. A contract
 * violation additionally carries `aiPreReviewAnswerExcerpt` in the error line
 * (always, debug or not), because the shape alone could not tell a degenerate
 * model from a truncated one; everything beyond that bounded excerpt stays in
 * the debug-only diagnostics file. Neither path ever puts the prompt, the brief
 * or the diff on the channel.
 */
export const AI_PRE_REVIEW_ANSWER_PREFIX_LENGTH = 60;

/**
 * The bounded shape of one model answer, as one log-string fragment.
 *
 * `JSON.stringify` on the prefix is what keeps a control character, a quote or
 * a newline inside the answer from breaking the log line apart — and the prefix
 * is the only part of the answer that ever leaves this function.
 */
export function describeAiPreReviewAnswerShape(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const prefix = firstLine.slice(0, AI_PRE_REVIEW_ANSWER_PREFIX_LENGTH);
  const cut = firstLine.length > prefix.length ? ', firstLineTruncated=true' : '';
  return `length=${text.length}, startsWithBrace=${text.trim().startsWith('{')}, firstLine=${JSON.stringify(prefix)}${cut}`;
}

/**
 * How much of a **failed** answer an Output-Channel line may quote.
 *
 * This is the one exception to "the answer never reaches the channel": a
 * contract violation is reported with a bounded excerpt of the answer, because
 * "the answer was not JSON" alone cannot tell a degenerate model from a
 * truncated one from a wrong prompt. 200 characters is long enough to hold the
 * whole of the handful-of-characters fragments a flaky provider returns (the
 * maintainer's real failure was `comments[]` and `{"":}`) and short enough that
 * the line stays readable; the whole answer remains in the debug-only
 * diagnostics file.
 */
export const AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH = 200;

/**
 * The excerpt of a failed answer: its first
 * `AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH` characters, or the whole answer when it
 * is shorter.
 *
 * The caller JSON-escapes it (`JSON.stringify`) onto one line, which is what
 * keeps a newline, a quote or a control character inside the answer from
 * breaking the log line apart.
 */
export function aiPreReviewAnswerExcerpt(text: string): string {
  return text.slice(0, AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH);
}

/** The `comments` array of an already parsed answer, or `undefined` if absent. */
function extractRawComments(raw: unknown): unknown[] | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const comments = (raw as { comments?: unknown }).comments;
  return Array.isArray(comments) ? comments : undefined;
}

/** The totals one run reports back to the user (§5.4). */
export function summarizePreReviewDrops(dropped: readonly AiPreReviewDrop[]): string {
  return dropped.map((entry) => `${entry.reason}=${entry.count}`).join(', ');
}
