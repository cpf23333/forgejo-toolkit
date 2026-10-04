import { describe, it, expect } from 'vitest';

/**
 * The prose blocks of Settings.vue name settings, commands and paths, and those
 * names are single unbreakable runs: `forgejoToolkit.aiPreReviewChooseModel` is a
 * 195.6 px line box in the AI pre-review note, and an export path is a 610 px one
 * in the status region. A line box wider than the column is a horizontal
 * scrollbar on `.settings` — the note alone made it report 196 px of scroll width
 * against 161 px of content at a 200 px panel.
 *
 * jsdom computes no cascade and lays nothing out, so the wrapping itself is a
 * property of the real render (measured there: the same panel reports 161/161 and
 * no overflowing line box once the rule is in). What is checkable here is the
 * one rule those blocks rely on and the fact that it is one rule for all of them
 * rather than a patch per string.
 *
 * The source is read through Vite's glob: the webview tests run without Node
 * types, so `node:fs` is not available here (same approach as
 * `Settings.savedListLayout.test.ts`).
 */
const sources = import.meta.glob('../Settings.vue', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const settingsSource = Object.values(sources)[0] ?? '';

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\n)\\s*${escaped}\\s*(,[\\s\\S]*?)?\\{([^}]*)\\}`).exec(settingsSource);
  expect(match, `styles for ${selector}`).toBeTruthy();
  return match![3];
}

/** The body of one rule written across several selector lines (`.a,` newline `.b {`). */
function ruleBodyFor(selectors: string[]): string {
  const escaped = selectors.map((selector) => selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*,\\s*');
  const match = new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(settingsSource);
  expect(match, `styles for ${selectors.join(', ')}`).toBeTruthy();
  return match![2];
}

/** The prose blocks that share the one wrapping rule, in the order the rule lists them. */
const PROSE_SELECTORS = [
  '.description',
  '.field-description',
  '.empty-list',
  '.status',
  '.provider-fact',
  '.rejected-list li',
];

describe('Settings prose blocks wrap long identifiers', () => {
  it('reads the component stylesheet it is meant to guard', () => {
    expect(settingsSource).toContain('.field-description');
  });

  it('wraps the identifier, not the words around it', () => {
    // `anywhere` breaks a run only when it cannot fit a line of its own, so
    // ordinary prose still wraps at its spaces. `word-break: break-all` would
    // break it mid-word to fill every line.
    const prose = ruleBodyFor(PROSE_SELECTORS);
    expect(prose).toContain('overflow-wrap: anywhere');
    expect(prose).not.toContain('word-break');
  });

  it('states the rule once for every prose block in the view', () => {
    // `ruleBodyFor` only matches when the selectors share one rule, so this is
    // "one rule, every block": a new block that renders prose belongs in this list
    // rather than in a patch of its own. The AI endpoints section added two — the
    // facts under a provider row (a reader's rejection reason, an address, the
    // local-only sentence) and the refused entries themselves. The exceptions are
    // deliberate — the saved instance URL and the worktree cache path are single
    // lines truncated by their own `overflow: hidden`, while the instance name
    // above them wraps through the info column's own `overflow-wrap` (see
    // `Settings.savedListLayout`).
    expect(ruleBodyFor(PROSE_SELECTORS)).toContain('overflow-wrap: anywhere');
    expect(ruleBody('.saved-url')).toContain('text-overflow: ellipsis');
    expect(ruleBody('.saved-path')).toContain('text-overflow: ellipsis');
    expect(ruleBody('.saved-name')).not.toContain('text-overflow');
  });

  it('covers the string that was measured overflowing the panel', () => {
    // The measured defect is the AI pre-review note, rendered in one of the four
    // blocks above; a change of block class would leave this rule behind.
    expect(settingsSource).toMatch(
      /<p class="field-description">\{\{\s*t\('settings\.aiPreReviewModel\.note'\)\s*\}\}<\/p>/,
    );
  });
});
