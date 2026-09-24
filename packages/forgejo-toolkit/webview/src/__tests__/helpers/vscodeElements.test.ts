import { describe, expect, it } from 'vitest';
import { VSCODE_ELEMENT_TAGS } from './vscodeElements';

/**
 * Keeps {@link VSCODE_ELEMENT_TAGS} in step with the custom elements the webview
 * actually renders.
 *
 * The `<vscode-*>` tags are compiled as custom elements (see `vite.config.ts`),
 * so a tag nobody registered in a test renders as an inert element: the
 * component's v-model and event handlers silently do nothing and the test still
 * passes. This guard turns that into a failure naming the tag and the file that
 * would have to register it.
 *
 * The sources are read through Vite's glob (the webview tests run without Node
 * types, so `node:fs` is not available here). Only tags written as elements in a
 * `.vue`/`.ts` source are seen; a tag created through `h()` or a dynamic
 * component is out of reach.
 */
const sources = import.meta.glob(['../../**/*.{vue,ts}', '!../../**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Rendered tag → the source file that renders it, for the failure message. */
function renderedElements(): Map<string, string> {
  const elements = new Map<string, string>();
  for (const [file, source] of Object.entries(sources)) {
    const display = file.replace(/^\.\.\/\.\.\//, '');
    for (const match of source.matchAll(/<(vscode-[a-z0-9-]+)/g)) {
      if (!elements.has(match[1])) {
        elements.set(match[1], display);
      }
    }
  }
  return elements;
}

describe('webview custom elements', () => {
  const rendered = renderedElements();

  it('renders no custom element the test setup does not know', () => {
    const unknown = [...rendered]
      .filter(([tag]) => !VSCODE_ELEMENT_TAGS.includes(tag))
      .map(([tag, file]) => ({ tag, file }));
    expect(unknown).toEqual([]);
  });

  it('lists no custom element the webview no longer renders', () => {
    const unused = VSCODE_ELEMENT_TAGS.filter((tag) => !rendered.has(tag));
    expect(unused).toEqual([]);
  });

  it('finds the webview sources it is meant to scan', () => {
    // A silently empty scan would make both checks above pass on their own.
    expect(rendered.size).toBeGreaterThan(0);
    expect(rendered.has('vscode-icon')).toBe(true);
  });
});
