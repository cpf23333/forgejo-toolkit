import { describe, it, expect } from 'vitest';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import DiffFileList from '../DiffFileList.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

function mountList(props: Record<string, unknown> = {}, options: { attachTo?: HTMLElement } = {}) {
  return mount(DiffFileList, {
    props: { files: [], ...props },
    global: { plugins: [createTestI18n('en')] },
    ...options,
  });
}

// The three load-state branches must stay mutually exclusive in this order:
// loading > error > empty. The PR detail view relies on this to tell a failed
// changed-files fetch apart from a genuinely empty list (both would otherwise
// render the same "No changed files" text).
describe('DiffFileList load-state branches', () => {
  it('shows the error instead of the empty-list text when the fetch failed', () => {
    const wrapper = mountList({ error: 'boom' });

    expect(wrapper.find('.error').exists()).toBe(true);
    expect(wrapper.text()).toContain('boom');
    expect(wrapper.find('.empty').exists()).toBe(false);
  });

  it('shows the empty-list text only when there is no error and no files', () => {
    const wrapper = mountList();

    expect(wrapper.find('.empty').exists()).toBe(true);
    expect(wrapper.find('.error').exists()).toBe(false);
    expect(wrapper.find('.loading').exists()).toBe(false);
  });

  it('shows the loading indicator while files are being fetched', () => {
    const wrapper = mountList({ loading: true });

    expect(wrapper.find('.loading').exists()).toBe(true);
    expect(wrapper.find('.empty').exists()).toBe(false);
    expect(wrapper.find('.error').exists()).toBe(false);
  });
});

describe('DiffFileList truncation notice', () => {
  it('says when the file list was cut off at the cap', () => {
    const file = (i: number) => ({
      filename: `src/file-${i}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      changes: 1,
    });

    const capped = mountList({ files: Array.from({ length: 500 }, (_, i) => file(i)) });
    expect(capped.find('.list-truncated').exists()).toBe(true);

    const below = mountList({ files: Array.from({ length: 499 }, (_, i) => file(i)) });
    expect(below.find('.list-truncated').exists()).toBe(false);
  }, 15_000); // (same 15 s precedent as useAppState.test.ts). // Mounting ~1000 tree rows can exceed the 5 s default on a loaded runner
});

/**
 * The tree is a keyboard widget: every row used to be a tab stop, so a large
 * diff took one Tab press per file. It follows the conventional roving-tabindex
 * pattern instead — one tab stop for the whole tree, arrow keys to move — which
 * is what these tests pin down.
 */
describe('DiffFileList tree keyboard navigation', () => {
  // Flat names, so the tree has exactly one row per file.
  const threeFiles = [
    { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 },
    { filename: 'b.ts', status: 'added', additions: 2, deletions: 0, changes: 2 },
    { filename: 'c.ts', status: 'removed', additions: 0, deletions: 3, changes: 3 },
  ];

  function mountTree(files: Record<string, unknown>[] = threeFiles) {
    // Focus assertions need the component connected to the document.
    return mountList({ files, supportsMultiDiff: true }, { attachTo: document.body });
  }

  function rowByPath(wrapper: ReturnType<typeof mountTree>, path: string) {
    // Queried through the DOM: `wrapper.findAll` does not descend into the
    // recursively rendered child components, so nested rows are invisible to it.
    // The path is matched as an attribute rather than interpolated into the
    // selector, which a path like `src/a.ts` is not valid for.
    const row = findRow(wrapper, path);
    expect(row, `row ${path}`).toBeTruthy();
    return new DOMWrapper(row!);
  }

  /** Whether a row for `path` is rendered (a collapsed subtree renders none). */
  function hasRow(wrapper: ReturnType<typeof mountTree>, path: string): boolean {
    return findRow(wrapper, path) !== undefined;
  }

  function findRow(wrapper: ReturnType<typeof mountTree>, path: string): Element | undefined {
    return [...wrapper.element.querySelectorAll('.tree-row')].find(
      (candidate) => candidate.getAttribute('data-path') === path,
    );
  }

  /** The toolbar's "Collapse all" button (it has no class of its own). */
  async function collapseAll(wrapper: ReturnType<typeof mountTree>) {
    const button = wrapper.findAll('button').find((candidate) => candidate.text().trim() === 'Collapse all');
    expect(button, 'Collapse all button').toBeTruthy();
    await button!.trigger('click');
  }

  /**
   * The `<li>` carrying the treeitem role for the row at `path`. `data-path`
   * lives on the row (`<div>`), which is also what the roving tabindex and the
   * focus logic address. The ancestor `<li>`s of a nested path match the same
   * selector, so the deepest level wins.
   */
  function dirItem(wrapper: ReturnType<typeof mountTree>, path: string) {
    // Same DOM lookup as `rowByPath`, then its own `<li>`: the ancestor `<li>`s
    // of a nested path match too, so the deepest tier wins.
    const row = findRow(wrapper, path);
    expect(row, `row ${path}`).toBeTruthy();
    const tiers = [...wrapper.element.querySelectorAll('li.tree-node')]
      .filter((candidate) => candidate.contains(row!))
      .map((candidate) => new DOMWrapper<Element>(candidate));
    expect(tiers.length, `treeitem for ${path}`).toBeGreaterThan(0);
    return tiers.reduce((deepest, candidate) =>
      Number(candidate.attributes('aria-level') ?? 0) > Number(deepest.attributes('aria-level') ?? 0)
        ? candidate
        : deepest,
    );
  }

  it('keeps a single tab stop for the whole tree', async () => {
    const wrapper = mountTree();
    await nextTick();

    const rows = wrapper.findAll('.tree-row');
    expect(rows).toHaveLength(3);

    const tabbable = rows.filter((row) => row.attributes('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(rows.filter((row) => row.attributes('tabindex') === '-1')).toHaveLength(rows.length - 1);

    // One tab stop means the whole tree, not just its rows: every focusable
    // element inside it is counted, so a row checkbox that stays focusable
    // fails this even though the roving tabindex on the rows looks right.
    const tabStops = wrapper
      .get('.file-tree')
      .findAll('*')
      .filter((node) => node.attributes('tabindex') !== '-1' && node.attributes('tabindex') !== undefined);
    expect(tabStops.map((node) => node.attributes('tabindex'))).toEqual(['0']);
    expect(wrapper.get('.node-checkbox').attributes('tabindex')).toBe('-1');
    wrapper.unmount();
  });

  it('toggles the focused row with Space and opens it with Enter', async () => {
    const wrapper = mountTree();
    await nextTick();

    const checkboxOf = (path: string) => rowByPath(wrapper, path).find('.node-checkbox');
    const first = rowByPath(wrapper, 'a.ts');
    expect((checkboxOf('a.ts').element as HTMLInputElement).checked).toBe(false);

    // Space is the row's selection key: the checkbox it stands for is not a tab
    // stop, so the row is the only way to reach it from the keyboard.
    await first.trigger('keydown', { key: ' ' });
    await nextTick();
    expect((checkboxOf('a.ts').element as HTMLInputElement).checked).toBe(true);

    await first.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('openDiff')?.[0]).toEqual(['a.ts', 'modified', undefined]);

    // Space must not open the diff as well.
    expect(wrapper.emitted('openDiff')).toHaveLength(1);
    wrapper.unmount();
  });

  it('moves focus with the arrow keys and opens the focused file', async () => {
    const wrapper = mountTree();
    await nextTick();

    const tree = wrapper.get('.file-tree');
    await tree.trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();

    expect(document.activeElement?.getAttribute('data-path')).toBe('b.ts');
    expect(rowByPath(wrapper, 'b.ts').attributes('tabindex')).toBe('0');
    expect(rowByPath(wrapper, 'a.ts').attributes('tabindex')).toBe('-1');

    await tree.trigger('keydown', { key: 'ArrowUp' });
    await flushPromises();
    expect(document.activeElement?.getAttribute('data-path')).toBe('a.ts');

    await rowByPath(wrapper, 'a.ts').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('openDiff')?.[0]).toEqual(['a.ts', 'modified', undefined]);
    wrapper.unmount();
  });

  it('names each file checkbox after the file it selects', async () => {
    const wrapper = mountTree();
    await nextTick();

    const labels = wrapper.findAll('.node-checkbox').map((box) => box.attributes('aria-label'));
    expect(labels).toEqual(['Select a.ts (modified)', 'Select b.ts (added)', 'Select c.ts (removed)']);
    wrapper.unmount();
  });

  /**
   * A collapsed directory used to swallow ArrowRight: the row's keydown handler
   * returns for arrow keys on purpose (the tree owner resolves them) and the
   * owner only stepped into directories it believed were already expanded.
   */
  it('expands a collapsed directory with ArrowRight, then steps into it', async () => {
    const wrapper = mountTree([
      { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 },
      { filename: 'src/b.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 },
    ]);
    await nextTick();

    const tree = wrapper.get('.file-tree');
    // The toolbar's collapse-all leaves the directory row collapsed without
    // toggling it through the keyboard, which is the state under test.
    await collapseAll(wrapper);
    await nextTick();
    expect(dirItem(wrapper, 'src').attributes('aria-expanded')).toBe('false');
    expect(hasRow(wrapper, 'src/a.ts')).toBe(false);

    // ArrowRight on the collapsed directory expands it (the treeitem contract).
    await rowByPath(wrapper, 'src').trigger('keydown', { key: 'ArrowRight' });
    await nextTick();

    expect(dirItem(wrapper, 'src').attributes('aria-expanded')).toBe('true');
    expect(hasRow(wrapper, 'src/a.ts')).toBe(true);

    // A second ArrowRight steps into the first child.
    await tree.trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(document.activeElement?.getAttribute('data-path')).toBe('src/a.ts');
    wrapper.unmount();
  });

  it('exposes the treeitem structure the ARIA tree pattern requires', async () => {
    const wrapper = mountTree([
      { filename: 'src/nested/a.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 },
    ]);
    await nextTick();

    // Collapse the tree first, so the nested group below is one this test opened.
    await collapseAll(wrapper);
    await nextTick();

    const dir = dirItem(wrapper, 'src');
    expect(dir.attributes('role')).toBe('treeitem');
    expect(dir.attributes('aria-level')).toBe('1');
    expect(dir.attributes('aria-expanded')).toBe('false');
    // The row itself is not a treeitem: `li > div[role=treeitem]` is invalid.
    expect(wrapper.get('.tree-row[data-path="src"]').attributes('role')).toBeUndefined();

    await rowByPath(wrapper, 'src').trigger('keydown', { key: 'Enter' });
    await nextTick();

    // The nested list is the children's group, and the child row carries level 2.
    const group = dirItem(wrapper, 'src').get('ul');
    expect(group.attributes('role')).toBe('group');
    const child = dirItem(wrapper, 'src/nested');
    expect(child.attributes('role')).toBe('treeitem');
    // `src` is level 1 and `src/nested` its child, so the nested treeitem is
    // level 2: `role="group"` must not add a level of its own.
    expect(child.attributes('aria-level')).toBe('2');
    wrapper.unmount();
  });
});
