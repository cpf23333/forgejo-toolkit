import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

import EasyMdeEditor from '../EasyMdeEditor.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

// jsdom has no IntersectionObserver; EasyMdeEditor uses one to refresh
// CodeMirror when the wrapper scrolls into view.
class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

// jsdom's Range does not implement getBoundingClientRect/getClientRects, which
// CodeMirror 5 calls while measuring.
const EMPTY_RECT = {
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  width: 0,
  height: 0,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as unknown as DOMRect;

/**
 * Several EasyMdeEditor instances can be mounted on one page (the comment
 * composer next to the per-comment edit forms, plus the edit dialog). The
 * Enter/Up/Down guard has to consult the mention menu of the editor the key
 * went to, not the first `.tribute-container` in the document: with a global
 * lookup, one editor's open mention menu swallowed those keys in every other
 * editor on the page.
 */
describe('EasyMdeEditor tribute menu scoping', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
    Range.prototype.getBoundingClientRect = () => EMPTY_RECT;
    Range.prototype.getClientRects = () =>
      ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mountEditor() {
    // Attached to the document so the document-wide lookup the old guard ran
    // can actually see another editor's menu (the regression this pins).
    return mount(EasyMdeEditor, {
      attachTo: document.body,
      props: { modelValue: '' },
      global: { plugins: [createTestI18n('en')] },
    });
  }

  /** Waits for the lazily imported EasyMDE to build the toolbar. */
  async function waitForEditor(wrapper: ReturnType<typeof mountEditor>) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (wrapper.find('.editor-toolbar').exists()) {
        return;
      }
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('EasyMDE did not initialise');
  }

  /** Presses a key on the editor's CodeMirror input field. */
  function pressKey(wrapper: ReturnType<typeof mountEditor>, keyCode: number) {
    const input = wrapper.find('.CodeMirror textarea').element as HTMLTextAreaElement;
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    // KeyboardEvent's init dict cannot carry the legacy keyCode CM 5 reads.
    Object.defineProperty(event, 'keyCode', { value: keyCode });
    input.dispatchEvent(event);
  }

  /** The state an open mention menu has inside an editor's wrapper. */
  function openTributeMenu(wrapper: ReturnType<typeof mountEditor>): HTMLElement {
    const menu = document.createElement('ul');
    menu.className = 'tribute-container';
    (wrapper.element as HTMLElement).appendChild(menu);
    return menu;
  }

  function emittedValue(wrapper: ReturnType<typeof mountEditor>): string | undefined {
    return wrapper.emitted('update:modelValue')?.at(-1)?.[0] as string | undefined;
  }

  it("one editor's open mention menu does not swallow Enter in the other", async () => {
    const first = mountEditor();
    const second = mountEditor();
    await waitForEditor(first);
    await waitForEditor(second);

    const menu = openTributeMenu(first);

    pressKey(second, 13);
    expect(emittedValue(second)).toBe('\n');
    expect(emittedValue(first)).toBeUndefined();

    // The editor that owns the open menu still swallows Enter for it.
    pressKey(first, 13);
    expect(emittedValue(first)).toBeUndefined();

    menu.remove();
    pressKey(first, 13);
    expect(emittedValue(first)).toBe('\n');

    first.unmount();
    second.unmount();
  });
});
