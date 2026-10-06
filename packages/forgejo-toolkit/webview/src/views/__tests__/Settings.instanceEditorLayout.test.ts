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

  it('keeps the identity block of an editor the only sticky strip it has', () => {
    // The heading block is the sticky element **of an editor**: a second one there
    // would be the "repeated name" shape the accessibility rule rules out — either
    // a second heading, or name text announced twice. The list state has since
    // grown sticky blocks of its own — the narrow shape's group bar and the wide
    // shape's navigation column (`docs/design/settings-page.md` §9.3) — and they
    // are the page's chrome rather than a record's identity: both are inside the
    // list state's branch, which is not on screen while an editor is open. So the
    // set is pinned as a whole, which is what keeps a *new* sticky strip from
    // joining them unnoticed.
    const stickyVehicles = [...settingsSource.matchAll(/([^{}]+)\{([^{}]*position:\s*sticky[^{}]*)\}/g)].map(
      (match) =>
        // The selector is the last line of the match's prefix that is not part of
        // the comment block above the rule.
        match[1]
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '' && !line.startsWith('*') && !line.startsWith('/*'))
          .pop() ?? '',
    );
    expect(stickyVehicles.sort()).toEqual(['.editor-heading', '.settings-nav', '.settings-pane-bar']);
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

  it('compacts the band in a panel too short to hold both it and the fields', () => {
    // The reserved padding moves where a focused field stops, but it cannot
    // create scroll range: at a 300 px panel the scroll is already at its end
    // when the version field is reached. Dropping the identity line is what
    // leaves the field room, and it is the identity — not the way out or the title
    // — that the band can spare: the record is named in the fields below.
    const compact = /@media\s*\(max-height:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/.exec(settingsSource);
    expect(compact, 'a short-panel media query').toBeTruthy();
    // A real short-panel threshold, not a value the ordinary sidebar ever meets.
    expect(Number(compact![1])).toBeGreaterThan(0);
    expect(Number(compact![1])).toBeLessThanOrEqual(500);
    const body = compact![2];
    expect(body).toContain('.editor-identity');
    // Hidden while the panel is short, not removed from the markup: hiding keeps
    // one shape in the DOM for the band.
    expect(body).toContain('display: none');
    // The band must not grow in its compact form, and it must not become a
    // second heading — the compaction only takes a line away.
    expect(body).not.toMatch(/font-size|position:\s*sticky|::before|::after/);
  });

  it('aligns the band’s three lines on one grid at every width', () => {
    // The band is a grid, not a stack of margins: one left edge for the way out,
    // the title and the identity, and one declaration for the gap between the
    // rows (`docs/design/settings-page.md` §3.4). The measured height stays the
    // band's own, which is what `--editor-sticky-height` publishes.
    const band = ruleBody('.editor-heading');
    expect(band).toContain('display: grid');
    expect(band).toContain('align-content: start');
    expect(band).toMatch(/gap:\s*\d+px/);
  });

  it('keeps the way out and the copy control from wrapping while the record text gives way', () => {
    // At a narrow width the name and the address below wrap; neither control
    // does. The way out is nowrap and keeps its own width in its grid row, and
    // the copy control never shrinks inside the identity line.
    const back = ruleBodyFor(['.editor-heading .editor-band-back']);
    expect(back).toContain('white-space: nowrap');
    expect(back).toContain('justify-self: start');
    // The codicon and the label on one line is what `inline-flex` buys, over the
    // global `.link-button` reset's `inline`.
    expect(back).toContain('display: inline-flex');

    const identity = ruleBody('.editor-identity');
    expect(identity).toContain('flex-wrap: wrap');
    expect(identity).toContain('min-width: 0');

    // The address is the half that gives way: it ellipsises rather than holding
    // the line open, and the control beside it keeps its size.
    const url = ruleBody('.editor-identity-url');
    expect(url).toContain('min-width: 0');
    expect(url).toContain('text-overflow: ellipsis');
    expect(url).toContain('white-space: nowrap');
    expect(url).toContain('var(--vscode-editor-font-family)');
    expect(ruleBody('.editor-identity-url-group .editor-copy-url')).toContain('flex: 0 0 auto');

    // A `nowrap` on the address only ellipsises if its group hands the room over:
    // the group is flexible, and it is the address — not the control — that
    // shrinks.
    expect(ruleBody('.editor-identity-url-group')).toContain('flex: 1 1 12ch');
  });

  it('does not rely on colour alone for the identity', () => {
    // The name is weight and the address is monospace as well as secondary
    // colour: the two halves are distinguishable without the hue.
    const name = ruleBody('.editor-identity-name');
    expect(name).toContain('font-weight: 600');
    const url = ruleBody('.editor-identity-url');
    expect(url).toContain('font-family');
    expect(url).toContain('color: var(--vscode-descriptionForeground)');
  });

  it('paints the band from the page surface and closes it with a hairline', () => {
    // The band is not a card: the page's own background plus the theme's panel
    // border, the same pair the pane titles use.
    const band = ruleBody('.editor-heading');
    expect(band).toContain('background-color: var(--vscode-sideBar-background, var(--vscode-editor-background))');
    expect(band).toContain('border-bottom: 1px solid var(--vscode-panel-border)');
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
    // which this view must not suppress. Two `outline` declarations are this
    // view's own: the `none` on the two non-interactive state roots, and the ring
    // the navigation items draw — they are plain `<button>`s of the page's own
    // making, so nothing else draws one for them (§9.3).
    const declarations = settingsSource.match(/^\s*outline:\s*[^;]+;/gm) ?? [];
    const suppressions = declarations.filter((declaration) => declaration.includes('none'));
    expect(suppressions).toHaveLength(1);
    // Checked rule by rule rather than on the raw text: no rule in this view
    // addresses a `vscode-*` control's outline at all.
    const css = settingsSource.slice(settingsSource.indexOf('<style scoped>')).replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
      selectors: match[1].trim(),
      body: match[2],
    }));
    expect(rules.length).toBeGreaterThan(10);
    const outlineRules = rules.filter((rule) => /(^|[;\s])outline\s*:/.test(rule.body));
    expect(outlineRules).toHaveLength(2);
    const rootRule = outlineRules.find((rule) => rule.body.includes('none'));
    expect(rootRule?.selectors).toContain('.instance-editor');
    expect(rootRule?.selectors).toContain('.settings-list');
    const navigationRule = outlineRules.find((rule) => rule !== rootRule);
    expect(navigationRule?.selectors).toContain('.settings-nav-item');
    expect(navigationRule?.body).toContain('var(--vscode-focusBorder)');
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
