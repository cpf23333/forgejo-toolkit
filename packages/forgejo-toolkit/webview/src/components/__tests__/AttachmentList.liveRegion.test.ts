import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import AttachmentList from '../AttachmentList.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

type Props = InstanceType<typeof AttachmentList>['$props'];

function mountList(props: Props) {
  return mount(AttachmentList, {
    props,
    global: { plugins: [createTestI18n('en')] },
  });
}

/**
 * The "could not be loaded" notice was the `role="status"` region, and its text
 * was rendered with it — the case an assistive technology is allowed to miss,
 * because it has to observe the region before the content changes. The text is
 * now held back for one render, so the region is in the document, empty, before
 * the announcement is put into it. No wrapper element is added for this: the
 * notice itself is the region (the views that render many of these sections have
 * a DOM budget test).
 */
describe('AttachmentList failed-lookup announcement', () => {
  it('adds no live region when there is nothing to announce', () => {
    const wrapper = mountList({ assets: [], allowUpload: true, attachmentsUnavailable: false });

    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.find('.attachment-unavailable').exists()).toBe(false);

    wrapper.unmount();
  });

  it('renders the region empty first and fills it on the next render', async () => {
    const wrapper = mountList({ assets: [], attachmentsUnavailable: true });

    // The first render already carries the failure, but not its text: the region
    // has to be in the document before the announcement is put into it.
    const region = wrapper.get('.attachment-unavailable');
    expect(region.attributes('role')).toBe('status');
    expect(region.attributes('aria-live')).toBe('polite');
    expect(region.text()).toBe('');

    await nextTick();
    expect(wrapper.get('.attachment-unavailable').text()).toContain('could not be loaded');

    wrapper.unmount();
  });

  it('announces a failure that lands after the list was rendered', async () => {
    const wrapper = mountList({ assets: [], allowUpload: true, attachmentsUnavailable: false });

    await wrapper.setProps({ attachmentsUnavailable: true });
    await nextTick();

    // The region came in empty with the failure; the sentence followed it.
    expect(wrapper.get('.attachment-unavailable').text()).toContain('could not be loaded');

    wrapper.unmount();
  });

  it('keeps the region while the failure is shown and drops it afterwards', async () => {
    const wrapper = mountList({ assets: [], attachmentsUnavailable: true });
    await nextTick();
    expect(wrapper.get('.attachment-unavailable').text()).toContain('could not be loaded');

    // The attachments load successfully after all: the notice goes away with the
    // failure, and it is not announced again.
    await wrapper.setProps({ attachmentsUnavailable: false, assets: [{ id: 1, name: 'shot.png' }] });
    await nextTick();

    expect(wrapper.find('.attachment-unavailable').exists()).toBe(false);
    expect(wrapper.get('.attachment-list').text()).toContain('shot.png');

    wrapper.unmount();
  });
});
