import { PR_REVIEW_MAX_COMMENT_LENGTH } from '@cpf23333-forgejo-toolkit/shared/limits';

/**
 * The pure half of the notification summary: what one run may send about a discussion,
 * how that material is pre-sized, and how every cut is declared.
 *
 * Nothing here touches `vscode`, for the reason `src/issueTriageBrief.ts` and
 * `src/aiPreReviewBrief.ts` give about their own halves: the assembly is the piece that
 * decides what leaves the machine, and it has to be exhaustively testable — including the
 * property the design record makes a criterion: **the same timeline renders a
 * byte-identical prompt** (`docs/design/notification-summary.md` §3.3, §9). No clock, no
 * randomness, no locale-dependent formatting, no hidden state.
 *
 * The design's decision is "head and tail, not head only": a discussion's opening says
 * what the argument is and its end says where it landed, so keeping only the start would
 * lose every conclusion and keeping only the end would lose the question (§3.1). Both
 * rejected alternatives and their costs are recorded in §3.2.
 *
 * Four rules are encoded here and must not be relaxed:
 *
 * 1. **The first body is pinned, and does not compete for the entry budget.** The design
 *    rejects letting a long first post starve the discussion (§3.2), so the description is
 *    bounded by the per-entry cap alone and the entries get the whole timeline budget.
 * 2. **Events are one line of metadata.** A label, an assignment, a state change, a review
 *    verdict or a merge is a fact about the discussion, not prose in it (§3.3), so an
 *    event renders as a single line this module builds from the row's own fields. No URL
 *    field is ever sent — not the notification's, not a row's (§5).
 * 3. **The quoted block is removed, and nothing is deduplicated by text.** The platform's
 *    reply attribution is leading `> ` lines; only that leading block goes, and no
 *    comparison of bodies is done, because a quote can cite something outside the window
 *    and a fuzzy match would delete real content (§3.3).
 * 4. **Every cut is stated in the prompt.** A per-entry cut, the entries skipped between
 *    head and tail, a removed quoted block and a head/tail remainder transfer all appear
 *    in words inside the material (§3.3), because a model shown part of a discussion has
 *    to know it is part of one.
 */

/**
 * The characters the **entries** of one discussion may take (the first body is pinned
 * outside it, see rule 1).
 *
 * A constant of this feature rather than a reuse of `PR_REVIEW_COMMENT_BUDGET`: that one
 * sizes "the comments of one review brief", a different material, and the split into a
 * head half and a tail half has to be a decision this feature states rather than one an
 * older constant makes implicitly (§3.3). 16 KiB is two halves of 8 KiB — roughly eight
 * full-length comments per side, or a few dozen short ones, which is what "a discussion"
 * means at the sizes the rejected strategies were weighed against.
 */
export const NOTIFICATION_SUMMARY_TIMELINE_BUDGET = 16 * 1024;

/**
 * How much of one entry is kept. The pre-review's prose cap, reused for the reason
 * `src/issueTriageBrief.ts` gives for its own reuse: it is the size of prose block this
 * extension is willing to put in one request, one entry of a discussion is prose in
 * exactly that sense, and two features must not answer the same question differently.
 */
export const NOTIFICATION_SUMMARY_MAX_ENTRY_LENGTH = PR_REVIEW_MAX_COMMENT_LENGTH;

/** How much of the discussion's title is kept. A title is meant to be one line. */
export const NOTIFICATION_SUMMARY_MAX_TITLE_CHARACTERS = 300;

/** One value of `forgejoToolkit.notificationSummaryPromptScope` that states an answer. */
export type NotificationSummaryScope = 'body-only' | 'body-and-comments' | 'body-comments-and-events';

/** What one timeline row is, once classified. */
export type NotificationSummaryEntryKind = 'comment' | 'event';

/** One row of a discussion, as this module carries it into the prompt. */
export interface NotificationSummaryEntry {
  kind: NotificationSummaryEntryKind;
  author?: string;
  createdAt?: string;
  text: string;
}

/**
 * A raw timeline row, as much of it as this module reads.
 *
 * Structural rather than the generated `TimelineComment` so the tests can pass plain
 * literals and so a field the API adds cannot enter the prompt by accident: everything
 * this module may send is named here.
 */
export interface NotificationSummaryEntryLike {
  body?: unknown;
  created_at?: unknown;
  user?: { login?: unknown } | undefined;
  label?: { name?: unknown } | undefined;
  milestone?: { title?: unknown } | undefined;
  assignee?: { login?: unknown } | undefined;
  state?: unknown;
  old_title?: unknown;
  new_title?: unknown;
  new_ref?: unknown;
  ref?: unknown;
}

/** The non-prose facts of the entity a summary is about. */
export interface NotificationSummarySkeleton {
  owner: string;
  repo: string;
  /** The notification's subject type: `issue` or `pull`. */
  type: string;
  index: number;
  title: string;
  state?: string;
  updatedAt?: string;
}

/** What one run may send about one discussion. */
export interface NotificationSummaryMaterial {
  /** The material itself: the skeleton, the first body, the entries and every cut. */
  text: string;
  /**
   * Whether anything was cut, skipped or removed. This is the third fact the panel header
   * must show (§4), derived here rather than recounted by the caller so the header and the
   * body cannot disagree about it. A remainder transfer is not a cut: nothing was left out
   * because of it.
   */
  truncated: boolean;
  /** One sentence per cut/skip/removal; each of them already appears inside `text`. */
  notes: readonly string[];
  /** How many timeline entries the material includes. */
  includedEntries: number;
  /** How many entries fell between the head and the tail. */
  skippedEntries: number;
}

/** One entry as it will be rendered, with the cost it is charged. */
interface RenderedEntry {
  line: string;
  cost: number;
}

/**
 * Strips the leading `> ` quote block of a comment body, and reports whether it did.
 *
 * The platform renders a reply's quoted attribution as leading `> ` lines; they are a copy
 * of text that is usually already in the material, so they cost budget and add nothing.
 * Only the **leading** block is removed — a `> ` passage in the middle of a comment is the
 * author's own formatting, and a blank line that follows the block belongs to the block.
 */
function stripLeadingQuoteBlock(body: string): { text: string; removed: boolean } {
  const lines = body.split('\n');
  let index = 0;
  while (index < lines.length && /^> ?/.test(lines[index])) {
    index += 1;
  }
  if (index === 0) {
    return { text: body, removed: false };
  }
  if (index < lines.length && lines[index].trim() === '') {
    index += 1;
  }
  return { text: lines.slice(index).join('\n'), removed: true };
}

/** One event row's single line of metadata, built from the fields this module reads. */
function describeEvent(row: NotificationSummaryEntryLike): string {
  const labelName = typeof row.label?.name === 'string' ? row.label.name : undefined;
  if (labelName !== undefined && labelName.trim() !== '') {
    return `added the label "${labelName}"`;
  }
  const milestone = typeof row.milestone?.title === 'string' ? row.milestone.title : undefined;
  if (milestone !== undefined && milestone.trim() !== '') {
    return `set the milestone "${milestone}"`;
  }
  const assignee = typeof row.assignee?.login === 'string' ? row.assignee.login : undefined;
  if (assignee !== undefined && assignee.trim() !== '') {
    return `assigned ${assignee}`;
  }
  const state = typeof row.state === 'string' ? row.state : undefined;
  if (state === 'closed') {
    return 'closed it';
  }
  if (state === 'open' || state === 'reopened') {
    return 'reopened it';
  }
  const title = typeof row.new_title === 'string' ? row.new_title : undefined;
  if (title !== undefined && title.trim() !== '') {
    return `retitled it to "${title}"`;
  }
  const ref = typeof row.new_ref === 'string' ? row.new_ref : typeof row.ref === 'string' ? row.ref : undefined;
  if (ref !== undefined && ref.trim() !== '') {
    return `referenced ${ref}`;
  }
  // An event nobody can describe is still one line: the raw row is never dumped, and no
  // URL field is read.
  return 'an event';
}

/**
 * Classifies raw timeline rows, in the order they arrived.
 *
 * A row with a non-empty `body` is a comment; every other row is an event. Review comments
 * are not a third kind: the platform reports them in the same timeline and the design
 * treats them the same (§3.3), so they take the same path as any other comment. A comment
 * keeps its **raw** body here — the quote block is stripped when it is rendered, which is
 * where the cut is declared.
 */
export function normalizeNotificationTimeline(
  rows: readonly NotificationSummaryEntryLike[],
): NotificationSummaryEntry[] {
  return rows.map((row) => {
    const body = typeof row.body === 'string' ? row.body : '';
    const author = typeof row.user?.login === 'string' ? row.user.login : undefined;
    const createdAt = typeof row.created_at === 'string' ? row.created_at : undefined;
    const attribution = {
      ...(author === undefined ? {} : { author }),
      ...(createdAt === undefined ? {} : { createdAt }),
    };
    if (body.trim() === '') {
      return { kind: 'event', ...attribution, text: describeEvent(row) };
    }
    return { kind: 'comment', ...attribution, text: body };
  });
}

/** The state of one material as it is assembled, so the notes and the flag stay in step. */
interface Assembly {
  notes: string[];
  /** Whether anything was cut, skipped or removed (a transfer is none of those). */
  cut: boolean;
}

/** Cuts one entry's text to the per-entry cap, declaring the cut. */
function cutToLimit(text: string, what: string, assembly: Assembly): string {
  if (text.length <= NOTIFICATION_SUMMARY_MAX_ENTRY_LENGTH) {
    return text;
  }
  assembly.cut = true;
  assembly.notes.push(
    `${what} is longer than ${NOTIFICATION_SUMMARY_MAX_ENTRY_LENGTH} characters; only the first ${NOTIFICATION_SUMMARY_MAX_ENTRY_LENGTH} are included.`,
  );
  return text.slice(0, NOTIFICATION_SUMMARY_MAX_ENTRY_LENGTH);
}

/** The line one entry renders as: `[time author] text`, after the quote rule and the cap. */
function renderEntry(entry: NotificationSummaryEntry, assembly: Assembly): RenderedEntry {
  const what = entry.kind === 'comment' ? 'Comment' : 'Event';
  const who = `${what} by ${entry.author ?? 'an unknown author'}`;
  let text = entry.text;
  if (entry.kind === 'comment') {
    const stripped = stripLeadingQuoteBlock(text);
    text = stripped.text;
    if (stripped.removed) {
      assembly.cut = true;
      assembly.notes.push(
        `The quoted block at the start of a comment by ${entry.author ?? 'an unknown author'} was removed.`,
      );
    }
  }
  const cut = cutToLimit(text, who, assembly);
  const attribution = [entry.createdAt, entry.author].filter((part) => part !== undefined && part !== '').join(' ');
  const prefix = attribution === '' ? '' : `[${attribution}] `;
  return { line: `${prefix}${cut}`, cost: prefix.length + cut.length + 1 };
}

/**
 * Takes entries that fit in `budget`, scanning from the front or the back.
 *
 * An entry that does not fit is skipped rather than stopping the scan, so a single
 * over-cap entry cannot end a half while cheaper ones behind it would still fit.
 */
function takeWithinBudget(
  entries: readonly RenderedEntry[],
  budget: number,
  fromEnd: boolean,
  excluded: ReadonlySet<number>,
): { indices: Set<number>; used: number } {
  const indices = new Set<number>();
  let used = 0;
  const order = entries.map((_, index) => index);
  if (fromEnd) {
    order.reverse();
  }
  for (const index of order) {
    if (excluded.has(index)) {
      continue;
    }
    if (used + entries[index].cost > budget) {
      continue;
    }
    indices.add(index);
    used += entries[index].cost;
  }
  return { indices, used };
}

/**
 * The material one run may send about one discussion.
 *
 * The layout is fixed and the order is the input's own (ascending): the skeleton, the first
 * body, the head entries, one line saying how many entries the gap holds, the tail entries,
 * and then every note. Each sentence in `notes` also appears in `text`; nothing is
 * announced only to the caller.
 */
export function buildNotificationSummaryMaterial(input: {
  scope: NotificationSummaryScope;
  skeleton: NotificationSummarySkeleton;
  firstBody?: string;
  entries: readonly NotificationSummaryEntry[];
}): NotificationSummaryMaterial {
  const assembly: Assembly = { notes: [], cut: false };

  const header = [
    `Repository: ${input.skeleton.owner}/${input.skeleton.repo}`,
    `Kind: ${input.skeleton.type} #${input.skeleton.index}`,
    `Title: ${cutToLimit(input.skeleton.title, 'The title', assembly)}`,
    ...(input.skeleton.state === undefined ? [] : [`State: ${input.skeleton.state}`]),
    ...(input.skeleton.updatedAt === undefined ? [] : [`Updated: ${input.skeleton.updatedAt}`]),
  ];

  const firstBody = input.firstBody ?? '';
  const bodySection =
    firstBody.trim() === '' ? [] : ['', 'Description:', cutToLimit(firstBody, 'The description', assembly)];

  const allowed = input.entries.filter((entry) =>
    entry.kind === 'comment'
      ? input.scope === 'body-and-comments' || input.scope === 'body-comments-and-events'
      : input.scope === 'body-comments-and-events',
  );
  const rendered = allowed.map((entry) => renderEntry(entry, assembly));

  const half = Math.floor(NOTIFICATION_SUMMARY_TIMELINE_BUDGET / 2);
  const head = takeWithinBudget(rendered, half, false, new Set());
  const tail = takeWithinBudget(rendered, half, true, head.indices);

  // Neither half can see past its own 8 KiB, so an entry can be left out that the budget as a
  // whole could still hold — a long entry the head could not fit and the tail could not
  // either, while characters of the whole budget went unused. That leftover is given to one
  // side, which then reaches further into the middle with it, and the transfer is written
  // into the prompt: otherwise the same timeline would tell a different story at different
  // lengths (§3.3). A transfer is not an omission, so it does not set `truncated`.
  let transferred: string | undefined;
  const excluded = new Set([...head.indices, ...tail.indices]);
  const free = NOTIFICATION_SUMMARY_TIMELINE_BUDGET - head.used - tail.used;
  if (free > 0 && excluded.size < rendered.length) {
    const toTail = takeWithinBudget(rendered, free, true, excluded);
    if (toTail.indices.size > 0) {
      [...toTail.indices].forEach((index) => tail.indices.add(index));
      transferred = `The end of this discussion was given the ${toTail.used} characters the rest of the budget had left, and used them for ${toTail.indices.size} more ${toTail.indices.size === 1 ? 'entry' : 'entries'} just before it.`;
    } else {
      const toHead = takeWithinBudget(rendered, free, false, excluded);
      if (toHead.indices.size > 0) {
        [...toHead.indices].forEach((index) => head.indices.add(index));
        transferred = `The start of this discussion was given the ${toHead.used} characters the rest of the budget had left, and used them for ${toHead.indices.size} more ${toHead.indices.size === 1 ? 'entry' : 'entries'} just after it.`;
      }
    }
  }
  if (transferred !== undefined) {
    assembly.notes.push(transferred);
  }

  const included = rendered.filter((_, index) => head.indices.has(index) || tail.indices.has(index));
  const skipped = rendered.length - included.length;
  const discussion: string[] = [];
  if (rendered.length > 0) {
    discussion.push('', 'Discussion:');
    // One line where the gap begins: the head entries, then the count of what fell between
    // the two parts, then the tail entries — so the reader (and the model) can see that the
    // two parts are not contiguous.
    const firstTailIndex = rendered.findIndex((_, index) => tail.indices.has(index));
    rendered.forEach((item, index) => {
      if (skipped > 0 && index === firstTailIndex) {
        discussion.push(
          `[The ${skipped} ${skipped === 1 ? 'entry' : 'entries'} between these two parts ${skipped === 1 ? 'is' : 'are'} not included]`,
        );
      }
      if (head.indices.has(index) || tail.indices.has(index)) {
        discussion.push(item.line);
      }
    });
    if (skipped > 0) {
      assembly.cut = true;
      assembly.notes.push(
        `${skipped} ${skipped === 1 ? 'entry' : 'entries'} between the beginning and the end of this discussion ${skipped === 1 ? 'is' : 'are'} not included.`,
      );
    }
  } else if (input.scope !== 'body-only') {
    discussion.push('', 'Discussion:', 'No comments or events are available to include.');
  }

  const text = [
    ...header,
    ...bodySection,
    ...discussion,
    ...(assembly.notes.length === 0 ? [] : ['', 'What was cut:', ...assembly.notes]),
  ]
    .join('\n')
    .trim();

  return {
    text,
    truncated: assembly.cut,
    notes: assembly.notes,
    includedEntries: included.length,
    skippedEntries: skipped,
  };
}
