import { describe, it, expect } from 'vitest';

/**
 * The editor's identity and the list header are laid out by CSS that jsdom does
 * not evaluate: it computes no cascade, lays nothing out, and never paints, so
 * "the heading is sticky" and "the header wraps" cannot be observed in this
 * environment. What is checkable here is the stylesheet those behaviours depend
 * on — the same kind of guard `Settings.savedListLayout.test.ts` uses — and the
 * markup the stylesheet applies to.
 *
 * What this cannot prove: that the sticky block really stays under the panel's
 * top edge while the fields scroll, that it never covers them, and that the
 * header really wraps `vscode-button`s onto a second line at 250 px. Those are
 * properties of a real render.
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
  const match = new RegExp(`(^|\\n)\\s*${escaped}\\s*(,[\\s\\S]*?)?\\{([^}]*)\\}`).exec(settingsSource);
  expect(match, `styles for ${selector}`).toBeTruthy();
  return match![3];
}

/**
 * The body of a rule written across several selector lines (`.a,` newline `.b
 * {`). `ruleBody` cannot take that form: it matches a literal selector, and the
 * line break is whitespace to the parser but not to the pattern.
 */
function ruleBodyFor(selectors: string[]): string {
  const escaped = selectors.map((selector) => selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*,\\s*');
  const match = new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(settingsSource);
  expect(match, `styles for ${selectors.join(', ')}`).toBeTruthy();
  return match![2];
}

describe('Settings editor identity layout', () => {
  it('reads the component stylesheet it is meant to guard', () => {
    expect(settingsSource).toContain('.editor-heading');
  });

  it('keeps the heading block on screen while the fields scroll', () => {
    const heading = ruleBody('.editor-heading');
    expect(heading).toContain('position: sticky');
    expect(heading).toContain('top: 0');
  });

  it('paints the sticky block so scrolled fields cannot show through it', () => {
    const background = /background-color:\s*([^;]+)/.exec(ruleBody('.editor-heading'))?.[1] ?? '';
    // A theme token, not a literal colour: the webview follows the editor theme.
    expect(background).toContain('var(--vscode-');
    // Opaque is the point. A translucent surface would let the field text it is
    // covering read through the heading.
    expect(background).not.toMatch(/transparent|rgba\(/);
  });

  it('does not introduce a second sticky strip to repeat the identity', () => {
    // The heading block is the sticky element. A second sticky element would be
    // the "repeated name" shape the accessibility rule rules out — either a
    // second heading, or name text announced twice.
    expect(settingsSource.match(/position: sticky/g)).toHaveLength(1);
  });

  it('reserves the sticky block’s height above a field scrolled into view', () => {
    // `top: 0` means the sticky block covers the strip it occupies, so a field
    // scrolled into view stops at the scrollport's own top edge and lands behind
    // it. `scroll-padding-top` is what moves that edge down.
    const scrollContainer = ruleBody('.settings');
    expect(scrollContainer).toContain('overflow: auto');
    const padding = /scroll-padding-top:\s*([^;]+)/.exec(scrollContainer)?.[1] ?? '';
    // The measured height, not a constant: the block is taller in edit mode than
    // in add mode, and taller still when the URL wraps at a narrow width.
    expect(padding).toContain('var(--editor-sticky-height');
    expect(padding).toMatch(/0px/);
    // The block that publishes it is the one that sticks to the same container.
    expect(ruleBody('.editor-heading')).toContain('position: sticky');
  });

  it('compacts the block in a panel too short to hold both it and the fields', () => {
    // The reserved padding moves where a focused field stops, but it cannot
    // create scroll range: at a 300 px panel the scroll is already at its end
    // when the version field is reached. Dropping the URL line is what leaves the
    // field room, and it is the URL — not the mode or the name — that the block
    // can spare.
    const compact = /@media\s*\(max-height:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/.exec(settingsSource);
    expect(compact, 'a short-panel media query').toBeTruthy();
    // A real short-panel threshold, not a value the ordinary sidebar ever meets.
    expect(Number(compact![1])).toBeGreaterThan(0);
    expect(Number(compact![1])).toBeLessThanOrEqual(500);
    const body = compact![2];
    expect(body).toContain('.editor-subject-url-group');
    // Hidden while the panel is short, not removed from the markup: hiding keeps
    // one shape in the DOM for the block.
    expect(body).toContain('display: none');
    // The block must not grow in its compact form, and it must not become a
    // second heading — the compaction only takes a line away.
    expect(body).not.toMatch(/font-size|position:\s*sticky|::before|::after/);
  });
});

describe('Settings narrow-width controls', () => {
  it('makes every fixed-width control in this view fluid', () => {
    // `vscode-textfield` sets `width: 320px` on its own host, which is what
    // overflowed the panel at every sidebar width (a horizontal scrollbar track
    // at the default 358 px, 320 px against a 211/161 px column at 250/200 px).
    const fluid = ruleBodyFor(['vscode-textfield', 'vscode-single-select']);
    expect(fluid).toContain('width: 100%');
    expect(fluid).toContain('max-width: 100%');
    // The rule is stated once for the view, so no later per-instance rule may
    // reintroduce a fixed width for one of these controls.
    expect(settingsSource).not.toMatch(/vscode-textfield[^{]*\{[^}]*width:\s*\d+px/);
    expect(settingsSource).not.toMatch(/vscode-single-select[^{]*\{[^}]*width:\s*\d+px/);
  });

  it('lets the export dialog’s rows fit its body instead of overflowing it', () => {
    // `vscode-checkbox` is shrink-to-fit and the URL line inside it is
    // single-line truncated text, whose full width is still the row's minimum:
    // the row measured 199.7 px inside a 134 px dialog at a 200 px sidebar. A
    // whole-row control takes the row's width, and its URL wraps.
    const body = ruleBody('.export-dialog-content');
    expect(body).toContain('min-width: 0');
    const checkbox = ruleBody('.export-dialog-content vscode-checkbox');
    expect(checkbox).toContain('width: 100%');
    expect(checkbox).toContain('min-width: 0');
    const url = ruleBody('.export-dialog-content .saved-url');
    expect(url).toContain('white-space: normal');
    expect(url).toContain('overflow-wrap: anywhere');
    expect(url).not.toContain('text-overflow: ellipsis');
    // The dialog no longer overrides the name: the list's own `.saved-name` wraps
    // now, so there is nothing single-line left to undo for it.
    expect(settingsSource).not.toContain('.export-dialog-content .saved-name');
  });

  it('keeps the dialog and the list agreeing about which line truncates', () => {
    // A saved-instance row in the panel still truncates its URL, so the dialog is
    // the only place the URL wraps; the name wraps in both.
    expect(ruleBody('.saved-url')).toContain('text-overflow: ellipsis');
    expect(ruleBody('.saved-url')).toContain('white-space: nowrap');
    expect(ruleBody('.saved-name')).not.toContain('text-overflow');
  });
});

describe('Settings state-root focus', () => {
  it('keeps the programmatic focus but paints no ring on either state root', () => {
    // The roots are a destination for assistive technology, not controls: opening
    // the editor moves focus to `.instance-editor`, closing it moves focus to the
    // row's Edit button (or Add Instance, or the list root as the last resort).
    // The ring that used to be drawn around the focused root read as a warning
    // about the whole block — it was painted in `--vscode-focusBorder`, which is
    // yellow in a theme that keeps that colour for warnings.
    const rule = ruleBodyFor([
      '.settings-list:focus',
      '.settings-list:focus-visible',
      '.instance-editor:focus',
      '.instance-editor:focus-visible',
    ]);
    expect(rule).toContain('outline: none');
    // `outline: none` rather than no rule at all: the browser paints a
    // `:focus-visible` ring of its own on anything focusable, and the root matches
    // it (with the author declaration rolled back to the UA origin the focused
    // root reports `auto 1px`). Both origins have to be answered.
    expect(rule).not.toContain('outline-offset');
  });

  it('leaves the interactive controls their own focus rings', () => {
    // A `vscode-button` outlines its inner element and `vscode-textfield` turns
    // its wrapper's border to the focus colour — both inside their own components,
    // which this view must not suppress. The only `outline` declaration here is
    // the `none` on the two non-interactive roots.
    const declarations = settingsSource.match(/^\s*outline:\s*[^;]+;/gm) ?? [];
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toContain('none');
    // Checked rule by rule rather than on the raw text: no rule in this view
    // addresses a control's outline at all.
    const css = settingsSource.slice(settingsSource.indexOf('<style scoped>')).replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
      selectors: match[1].trim(),
      body: match[2],
    }));
    expect(rules.length).toBeGreaterThan(10);
    const outlineRules = rules.filter((rule) => /(^|[;\s])outline\s*:/.test(rule.body));
    expect(outlineRules).toHaveLength(1);
    expect(outlineRules[0].selectors).toContain('.instance-editor');
    expect(outlineRules[0].selectors).toContain('.settings-list');
    for (const rule of rules) {
      if (/vscode-(button|textfield|single-select|checkbox)/.test(rule.selectors)) {
        expect(rule.body, rule.selectors).not.toMatch(/outline\s*:/);
      }
    }
  });
});

describe('Settings narrow-width wrapping', () => {
  it('wraps the Saved Instances header instead of overflowing the panel', () => {
    const header = ruleBody('.section-header');
    expect(header).toContain('flex-wrap: wrap');
    // The heading has to be allowed to shrink below its content width, or it is
    // the buttons that get pushed out of the panel.
    expect(header).toContain('min-width: 0');
    expect(ruleBody('.section-header h2')).toContain('min-width: 0');
    expect(ruleBody('.section-actions')).toContain('flex-wrap: wrap');
  });

  it('wraps every other row of fixed-width buttons in this view', () => {
    // The same defect — `vscode-button` sets `white-space: nowrap`, so a row of
    // them has a hard minimum width — in the two other places it appears.
    for (const selector of ['.cache-directory-actions', '.export-dialog-actions']) {
      expect(ruleBody(selector), selector).toContain('flex-wrap: wrap');
    }
  });
});
