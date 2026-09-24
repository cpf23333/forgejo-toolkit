import { describe, it, expect } from 'vitest';
import { DOMWrapper, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import CommitDiffList from '../CommitDiffList.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';
import type { ForgejoPullRequestCommit } from '../../types/api';

/**
 * `CommitDiffList` maps each commit's files inside its template, so every one of
 * its renders hands `DiffFileList` a brand-new array with the same files. The
 * tree used to key its state on that array's identity and rebuilt itself —
 * unchecking files and re-expanding/recollapsing directories — whenever any
 * unrelated part of the view re-rendered, e.g. when another commit was
 * expanded. These tests pin the tree's state to the *contents* it was built
 * from, so only a real change to a commit's files resets it.
 */
function commits(): ForgejoPullRequestCommit[] {
  return [
    {
      sha: 'aaaaaaa1',
      commit: { message: 'first commit' },
      files: [
        { filename: 'src/a.ts', status: 'modified' },
        { filename: 'src/b.ts', status: 'modified' },
      ],
    },
    {
      sha: 'bbbbbbb2',
      commit: { message: 'second commit' },
      files: [{ filename: 'other/c.ts', status: 'added' }],
    },
  ] as unknown as ForgejoPullRequestCommit[];
}

function mountList() {
  return mount(CommitDiffList, {
    props: { commits: commits(), supportsMultiDiff: true },
    global: { plugins: [createTestI18n('en')] },
  });
}

function commitItem(wrapper: VueWrapper, index: number): DOMWrapper<Element> {
  const item = wrapper.findAll('.commit-item')[index];
  expect(item, `commit item ${index}`).toBeTruthy();
  return item;
}

/** The tree row for `path` inside the commit at `index`, found through the DOM. */
function row(wrapper: VueWrapper, index: number, path: string): DOMWrapper<Element> {
  const found = [...commitItem(wrapper, index).element.querySelectorAll('.tree-row')].find(
    (candidate) => candidate.getAttribute('data-path') === path,
  );
  expect(found, `row ${path} in commit ${index}`).toBeTruthy();
  return new DOMWrapper(found!);
}

function hasRow(wrapper: VueWrapper, index: number, path: string): boolean {
  return [...commitItem(wrapper, index).element.querySelectorAll('.tree-row')].some(
    (candidate) => candidate.getAttribute('data-path') === path,
  );
}

async function toggleCommit(wrapper: VueWrapper, index: number) {
  await commitItem(wrapper, index).find('.commit-header').trigger('click');
  await nextTick();
}

describe('CommitDiffList per-commit tree state', () => {
  it('keeps a checked file when another commit is expanded', async () => {
    const wrapper = mountList();
    await toggleCommit(wrapper, 0);

    const checkbox = row(wrapper, 0, 'src/a.ts').find('.node-checkbox');
    (checkbox.element as HTMLInputElement).checked = true;
    await checkbox.trigger('change');
    expect((row(wrapper, 0, 'src/a.ts').find('.node-checkbox').element as HTMLInputElement).checked).toBe(true);

    // Expanding another commit re-renders the whole list (and recreates every
    // commit's file array) without touching commit 0's files.
    await toggleCommit(wrapper, 1);

    expect((row(wrapper, 0, 'src/a.ts').find('.node-checkbox').element as HTMLInputElement).checked).toBe(true);
    // The multi-select toolbar of the untouched commit still counts it.
    const viewSelected = commitItem(wrapper, 0)
      .findAll('button')
      .find((button) => button.text().includes('View selected diffs'));
    expect(viewSelected, 'View selected diffs button').toBeTruthy();
    expect(viewSelected!.attributes('disabled')).toBeUndefined();
  });

  it('keeps a collapsed directory collapsed when another commit is expanded', async () => {
    const wrapper = mountList();
    await toggleCommit(wrapper, 0);
    expect(hasRow(wrapper, 0, 'src/a.ts')).toBe(true);

    await row(wrapper, 0, 'src').find('.tree-expander').trigger('click');
    await nextTick();
    expect(hasRow(wrapper, 0, 'src/a.ts')).toBe(false);

    await toggleCommit(wrapper, 1);

    expect(hasRow(wrapper, 0, 'src/a.ts')).toBe(false);
    wrapper.unmount();
  });

  it('rebuilds the tree when a commit’s files actually change', async () => {
    const wrapper = mountList();
    await toggleCommit(wrapper, 0);

    const checkbox = row(wrapper, 0, 'src/a.ts').find('.node-checkbox');
    (checkbox.element as HTMLInputElement).checked = true;
    await checkbox.trigger('change');

    // A refresh that replaces the commit's files is a real content change, so
    // stale selection state must not survive it.
    const refresh = commits();
    refresh[0].files = [{ filename: 'src/z.ts', status: 'modified' }] as never;
    await wrapper.setProps({ commits: refresh });
    await nextTick();

    expect(hasRow(wrapper, 0, 'src/z.ts')).toBe(true);
    expect((row(wrapper, 0, 'src/z.ts').find('.node-checkbox').element as HTMLInputElement).checked).toBe(false);
    wrapper.unmount();
  });
});
