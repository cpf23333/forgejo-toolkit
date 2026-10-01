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
 * 1. **Never send more than the user agreed to.** Without the diff-body switch
 *    the prompt carries the changed-file table and the *metadata* of existing
 *    review comments — never a comment body, never a URL or host name.
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
 * The system half of the prompt. A constant so the tests can assert what the
 * model is actually told, and so the two modes differ only in the user half.
 *
 * Every rule here is load-bearing — the validator drops, and never repairs, a
 * comment that breaks one — so the wording is kept as short as it can be while
 * still stating all of them. It is deliberately *not* moved into the user half:
 * that would not save a single token (both halves are sent on every run), and it
 * would put the contract in the part the file-granularity cut rewrites. The
 * budget that matters is checked with `countTokens` against `maxInputTokens` in
 * `src/aiPreReview.ts`, which also picks a model that can hold this text.
 */
export const AI_PRE_REVIEW_SYSTEM_PROMPT = [
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
  '- An empty comment list is a valid answer: say nothing when nothing is worth saying.',
].join('\n');

/** Character cap on one body before it is cut, matching the brief's own discipline. */
export const AI_PRE_REVIEW_MAX_BODY_LENGTH = PR_REVIEW_MAX_COMMENT_LENGTH;

/** How much of a body the confirmation list previews. */
export const AI_PRE_REVIEW_PREVIEW_LENGTH = 120;

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
 * Assembles the user half of the prompt: the brief, plus one section per
 * changed file that has a diff block when the diff body was switched on.
 *
 * The brief's text is rendered from `brief.files` here rather than read from
 * `brief.text`, so the caller's own file-granularity cut (§7.2) is reflected in
 * the prompt: dropping a file sets `truncatedBy`, and the truncation note then
 * tells the model the lines it does not see are missing rather than unchanged.
 */
export function buildAiPreReviewUserPrompt(brief: AiPreReviewBrief, options: { diffText?: string } = {}): string {
  const text = renderAiPreReviewBriefText(brief);
  if (options.diffText === undefined) {
    return text;
  }
  const blocks = splitDiffByFile(options.diffText);
  const sections: string[] = [];
  for (const file of brief.files) {
    const block = blocks.get(file.path);
    if (block === undefined) {
      continue;
    }
    sections.push(`--- ${file.path} ---\n${block}`);
  }
  const header = sections.length === 0 ? '(no diff text was available)' : sections.join('\n\n');
  return `${text}\n\n[diff]\n${header}`;
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

    const overflow = body.length - AI_PRE_REVIEW_MAX_BODY_LENGTH;
    accepted.push({
      path,
      line,
      side,
      extraLines,
      body:
        overflow > 0
          ? `${body.slice(0, AI_PRE_REVIEW_MAX_BODY_LENGTH)}\n... (truncated: ${overflow} more characters)`
          : body,
      bodyTruncated: overflow > 0 ? true : undefined,
    });
  }

  for (const [reason, count] of counts) {
    dropped.push({ reason, count });
  }
  return { accepted, dropped };
}

/**
 * The `comments` array of a strict-JSON answer, or `undefined` when the answer
 * is not the contracted object at all (§8.1: a shape failure fails the whole
 * run, it is not "zero comments").
 *
 * A JSON code fence is tolerated around the object. That is not a repair of a
 * *comment*: the record forbids repairing anchors, and the parser below is
 * unchanged — but a fenced answer is a serialization mistake a model makes
 * routinely, and treating it as an unparseable run would fail the whole feature
 * for a cosmetic reason. Prose around the JSON is still a failure.
 */
export function parseAiPreReviewResponse(text: string): { comments: unknown[] } | undefined {
  const trimmed = text.trim();
  const unfenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed)?.[1] ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return undefined;
  }
  const comments = extractRawComments(parsed);
  return comments === undefined ? undefined : { comments };
}

/** The `comments` array of an already parsed answer, or `undefined` if absent. */
function extractRawComments(raw: unknown): unknown[] | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const comments = (raw as { comments?: unknown }).comments;
  return Array.isArray(comments) ? comments : undefined;
}

/** The confirmation line for one candidate: `path:line` beside the side, preview. */
export function formatCandidateLabel(candidate: AiPreReviewCandidate): string {
  const firstLine = candidate.line;
  const range = candidate.extraLines > 0 ? `${firstLine}-${firstLine + candidate.extraLines}` : String(firstLine);
  const side = candidate.side === 'base' ? 'base' : 'head';
  const preview = candidate.body.replace(/\s+/g, ' ').trim().slice(0, AI_PRE_REVIEW_PREVIEW_LENGTH);
  return `${candidate.path}:${range} (${side}) — ${preview}`;
}

/** The totals one run reports back to the user (§5.4). */
export function summarizePreReviewDrops(dropped: readonly AiPreReviewDrop[]): string {
  return dropped.map((entry) => `${entry.reason}=${entry.count}`).join(', ');
}
