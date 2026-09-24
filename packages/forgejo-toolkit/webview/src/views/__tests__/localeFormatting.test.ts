import { describe, it, expect, vi, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import Notifications from '../Notifications.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';
import { localeTag } from '../../i18n';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Dates and numbers used to be formatted by `toLocaleString()` with no locale,
 * which means "whatever the host browser runs in": a Chinese UI on an en-US
 * system showed US-ordered dates. The same locale now also drives the document
 * language, which is what screen readers pick their language rules from.
 */
describe('locale plumbing', () => {
  it('maps the app locales to BCP-47 tags', () => {
    expect(localeTag('zh')).toBe('zh-CN');
    expect(localeTag('en')).toBe('en');
  });

  it('formats dates with the app locale instead of the browser default', async () => {
    const toLocaleString = vi.spyOn(Date.prototype, 'toLocaleString');

    const wrapper = mount(Notifications, {
      global: { plugins: [createTestRouter(), createTestI18n('en')] },
    });

    const state = useAppState() as unknown as {
      changeLocale: (locale: 'en' | 'zh') => void;
      instances: { value: Array<Record<string, unknown>> };
      notifications: { value: Map<string, unknown[]> };
    };
    state.instances.value = [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }];
    state.notifications.value.set('inst-1:notifications', [
      {
        id: 1,
        unread: true,
        updated_at: '2026-09-20T12:00:00Z',
        subject: { title: 'Mention', type: 'Issue' },
      },
    ]);
    await flushPromises();

    state.changeLocale('zh');
    await flushPromises();

    // The view formats its timestamps with the locale the app exposes.
    expect(toLocaleString).toHaveBeenCalledWith('zh');

    // …and the document language follows it, for screen readers and the browser.
    expect(document.documentElement.lang).toBe('zh-CN');

    state.changeLocale('en');
    await flushPromises();
    expect(document.documentElement.lang).toBe('en');

    wrapper.unmount();
  });
});
