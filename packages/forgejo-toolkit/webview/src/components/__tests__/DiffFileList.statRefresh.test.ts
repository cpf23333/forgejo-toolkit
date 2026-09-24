import { describe, expect, it } from 'vitest';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import DiffFileList from '../DiffFileList.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';
import type { ForgejoChangedFile } from '../../types/api';

function changedFile(overrides: Partial<ForgejoChangedFile> & { filename: string }): ForgejoChangedFile {
  return {
    status: 'modified',
    additions: 1,
    deletions: 0,
    changes: 1,
    ...overrides,
  } as ForgejoChangedFile;
}

function mountList(files: ForgejoChangedFile[], options: { attachTo?: HTMLElement } = {}) {
  return mount(DiffFileList, {
    props: { files, supportsMultiDiff: true },
    global: { plugins: [createTestI18n('en')] },
    ...options,
  });
}

function rowByPath(wrapper: ReturnType<typeof mountList>, path: string): DOMWrapper<Element> {
  const found = [...wrapper.element.querySelectorAll('.tree-row')].find(
    (candidate) => candidate.getAttribute('data-path') === path,
  );
  expect(found, `row ${path}`).toBeTruthy();
  return new DOMWrapper(found!);
}

function hasRow(wrapper: ReturnType<typeof mountList>, path: string): boolean {
  return [...wrapper.element.querySelectorAll('.tree-row')].some(
    (candidate) => candidate.getAttribute('data-path') === path,
  );
}

/**
 * The tree keys its rebuild on a content signature. The signature has to cover
 * the line stats the rows render — otherwise a refetch that only changes
 * `additions`/`deletions` left stale +/− badges — while an unrelated parent
 * re-render (a new array holding the same files) must still not reset the user's
 * checked/expanded state.
 */
describe('DiffFileList tree state across rebuilds', () => {
  const statsFiles = () => [
    changedFile({ filename: 'src/a.ts', additions: 2, deletions: 1 }),
    changedFile({ filename: 'src/b.ts', additions: 3, deletions: 0 }),
  ];

  it('updates the +/− badges when only the line stats changed', async () => {
    const wrapper = mountList(statsFiles());
    await nextTick();

    const before = rowByPath(wrapper, 'src/a.ts').find('.node-stats').text();
    expect(before).toContain('+2');
    expect(before).toContain('−1');

    // A refetch with the same names and statuses but new stats.
    await wrapper.setProps({
      files: [
        changedFile({ filename: 'src/a.ts', additions: 9, deletions: 4 }),
        changedFile({ filename: 'src/b.ts', additions: 3, deletions: 0 }),
      ],
    });
    await nextTick();

    const after = rowByPath(wrapper, 'src/a.ts').find('.node-stats').text();
    expect(after).toContain('+9');
    expect(after).toContain('−4');
    wrapper.unmount();
  });

  it('keeps the checked and expanded state across a stat-only rebuild', async () => {
    const wrapper = mountList(statsFiles());
    await nextTick();

    // The user checks a file and collapses its directory.
    const checkbox = rowByPath(wrapper, 'src/a.ts').find('.node-checkbox');
    (checkbox.element as HTMLInputElement).checked = true;
    await checkbox.trigger('change');
    await rowByPath(wrapper, 'src').find('.tree-expander').trigger('click');
    await nextTick();
    expect(hasRow(wrapper, 'src/a.ts')).toBe(false);

    await wrapper.setProps({
      files: [
        changedFile({ filename: 'src/a.ts', additions: 9, deletions: 4 }),
        changedFile({ filename: 'src/b.ts', additions: 3, deletions: 0 }),
      ],
    });
    await nextTick();

    // Still collapsed (and the stats are fresh, so the rebuild really happened).
    expect(hasRow(wrapper, 'src/a.ts')).toBe(false);
    await rowByPath(wrapper, 'src').find('.tree-expander').trigger('click');
    await nextTick();

    const restored = rowByPath(wrapper, 'src/a.ts').find('.node-checkbox');
    expect((restored.element as HTMLInputElement).checked).toBe(true);
    expect(rowByPath(wrapper, 'src/a.ts').find('.node-stats').text()).toContain('+9');
    wrapper.unmount();
  });

  it('does not reset state when a parent re-render hands over the same files', async () => {
    const wrapper = mountList(statsFiles());
    await nextTick();

    const checkbox = rowByPath(wrapper, 'src/a.ts').find('.node-checkbox');
    (checkbox.element as HTMLInputElement).checked = true;
    await checkbox.trigger('change');
    await nextTick();

    // A new array with equal contents — what a parent template mapping over its
    // own data produces on every render.
    await wrapper.setProps({ files: statsFiles() });
    await flushPromises();

    const stillChecked = rowByPath(wrapper, 'src/a.ts').find('.node-checkbox');
    expect((stillChecked.element as HTMLInputElement).checked).toBe(true);
    wrapper.unmount();
  });
});
