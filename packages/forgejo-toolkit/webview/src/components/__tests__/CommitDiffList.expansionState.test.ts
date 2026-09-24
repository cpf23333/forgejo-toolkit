import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import CommitDiffList from '../CommitDiffList.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';
import type { ForgejoPullRequestCommit } from '../../types/api';

function commits(): ForgejoPullRequestCommit[] {
  return [
    {
      sha: 'aaaaaaa1',
      commit: { message: 'first commit' },
      files: [{ filename: 'src/a.ts', status: 'modified' }],
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

/**
 * The commit header expands and collapses its file list, but the state was
 * carried by the ▼/▶ glyph alone — a screen reader announced a plain text row
 * and could not tell whether the files were shown. The header is now a button
 * that reports its expansion, and it names the container it controls.
 */
describe('CommitDiffList commit header expansion state', () => {
  it('reports itself as a collapsed button that controls its file list', async () => {
    const wrapper = mountList();

    const header = wrapper.get('.commit-header');
    expect(header.attributes('role')).toBe('button');
    expect(header.attributes('tabindex')).toBe('0');
    expect(header.attributes('aria-expanded')).toBe('false');

    const controls = header.attributes('aria-controls');
    expect(controls).toBeTruthy();
    // The controlled container is not rendered while collapsed; its id is the
    // one the header points at.
    expect(wrapper.find(`#${controls}`).exists()).toBe(false);

    wrapper.unmount();
  });

  it('flips aria-expanded to true once the files are shown', async () => {
    const wrapper = mountList();

    const header = wrapper.get('.commit-header');
    const controls = header.attributes('aria-controls')!;
    await header.trigger('click');
    await nextTick();

    expect(wrapper.get('.commit-header').attributes('aria-expanded')).toBe('true');
    // The header now points at a container that is really rendered.
    expect(wrapper.get(`#${controls}`).text()).toContain('a.ts');

    await wrapper.get('.commit-header').trigger('keydown', { key: 'Enter' });
    await nextTick();

    expect(wrapper.get('.commit-header').attributes('aria-expanded')).toBe('false');
    wrapper.unmount();
  });

  it('gives every commit its own controlled container', async () => {
    const wrapper = mountList();

    for (const header of wrapper.findAll('.commit-header')) {
      await header.trigger('click');
      await nextTick();
    }

    const ids = wrapper.findAll('.commit-header').map((header) => header.attributes('aria-controls'));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(wrapper.find(`#${id}`).exists()).toBe(true);
    }

    wrapper.unmount();
  });
});
