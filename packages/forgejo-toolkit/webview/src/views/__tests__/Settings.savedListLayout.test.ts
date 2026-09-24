import { describe, it, expect } from 'vitest';

/**
 * `.saved-item` is a `space-between` flex row inside `.settings` (an
 * `overflow: auto` column). A long worktree path or instance URL used to widen
 * the row past the panel, which added a horizontal scrollbar and pushed the
 * Edit/Remove buttons out of view. jsdom does not lay anything out, so the
 * guard is on the stylesheet the row relies on: the text block must be allowed
 * to shrink and truncate, and the actions must not.
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
    // Without `min-width: 0` a flex item refuses to shrink below its content
    // width, which is what pushed the action buttons off screen.
    expect(info).toContain('min-width: 0');
    expect(info).toMatch(/flex:\s*1 1 auto/);
    // A single long token (a URL, a path) has no space to wrap at.
    expect(info).toContain('overflow-wrap: anywhere');
  });

  it('keeps the row actions from shrinking away', () => {
    expect(ruleBody('.saved-actions')).toMatch(/flex:\s*0 0 auto/);
    expect(ruleBody('.worktree-actions')).toMatch(/flex:\s*0 0 auto/);
  });

  it('truncates every text line of a saved entry', () => {
    for (const selector of ['.saved-name', '.saved-url', '.saved-path']) {
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
