import { describe, it, expect } from 'vitest';

/**
 * `.saved-item` is a `space-between` flex row inside `.settings` (an
 * `overflow: auto` column). A long worktree path or instance URL used to widen
 * the row past the panel, which added a horizontal scrollbar and pushed the
 * Edit/Remove buttons out of view; with `min-width: 0` on the text block it then
 * went the other way at the panel's narrowest, where the fixed-width buttons took
 * the whole row and the name and URL were laid out 0 px wide. The row now keeps a
 * floor under the text and wraps the buttons onto their own line when the two
 * cannot share one.
 *
 * jsdom does not lay anything out, so the guard is on the stylesheet the row
 * relies on: the text block must be allowed to shrink (down to its floor) and
 * truncate, the actions must not shrink, and the row must be able to wrap.
 *
 * The source is read through Vite's glob: the webview tests run without Node
 * types, so `node:fs` is not available here (same approach as
 * `__tests__/helpers/vscodeElements.test.ts`).
 */
const sources = import.meta.glob('../Settings.vue', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const settingsSource = Object.values(sources)[0] ?? '';

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The selector may share a rule with others (`.saved-actions,` newline
  // `.worktree-actions {`), so it only has to end its own line.
  const match = new RegExp(`(^|\\n)\\s*${escaped}\\s*(,[\\s\\S]*?)?\\{([^}]*)\\}`).exec(settingsSource);
  expect(match, `styles for ${selector}`).toBeTruthy();
  return match![3];
}

describe('Settings saved-list layout', () => {
  it('reads the component stylesheet it is meant to guard', () => {
    // A silently empty glob would make every check below pass on its own.
    expect(settingsSource).toContain('.saved-item');
  });

  it('lets a long instance URL or worktree path shrink instead of widening the row', () => {
    const info = ruleBody('.saved-info');
    // The block yields — but no longer to nothing. With `min-width: 0` and an
    // automatic basis it was the only part that could give, so at a 200 px panel
    // the buttons claimed the whole 143 px content box and the name and URL were
    // laid out 0 px wide, with only the two buttons drawn.
    const floor = /min-width:\s*([^;]+)/.exec(info)?.[1]?.trim() ?? '';
    // A floor of twelve characters, capped at the block's own column: the export
    // dialog puts the same marker inside a checkbox label narrower than a row's
    // line, where an uncapped floor would be a new overflow rather than a fix.
    expect(floor, 'a floor under the info column').toMatch(/^min\(\s*\d+(\.\d+)?ch\s*,\s*100%\s*\)$/);
    // The basis is deliberately not the block's longest URL: with `flex: 1 1 auto`
    // the row's line breaking would push the actions onto their own line even in
    // a wide panel, where the two fit together today.
    expect(info).toMatch(/flex:\s*1 1 0/);
    // A single long token (a URL, a path) has no space to wrap at.
    expect(info).toContain('overflow-wrap: anywhere');
  });

  it('wraps the actions onto their own line when the two cannot share one', () => {
    // The floor above is only half the rule: the row has to be allowed to wrap
    // for it to take effect, which is what keeps the identity readable at the
    // panel's narrowest instead of the buttons squeezing it out.
    expect(ruleBody('.saved-item')).toContain('flex-wrap: wrap');
    const actions = ruleBody('.saved-actions');
    expect(actions).toMatch(/flex:\s*0 0 auto/);
    // The pair keeps its trailing edge on the single line and on the line it
    // wraps to (`space-between` would leave it at the start of its own line), and
    // wraps within itself like every other row of fixed-width buttons in the view.
    expect(actions).toContain('margin-left: auto');
    expect(actions).toContain('flex-wrap: wrap');
    // The worktree rows have the same shape and are covered by the same rules.
    expect(ruleBody('.worktree-actions')).toMatch(/flex:\s*0 0 auto/);
    expect(ruleBody('.worktree-actions')).toContain('flex-wrap: wrap');
  });

  it('keeps the row actions from shrinking away', () => {
    expect(ruleBody('.saved-actions')).toMatch(/flex:\s*0 0 auto/);
    expect(ruleBody('.worktree-actions')).toMatch(/flex:\s*0 0 auto/);
  });

  it('states the instance name in full instead of clipping it', () => {
    const name = ruleBody('.saved-name');
    // The name was a single clipped line at every panel width: the row's own
    // identity was the one thing the row could not show.
    expect(name).not.toContain('text-overflow');
    expect(name).not.toContain('white-space: nowrap');
    expect(name).not.toContain('overflow: hidden');
    // It is breakable without a rule of its own: `cpf23333@192.168.1.100:3004` is
    // one run with no natural break in it, and the column it sits in carries the
    // `overflow-wrap` that breaks such a run — which the name inherits.
    expect(ruleBody('.saved-info')).toContain('overflow-wrap: anywhere');
  });

  it('leaves the two lines under the name single-line and truncated', () => {
    // Judged rather than changed by reflex: a URL fits the column at the widths
    // this panel is used at, and the worktree cache path is long enough that
    // wrapping it would add three or four lines to a row that is meant to be
    // scanned, pushing its actions far down.
    for (const selector of ['.saved-url', '.saved-path']) {
      const body = ruleBody(selector);
      expect(body, selector).toContain('text-overflow: ellipsis');
      expect(body, selector).toContain('white-space: nowrap');
      expect(body, selector).toContain('overflow: hidden');
    }
  });

  it('separates the text block from the actions so they cannot touch', () => {
    expect(ruleBody('.saved-item')).toContain('gap: 8px');
  });
});
