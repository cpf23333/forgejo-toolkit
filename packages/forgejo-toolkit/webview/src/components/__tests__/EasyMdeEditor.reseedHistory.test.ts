import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import EasyMdeEditor from '../EasyMdeEditor.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

// The slice of the CodeMirror instance this test drives. The `codemirror` type
// package is not resolvable from this package, so the shape is declared here.
interface CodeMirrorEditor {
  getValue(): string;
  undo(): void;
  replaceRange(
    text: string,
    from: { line: number; ch: number },
    to?: { line: number; ch: number },
    origin?: string,
  ): void;
}

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
// CodeMirror 5 calls while measuring. Without a stub the editor still builds its
// DOM but every measurement throws.
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
 * The edit-comment dialog keeps one editor instance and re-seeds it with the
 * body of the comment currently being edited. CodeMirror records EasyMDE's
 * `value(value)` (a `setValue`) as an undoable change, so the re-seed used to
 * leave the previous comment's text in the undo stack: Ctrl+Z in comment B
 * restored comment A's draft, and Save wrote it into B.
 */
describe('EasyMdeEditor re-seed undo history', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
    Range.prototype.getBoundingClientRect = () => EMPTY_RECT;
    Range.prototype.getClientRects = () =>
      ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mountEditor(modelValue: string) {
    return mount(EasyMdeEditor, {
      props: { modelValue },
      global: { plugins: [createTestI18n('en')] },
    });
  }

  /** Waits for the lazily imported EasyMDE to build the CodeMirror instance. */
  async function codeMirror(wrapper: ReturnType<typeof mountEditor>): Promise<CodeMirrorEditor> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = wrapper.find('.CodeMirror');
      const element = found.exists() ? (found.element as HTMLElement & { CodeMirror?: CodeMirrorEditor }) : undefined;
      if (element?.CodeMirror) {
        return element.CodeMirror;
      }
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('EasyMDE did not initialise');
  }

  it("cannot bring back the previous comment's text with undo", async () => {
    const wrapper = mountEditor('comment A body');
    const cm = await codeMirror(wrapper);
    expect(cm.getValue()).toBe('comment A body');

    // The user opens the edit dialog for another comment: the same editor is
    // re-seeded with the new body.
    await wrapper.setProps({ modelValue: 'comment B body' });
    await nextTick();
    expect(cm.getValue()).toBe('comment B body');

    // Ctrl+Z in comment B must not restore comment A's text.
    cm.undo();
    await nextTick();
    expect(cm.getValue()).toBe('comment B body');

    wrapper.unmount();
  });

  it('still undoes what the user typed after a re-seed', async () => {
    const wrapper = mountEditor('comment A body');
    const cm = await codeMirror(wrapper);

    await wrapper.setProps({ modelValue: 'comment B body' });
    await nextTick();

    // The user types; the editor emits the new value and the parent's v-model
    // echoes it back, which must not be mistaken for a re-seed.
    cm.replaceRange('typed ', { line: 0, ch: 0 }, undefined, '+input');
    await nextTick();
    await wrapper.setProps({ modelValue: cm.getValue() });
    await nextTick();
    expect(cm.getValue()).toBe('typed comment B body');

    cm.undo();
    await nextTick();
    expect(cm.getValue()).toBe('comment B body');

    wrapper.unmount();
  });
});
