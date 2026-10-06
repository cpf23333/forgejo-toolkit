import {
  type AiPreReviewPromptMessage,
  aiPreReviewPromptText,
  buildAiPreReviewPromptMessages,
} from './aiPreReviewBrief';
import {
  PR_REVIEW_COMMENT_BUDGET,
  PR_REVIEW_DIFF_BUDGET,
  PR_REVIEW_MAX_COMMENT_LENGTH,
  PR_REVIEW_MAX_COMMENTS,
  PR_REVIEW_MAX_DIFF_FILES,
} from '../mcp/tools';
import {
  ISSUE_TRIAGE_DROP_REASONS,
  type IssueTriageDropCount,
  type IssueTriageDropReasonValue,
  type IssueTriageLabelSuggestion,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/**
 * The pure half of "suggest labels for an issue": what is sent to the model provider,
 * how that material is pre-sized, and how the answer becomes a list of suggestions the
 * user can act on.
 *
 * Nothing here touches `vscode`, for the reason `src/aiPreReviewBrief.ts` gives about
 * its own half: the assembly and the validator are the two pieces that decide what
 * leaves the machine and what reaches the user, and they are the two that must be
 * exhaustively testable with malformed input.
 *
 * **Labels only, and that is a narrowed decision** (`docs/design/issue-triage.md` §2):
 * an earlier version also suggested assignees, from the repository's list of assignable
 * logins. The only usable signal a model has about *who* should own an issue is who
 * happened to speak in the comments, and that is not a good enough basis for telling a
 * reader who should be assigned — so the login list is no longer read, sent or
 * promised, and nothing here can suggest a user.
 *
 * Three rules are encoded here and must not be relaxed
 * (`docs/design/issue-triage.md` §5):
 *
 * 1. **The candidate set is the repository's own.** The label list is read from the
 *    repository and is the *only* set of names a suggestion may resolve to.
 * 2. **A suggestion is never repaired.** A name that does not resolve is dropped and
 *    counted — no case folding, no prefix matching, no "closest label" — because an
 *    applied label is a public write to the issue.
 * 3. **Every cut is announced in the prompt.** A model shown part of a discussion has
 *    to know it is part of one, or it will triage as if nothing else was said.
 */

/**
 * The most of one issue's body one prompt may carry.
 *
 * The pre-review's prose budget, reused rather than reinvented: it is the size of
 * block of prose this extension is willing to put in one request, and two features
 * must not disagree about it. The body is an issue's own text, so it is prose in
 * exactly that sense.
 */
export const ISSUE_TRIAGE_ISSUE_BODY_BUDGET = PR_REVIEW_COMMENT_BUDGET;

/** The row cap and character budget of the label table. */
export const ISSUE_TRIAGE_MAX_TABLE_ROWS = PR_REVIEW_MAX_DIFF_FILES;
export const ISSUE_TRIAGE_TABLE_BUDGET = PR_REVIEW_DIFF_BUDGET;

/** How many discussion comments one prompt may carry, and how much room they get. */
export const ISSUE_TRIAGE_MAX_COMMENTS = PR_REVIEW_MAX_COMMENTS;
export const ISSUE_TRIAGE_COMMENT_BUDGET = PR_REVIEW_COMMENT_BUDGET;

/** How much of one comment's body is kept. */
export const ISSUE_TRIAGE_MAX_COMMENT_CHARACTERS = PR_REVIEW_MAX_COMMENT_LENGTH;

/** How much of the issue's title is kept. A title is meant to be one line. */
export const ISSUE_TRIAGE_MAX_TITLE_CHARACTERS = 300;

/**
 * The most labels the instruction block asks for.
 *
 * A cap rather than "as many as apply": a repository can declare hundreds of labels,
 * and a model asked to be exhaustive will answer with a list nobody reads. The cap is
 * stated in the prompt **and** applied to the answer before validation, so the ones
 * past it are counted as `over-limit` rather than silently ignored.
 */
export const ISSUE_TRIAGE_MAX_LABEL_SUGGESTIONS = 5;

/** One label the repository declares, as the brief may carry it. */
export interface IssueTriageCandidateLabel {
  id: number;
  name: string;
  description?: string;
  color?: string;
}

/** One label as the API reports it, before the brief's own shaping. */
export interface IssueTriageRawLabel {
  id?: number;
  name?: string;
  description?: string;
  color?: string;
  is_archived?: boolean;
}

/**
 * The labels a run may offer as candidates, with the two exclusions counted.
 *
 * Archived labels are excluded because the server keeps them for the issues that
 * already carry them while no longer offering them for new ones — suggesting one would
 * name an operation the user cannot complete. Entries without an id or a name are
 * excluded because nothing could be applied from them. Both counts are returned rather
 * than only logged here: the run logs them, and the **availability** question ("does
 * this repository have anything to suggest at all?") has to answer with the same rule,
 * which is why this is one function and not two
 * (`docs/design/issue-triage.md` §3.2).
 */
export function suggestableLabels(labels: readonly IssueTriageRawLabel[]): {
  labels: IssueTriageCandidateLabel[];
  archived: number;
  unidentifiable: number;
} {
  const candidates: IssueTriageCandidateLabel[] = [];
  let archived = 0;
  let unidentifiable = 0;
  for (const label of labels) {
    if (label.is_archived === true) {
      archived += 1;
      continue;
    }
    if (label.id === undefined || typeof label.name !== 'string' || label.name.trim() === '') {
      unidentifiable += 1;
      continue;
    }
    candidates.push({
      id: label.id,
      name: label.name,
      ...(label.description === undefined || label.description.trim() === '' ? {} : { description: label.description }),
      ...(label.color === undefined ? {} : { color: label.color }),
    });
  }
  return { labels: candidates, archived, unidentifiable };
}

/** One discussion comment as the brief may carry it. */
export interface IssueTriageComment {
  /** The author's login or display name, when the server reported one. */
  author?: string;
  /** The date the server reported, as it reported it. */
  date?: string;
  body: string;
}

/** What one run knows before the prompt is assembled. */
export interface IssueTriageBriefInput {
  /** The repository, as `owner/repo`, for the prompt's own header. */
  repository: string;
  issueNumber: number;
  title: string;
  body: string;
  /**
   * Every label the run could read, **archived ones already excluded** — the only
   * names a suggestion may resolve to.
   */
  labels: readonly IssueTriageCandidateLabel[];
  /** The discussion, oldest first; present only under `issue-and-comments`. */
  comments?: readonly IssueTriageComment[];
}

/**
 * Which bound cut the material. One value per place a cut can happen, so the run can
 * log a fact and the panel can say which part of the prompt was incomplete.
 */
export type IssueTriageTruncation = 'issue-body' | 'label-limit' | 'label-budget' | 'comment-limit' | 'comment-budget';

/**
 * The assembled prompt's user half plus the facts the run reports about it.
 *
 * The candidate list travels **in full** next to the rendered text on purpose: the
 * rendered prompt may have been cut to its budgets, while validation resolves a
 * suggestion against everything the run actually read — the record's requirement is
 * "a label read in that run", not "one that happened to fit".
 */
export interface IssueTriageBrief {
  /** The user half of the request. */
  text: string;
  /** The labels a suggestion may resolve to. */
  labelCandidates: readonly IssueTriageCandidateLabel[];
  /** How many labels the repository declares, before the cap. */
  labelsTotal: number;
  /** How many of them the prompt lists. */
  labelsShown: number;
  /** How many comments the run read, before the cap. */
  commentsTotal: number;
  /** How many of them the prompt carries. */
  commentsShown: number;
  /** Which bound cut, when one did. */
  truncatedBy?: IssueTriageTruncation;
}

/** One section's text plus what it had to cut. */
interface RenderedSection {
  text: string;
  shown: number;
  cutBy?: 'limit' | 'budget';
}

/**
 * The one instruction block this feature sends.
 *
 * A **JSON** contract, unlike the description feature's prose one: the answer is a
 * list of names to resolve against the repository's own label list, so a shape is what
 * makes "a suggestion" checkable. Everything it states is something the validator or
 * the user would otherwise have to discover: the exact key, the candidate set, the cap,
 * and that an unresolvable name is discarded (so nobody pads the answer).
 */
export function buildIssueTriageSystemPrompt(): string {
  return [
    'You triage one issue: pick the repository labels that apply to it.',
    '',
    'Answer with one JSON object and nothing else:',
    '{"labels": ["<a label name from [labels]>", ...]}',
    '',
    'Rules:',
    '- Use only label names listed under [labels]. Any other name is discarded before anyone sees it.',
    `- At most ${ISSUE_TRIAGE_MAX_LABEL_SUGGESTIONS} labels. Prefer the few that clearly apply; do not list everything that might.`,
    "- Suggest a label only when this issue's own content calls for it.",
    '- Never invent a label name, and never explain the answer outside the JSON.',
    '- If nothing clearly applies, answer {"labels": []}.',
  ].join('\n');
}

/** The English instruction block, kept as a constant for the tests that pin its wording. */
export const ISSUE_TRIAGE_SYSTEM_PROMPT = buildIssueTriageSystemPrompt();

/** The issue's title, cut to {@link ISSUE_TRIAGE_MAX_TITLE_CHARACTERS} with the cut announced. */
function titleLine(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= ISSUE_TRIAGE_MAX_TITLE_CHARACTERS) {
    return `title: ${trimmed}`;
  }
  return `title: ${trimmed.slice(0, ISSUE_TRIAGE_MAX_TITLE_CHARACTERS)}… [truncated]`;
}

/**
 * The `[issue]` section: the issue's identity and its own text.
 *
 * The body is cut from the end with the cut stated in the text: a model that reads
 * half an issue and believes it read all of it triages the half.
 */
function renderIssueSection(input: IssueTriageBriefInput): { text: string; bodyCut: boolean } {
  const body = input.body.trim();
  const lines = ['[issue]', `repository: ${input.repository}`, `issue: #${input.issueNumber}`, titleLine(input.title)];
  if (body === '') {
    lines.push('body: (this issue has no body)');
    return { text: lines.join('\n'), bodyCut: false };
  }
  if (body.length > ISSUE_TRIAGE_ISSUE_BODY_BUDGET) {
    lines.push(
      `body:\n${body.slice(0, ISSUE_TRIAGE_ISSUE_BODY_BUDGET)}\n[truncated: only the beginning of the issue body is shown]`,
    );
    return { text: lines.join('\n'), bodyCut: true };
  }
  lines.push(`body:\n${body}`);
  return { text: lines.join('\n'), bodyCut: false };
}

/**
 * The `[labels]` section: the repository's own label list, name and description.
 *
 * The list is the **candidate set**. The run never assembles a prompt for a repository
 * that declares none — it refuses before this is called and the page hides the action
 * (`docs/design/issue-triage.md` §3.2) — but the section still renders that case
 * truthfully, because a brief built by hand (in a test, or by a future caller) must not
 * produce a prompt with a silently blank candidate list.
 */
function renderLabelsSection(labels: readonly IssueTriageCandidateLabel[]): RenderedSection {
  const lines = ['[labels]'];
  if (labels.length === 0) {
    lines.push('(this repository declares no label, so no label can be suggested; answer with an empty "labels" list)');
    return { text: lines.join('\n'), shown: 0 };
  }
  lines.push('(every label this repository declares; a suggestion must name one of these)');
  let used = 0;
  let shown = 0;
  let cutBy: RenderedSection['cutBy'];
  for (const [index, label] of labels.entries()) {
    if (index >= ISSUE_TRIAGE_MAX_TABLE_ROWS) {
      cutBy = 'limit';
      break;
    }
    const description = (label.description ?? '').trim();
    const row = description === '' ? `- ${label.name}` : `- ${label.name} — ${description}`;
    if (used + row.length + 1 > ISSUE_TRIAGE_TABLE_BUDGET) {
      cutBy = 'budget';
      break;
    }
    lines.push(row);
    used += row.length + 1;
    shown += 1;
  }
  if (shown < labels.length) {
    lines.push(`[truncated: only ${shown} of ${labels.length} label(s) are listed]`);
  }
  return { text: lines.join('\n'), shown, ...(cutBy === undefined ? {} : { cutBy }) };
}

/** The comment's own line: its author and date, then its body, indented. */
function commentLines(comment: IssueTriageComment): string[] {
  const facts = [comment.author === undefined ? undefined : `@${comment.author}`, comment.date].filter(
    (value): value is string => value !== undefined && value !== '',
  );
  const body = comment.body.trim();
  const kept =
    body.length <= ISSUE_TRIAGE_MAX_COMMENT_CHARACTERS
      ? body
      : `${body.slice(0, ISSUE_TRIAGE_MAX_COMMENT_CHARACTERS)}\n[truncated: this comment is shown only in part]`;
  const head = facts.length === 0 ? '- (unknown author)' : `- ${facts.join(' · ')}`;
  return [head, ...kept.split('\n').map((line) => `  ${line}`.trimEnd())];
}

/**
 * The `[discussion]` section of the `issue-and-comments` scope: the comments, oldest
 * first as the server lists them, cut from the end.
 */
function renderDiscussionSection(comments: readonly IssueTriageComment[]): RenderedSection {
  const lines = ['[discussion]'];
  if (comments.length === 0) {
    lines.push('(nobody has commented on this issue)');
    return { text: lines.join('\n'), shown: 0 };
  }
  lines.push('(the comments on this issue, oldest first as the server lists them)');
  let used = 0;
  let shown = 0;
  let cutBy: RenderedSection['cutBy'];
  for (const [index, comment] of comments.entries()) {
    if (index >= ISSUE_TRIAGE_MAX_COMMENTS) {
      cutBy = 'limit';
      break;
    }
    const block = commentLines(comment).join('\n');
    if (used + block.length + 1 > ISSUE_TRIAGE_COMMENT_BUDGET) {
      cutBy = 'budget';
      break;
    }
    lines.push(block);
    used += block.length + 1;
    shown += 1;
  }
  if (shown < comments.length) {
    lines.push(`[truncated: only ${shown} of ${comments.length} comment(s) are shown]`);
  }
  return { text: lines.join('\n'), shown, ...(cutBy === undefined ? {} : { cutBy }) };
}

/**
 * Assembles the user half of one request: the issue, the repository's label list, and —
 * only when the caller was given them — the discussion.
 *
 * The discussion is a parameter rather than a flag: under `issue-only` the caller has no
 * comments to hand over, so "the prompt cannot mention a comment" is true by
 * construction rather than by a branch here.
 */
export function buildIssueTriageBrief(input: IssueTriageBriefInput): IssueTriageBrief {
  const comments = input.comments ?? [];
  const issue = renderIssueSection(input);
  const labels = renderLabelsSection(input.labels);
  const discussion = renderDiscussionSection(comments);

  let truncatedBy: IssueTriageBrief['truncatedBy'];
  if (issue.bodyCut) {
    truncatedBy = 'issue-body';
  }
  if (labels.cutBy !== undefined) {
    truncatedBy = truncatedBy ?? `label-${labels.cutBy}`;
  }
  if (input.comments !== undefined && discussion.cutBy !== undefined) {
    truncatedBy = truncatedBy ?? `comment-${discussion.cutBy}`;
  }

  const sections = [issue.text, labels.text];
  if (input.comments !== undefined) {
    sections.push(discussion.text);
  }

  return {
    text: sections.join('\n\n'),
    labelCandidates: input.labels,
    labelsTotal: input.labels.length,
    labelsShown: labels.shown,
    commentsTotal: comments.length,
    commentsShown: input.comments === undefined ? 0 : discussion.shown,
    ...(truncatedBy === undefined ? {} : { truncatedBy }),
  };
}

/**
 * The whole text one request sends: the instruction block, a blank line, then the
 * brief.
 *
 * It reuses `aiPreReviewPromptText`'s joining rule so "what we counted" and "what we
 * sent" cannot drift, and the three features cannot disagree about the shape of a
 * request.
 */
export function buildIssueTriagePromptText(systemPrompt: string, briefText: string): string {
  return aiPreReviewPromptText(systemPrompt, briefText);
}

/**
 * The messages one request sends: **exactly one** `User` message, through the
 * pre-review's builder, for the reasons that builder documents (no system role in
 * `@types/vscode` 1.102, and one message rather than two).
 */
export function buildIssueTriagePromptMessages(systemPrompt: string, userPrompt: string): AiPreReviewPromptMessage[] {
  return buildAiPreReviewPromptMessages(systemPrompt, userPrompt);
}

/** Why an answer is not the contracted JSON object. */
export type IssueTriageContractFailure =
  | { kind: 'empty' }
  | { kind: 'not-json' }
  | { kind: 'wrong-shape'; field: 'root' | 'labels' };

/** One answer's parse: the label array as the model wrote it, or why not. */
export type IssueTriageAnswerParse = { kind: 'ok'; labels: unknown[] } | IssueTriageContractFailure;

/**
 * Parses a model answer against the contract.
 *
 * The tolerance is the pre-review's, deliberately and by name: a JSON code fence
 * around the object is unwrapped (a serialization mistake a model makes routinely, and
 * refusing the whole run over it would fail the feature for a cosmetic reason), while
 * prose around the JSON is a failure. The `JSON.parse` error itself is deliberately not
 * part of the result — V8's message quotes the beginning of the offending input, which
 * would smuggle issue text into a log line.
 *
 * The one key is required: the instruction block states it, and "no label applies" is
 * spelled `[]` rather than by omitting the key, so a missing key is a shape failure the
 * reader can act on instead of a maybe-empty suggestion.
 */
export function parseIssueTriageAnswer(text: string): IssueTriageAnswerParse {
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
  const record = parsed as { labels?: unknown };
  if (!Array.isArray(record.labels)) {
    return { kind: 'wrong-shape', field: 'labels' };
  }
  return { kind: 'ok', labels: record.labels };
}

/** What one answer became after validation. */
export interface IssueTriageAccepted {
  labels: IssueTriageLabelSuggestion[];
  /** Every refusal, counted by reason; empty when nothing was refused. */
  dropped: IssueTriageDropCount[];
}

/**
 * Validates one parsed answer against the candidate set the run read (§5).
 *
 * The whole of the "never match fuzzily" rule lives here: a name resolves only by
 * **exact** equality with a label the run read (after trimming surrounding whitespace,
 * which is not matching — it is the difference between `"bug"` and `"bug "`).
 * Everything else is dropped with a counted reason.
 *
 * The cap is applied **before** validation, so entries past it are counted as
 * `over-limit` rather than being reported as unresolvable: they were never considered,
 * which is a different fact about the run.
 *
 * Duplicates are collapsed without a count: naming the same label twice is the same
 * suggestion, not a refusal.
 */
export function validateIssueTriageAnswer(
  brief: IssueTriageBrief,
  answer: IssueTriageAnswerParse,
): IssueTriageAccepted {
  const dropped: IssueTriageDropCount[] = [];
  const counts = new Map<IssueTriageDropReasonValue, number>();
  const recordDrop = (reason: IssueTriageDropReasonValue): void => {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  };

  if (answer.kind !== 'ok') {
    // A contract failure is the caller's to report; it produces no suggestions at all
    // rather than an empty accepted list that would read as "nothing applies".
    return { labels: [], dropped: [] };
  }

  const labelsByName = new Map<string, IssueTriageCandidateLabel>(
    brief.labelCandidates.map((label) => [label.name, label]),
  );

  const labels: IssueTriageLabelSuggestion[] = [];
  const seenLabels = new Set<string>();
  const rawLabels = answer.labels.slice(0, ISSUE_TRIAGE_MAX_LABEL_SUGGESTIONS);
  for (let index = rawLabels.length; index < answer.labels.length; index += 1) {
    recordDrop('over-limit');
  }
  for (const entry of rawLabels) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      recordDrop('invalid-shape');
      continue;
    }
    const name = entry.trim();
    const label = labelsByName.get(name);
    if (label === undefined) {
      recordDrop('label-not-in-repository');
      continue;
    }
    if (seenLabels.has(name)) {
      continue;
    }
    seenLabels.add(name);
    labels.push({ id: label.id, name: label.name, ...(label.color === undefined ? {} : { color: label.color }) });
  }

  // The declared order is the order the panel shows, so the reasons are sorted by it
  // rather than by the accidental order the answer happened to produce them in.
  for (const reason of ISSUE_TRIAGE_DROP_REASONS) {
    const count = counts.get(reason);
    if (count !== undefined) {
      dropped.push({ reason, count });
    }
  }
  return { labels, dropped };
}
