import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_SUMMARY_MAX_ENTRY_LENGTH,
  NOTIFICATION_SUMMARY_TIMELINE_BUDGET,
  buildNotificationSummaryMaterial,
  normalizeNotificationTimeline,
  type NotificationSummaryEntry,
  type NotificationSummaryEntryLike,
  type NotificationSummarySkeleton,
} from '../notificationSummaryBrief';

/**
 * The trimmer's own criteria (`docs/design/notification-summary.md` §3.3, §9): what one
 * prompt may carry, how the budget splits between the head and the tail, what a leftover
 * does, and the one property that makes all of it testable — the same timeline renders a
 * byte-identical prompt.
 */

const SKELETON: NotificationSummarySkeleton = {
  owner: 'alice',
  repo: 'demo',
  type: 'issue',
  index: 7,
  title: 'The discussion',
  state: 'open',
  updatedAt: '2026-01-02T03:04:05Z',
};

function comment(text: string, author = 'alice', createdAt = '2026-01-01T00:00:00Z'): NotificationSummaryEntry {
  return { kind: 'comment', author, createdAt, text };
}

function event(text: string): NotificationSummaryEntry {
  return { kind: 'event', author: 'bob', createdAt: '2026-01-01T00:00:00Z', text };
}

function build(entries: readonly NotificationSummaryEntry[], extra: Record<string, unknown> = {}) {
  return buildNotificationSummaryMaterial({
    scope: 'body-comments-and-events',
    skeleton: SKELETON,
    firstBody: 'the first post',
    entries,
    ...extra,
  });
}

describe('the notification summary brief', () => {
  it('renders a byte-identical prompt for the same timeline', () => {
    const entries = [event('added the label "bug"'), comment('first'), comment('second'), comment('third')];

    const first = build(entries);
    const second = build(entries);

    expect(second.text).toBe(first.text);
    expect(second.notes).toEqual(first.notes);
    expect(second.truncated).toBe(first.truncated);
    // Nothing was cut here, so the material says nothing about cuts.
    expect(first.notes).toEqual([]);
    expect(first.truncated).toBe(false);
  });

  it('keeps the beginning and the end, and says how many entries fell between them', () => {
    // Thirty entries just under the per-entry cap: each half holds about eight of them, so
    // the middle is genuinely left out. Entries at the cap matter here — a timeline whose
    // entries were all cut to the cap first would never overflow the timeline budget at all.
    const entries = Array.from({ length: 30 }, (_, index) =>
      comment(`comment-${index} ${'x'.repeat(980)}`, `user-${index}`),
    );

    const material = build(entries);

    expect(material.truncated).toBe(true);
    expect(material.text).toContain('comment-0');
    expect(material.text).toContain('comment-29');
    expect(material.skippedEntries).toBeGreaterThan(0);
    expect(material.text).toContain(
      `[The ${material.skippedEntries} entries between these two parts are not included]`,
    );
    expect(material.text).toContain(
      `${material.skippedEntries} entries between the beginning and the end of this discussion are not included.`,
    );
    // Every note is also inside the text: nothing is announced only to the caller.
    for (const note of material.notes) {
      expect(material.text).toContain(note);
    }
  });

  it('gives the budget’s leftover to one side, and says so in the prompt', () => {
    // Fifteen 1000-character entries: each half holds seven of them at 8 KiB, one entry is
    // left in the middle, and the characters the halves did not use are enough to take it —
    // the transfer the design says must be handed over and declared.
    const entries = Array.from({ length: 15 }, (_, index) =>
      comment(`${String(index).padStart(2, '0')}${'a'.repeat(998)}`, `u${index}`),
    );

    const material = build(entries);

    expect(material.notes.some((note) => note.includes('characters the rest of the budget had left'))).toBe(true);
    expect(material.skippedEntries).toBe(0);
    // A transfer is not an omission: nothing was left out because of it.
    expect(material.truncated).toBe(false);
    expect(material.notes.some((note) => note.includes('not included'))).toBe(false);
    expect(material.includedEntries).toBe(15);
  });

  it('cuts one entry to the per-entry cap and states the cut', () => {
    const material = build([comment('q'.repeat(NOTIFICATION_SUMMARY_MAX_ENTRY_LENGTH + 500))]);

    expect(material.truncated).toBe(true);
    expect(material.text).toContain(`only the first ${NOTIFICATION_SUMMARY_MAX_ENTRY_LENGTH} are included`);
    // The over-cap entry really was cut: the material cannot hold the whole body.
    expect(material.text).not.toContain('q'.repeat(NOTIFICATION_SUMMARY_MAX_ENTRY_LENGTH + 1));
  });

  it('removes the leading quoted block and declares that removal', () => {
    const material = build([comment('> alice wrote:\n> the quoted sentence\n\nmy own reply')]);

    expect(material.truncated).toBe(true);
    expect(material.text).toContain('my own reply');
    expect(material.text).not.toContain('the quoted sentence');
    expect(material.notes.some((note) => note.includes('quoted block at the start'))).toBe(true);
  });

  it('does not deduplicate identical bodies', () => {
    const material = build([comment('the same words'), comment('the same words')]);

    expect(material.includedEntries).toBe(2);
    expect(material.text.match(/the same words/g)).toHaveLength(2);
  });

  it('renders an event as one line, and body-only sends neither comments nor events', () => {
    const rows: NotificationSummaryEntryLike[] = [
      { created_at: '2026-01-01T00:00:00Z', user: { login: 'bob' }, label: { name: 'bug' } },
      { body: 'a comment', created_at: '2026-01-01T00:01:00Z', user: { login: 'alice' } },
    ];
    const entries = normalizeNotificationTimeline(rows);

    expect(entries[0]).toEqual({
      kind: 'event',
      author: 'bob',
      createdAt: '2026-01-01T00:00:00Z',
      text: 'added the label "bug"',
    });

    const eventLine = build(entries, { scope: 'body-comments-and-events' })
      .text.split('\n')
      .find((line) => line.includes('added the label'));
    expect(eventLine).toBe('[2026-01-01T00:00:00Z bob] added the label "bug"');

    const bodyOnly = build(entries, { scope: 'body-only' });
    expect(bodyOnly.includedEntries).toBe(0);
    expect(bodyOnly.text).toContain('the first post');
    expect(bodyOnly.text).not.toContain('a comment');
    expect(bodyOnly.text).not.toContain('added the label');
  });

  it('pins the first body outside the entry budget', () => {
    // A first post far over the timeline budget still leaves the discussion in the prompt:
    // the design rejected letting it compete (§3.2).
    const huge = 'f'.repeat(NOTIFICATION_SUMMARY_TIMELINE_BUDGET * 2);
    const material = build([comment('a comment that must survive')], { firstBody: huge });

    expect(material.text).toContain('a comment that must survive');
    expect(material.text).toContain(`only the first ${NOTIFICATION_SUMMARY_MAX_ENTRY_LENGTH} are included`);
  });

  it('keeps the input order', () => {
    const material = build([comment('first', 'alice'), comment('second', 'bob'), comment('third', 'carol')]);

    expect(material.text.indexOf('first')).toBeLessThan(material.text.indexOf('second'));
    expect(material.text.indexOf('second')).toBeLessThan(material.text.indexOf('third'));
  });

  it('says there is nothing to include rather than reporting a cut', () => {
    const empty = buildNotificationSummaryMaterial({
      scope: 'body-and-comments',
      skeleton: SKELETON,
      firstBody: '',
      entries: [],
    });

    expect(empty.truncated).toBe(false);
    expect(empty.includedEntries).toBe(0);
    expect(empty.text).toContain('No comments or events are available to include.');

    // An events-only timeline under a comments scope has nothing to send either.
    const noComments = build([event('closed it')], { scope: 'body-and-comments' });
    expect(noComments.includedEntries).toBe(0);
    expect(noComments.truncated).toBe(false);
  });

  it('never sends a URL field, and keeps the links and names a body itself carries', () => {
    const rows: NotificationSummaryEntryLike[] = [
      { body: 'see https://codeberg.org/alice/repo#12 — bob agrees', user: { login: 'alice' } },
      { id: 5, issue_url: 'https://forgejo.example.com/api/v1/repos/a/b/issues/1' } as NotificationSummaryEntryLike,
    ];
    const entries = normalizeNotificationTimeline(rows);
    const material = build(entries);

    // The author's own prose is material, links and names included (§5).
    expect(material.text).toContain('https://codeberg.org/alice/repo#12');
    expect(material.text).toContain('bob agrees');
    // No URL the platform attached to a row is sent.
    expect(material.text).not.toContain('forgejo.example.com');
  });
});
