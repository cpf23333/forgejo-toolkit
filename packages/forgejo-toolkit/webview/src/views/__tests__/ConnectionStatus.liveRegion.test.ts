import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, type Component } from 'vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

let messageHandlers: Array<(event: MessageEvent) => void> = [];

beforeEach(() => {
  // Each test gets its own module graph: the composable subscribes to
  // `window.message` when its module is first initialised, so a cached module
  // would leave every test after the first without a listener.
  vi.resetModules();
  messageHandlers = [];
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'message') {
      messageHandlers.push(listener as (event: MessageEvent) => void);
    }
  });
});

afterEach(() => {
  messageHandlers = [];
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function dispatchMessage(message: unknown) {
  const event = new MessageEvent('message', { data: message });
  messageHandlers.forEach((handler) => handler(event));
}

/**
 * One view, wired to the real composable exactly like the shell wires it: the
 * composable subscribes to `window.message`, so the host's reply is delivered
 * the way the real one is.
 */
async function mountView(component: Component): Promise<VueWrapper> {
  const wrapper = mount(component, {
    global: { plugins: [createTestRouter(), createTestI18n('en')] },
  });
  await flushPromises();
  return wrapper;
}

function buttonByLabel(wrapper: VueWrapper, label: string) {
  const button = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === label);
  expect(button, `button "${label}"`).toBeTruthy();
  return button!;
}

async function typeInto(wrapper: VueWrapper, selector: string, value: string) {
  const field = wrapper.find(selector);
  (field.element as unknown as { value: string }).value = value;
  await field.trigger('input');
}

async function openSettings(): Promise<VueWrapper> {
  return mountView((await import('../Settings.vue')).default);
}

async function openServerStep(): Promise<VueWrapper> {
  const wrapper = await mountView((await import('../Onboarding.vue')).default);
  await nextTick();
  await buttonByLabel(wrapper, 'Next').trigger('click');
  await nextTick();
  return wrapper;
}

/**
 * The Test/Save outcome was plain coloured text in a `v-if="status"` element:
 * the region appeared at the same moment its content did, which is the case an
 * assistive technology is allowed to miss, and the result of an async round trip
 * was therefore never announced. It is now a polite live region that is in the
 * document from the first render and only changes its text.
 *
 * No separate label key is needed: `role="status"` is a live region, not a named
 * landmark, and the project's other status regions carry no label either (the
 * attachment and import notices, and `App.vue`'s view announcement, which names
 * itself with the view's own title).
 */
describe('Settings Test/Save outcome is a polite live region', () => {
  it('keeps the region in the document, empty, before anything has been tested', async () => {
    const wrapper = await openSettings();

    const regions = wrapper.findAll('.status');
    expect(regions.length).toBeGreaterThanOrEqual(1);
    expect(regions[0].attributes('role')).toBe('status');
    expect(regions[0].attributes('aria-live')).toBe('polite');
    expect(regions[0].text()).toBe('');

    wrapper.unmount();
  });

  it('fills the same region with the async success', async () => {
    const wrapper = await openSettings();
    const region = wrapper.get('.status').element;

    await typeInto(wrapper, '#forgejo-url', 'https://forgejo.example.com');
    await typeInto(wrapper, '#forgejo-token', 'tok');
    await buttonByLabel(wrapper, 'Test Connection').trigger('click');
    await nextTick();
    expect(wrapper.get('.status').text()).toBe('Testing connection...');

    // The host answers: the outcome lands in the region that was already there.
    dispatchMessage({ command: 'testConnectionResult', success: true, username: 'demo-user' });
    await nextTick();

    expect(wrapper.get('.status').element).toBe(region);
    expect(wrapper.get('.status').text()).toBe('Connection OK. Username: demo-user');

    wrapper.unmount();
  });

  it('fills the same region with the async failure', async () => {
    const wrapper = await openSettings();
    const region = wrapper.get('.status').element;

    await typeInto(wrapper, '#forgejo-url', 'https://forgejo.example.com');
    await typeInto(wrapper, '#forgejo-token', 'tok');
    await buttonByLabel(wrapper, 'Test Connection').trigger('click');
    await nextTick();

    dispatchMessage({ command: 'testConnectionResult', success: false, error: 'Incorrect password or corrupted file' });
    await nextTick();

    expect(wrapper.get('.status').element).toBe(region);
    expect(wrapper.get('.status').text()).toBe('Incorrect password or corrupted file');
    expect(wrapper.get('.status').classes()).toContain('error');

    wrapper.unmount();
  });
});

/**
 * The setup guide's connection status is the same shape and had the same defect:
 * `v-if="connectionStatus"` meant the sentence arrived together with the region.
 */
describe('Onboarding connection outcome is a polite live region', () => {
  it('keeps the region in the document, empty, before anything has been tested', async () => {
    const wrapper = await openServerStep();

    const regions = wrapper.findAll('.status');
    expect(regions.length).toBeGreaterThanOrEqual(1);
    expect(regions[0].attributes('role')).toBe('status');
    expect(regions[0].attributes('aria-live')).toBe('polite');
    expect(regions[0].text()).toBe('');

    wrapper.unmount();
  });

  it('fills the same region with the async success', async () => {
    const wrapper = await openServerStep();
    const region = wrapper.get('.status').element;

    await typeInto(wrapper, '#onboarding-url', 'https://forgejo.example.com');
    await typeInto(wrapper, '#onboarding-token', 'tok');
    await buttonByLabel(wrapper, 'Test Connection').trigger('click');
    await nextTick();

    dispatchMessage({ command: 'testConnectionResult', success: true, username: 'demo-user' });
    await nextTick();

    expect(wrapper.get('.status').element).toBe(region);
    expect(wrapper.get('.status').text()).toBe('Connection OK. Username: demo-user');

    wrapper.unmount();
  });
});
