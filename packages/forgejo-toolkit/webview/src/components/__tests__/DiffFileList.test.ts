import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import DiffFileList from '../DiffFileList.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

function mountList(props: Record<string, unknown> = {}) {
  return mount(DiffFileList, {
    props: { files: [], ...props },
    global: { plugins: [createTestI18n('en')] },
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
