import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

/**
 * The status region of this view is rendered from the first paint, empty, so the
 * first message has a live region to land in (a region that appears together with
 * its text is one assistive technology is allowed to miss — see
 * `ConnectionStatus.liveRegion.test.ts`). Being always there made it a permanent
 * painted band: an empty `.status` still drew its `padding: 8px 12px` and its
 * background colour between the section header and the first row, which reads as
 * a stray strip or a loading placeholder.
 *
 * The visible band is removed by `:empty`, which means the region must really be
 * `:empty` while it holds no message. That is the part a unit test can prove: the
 * DOM this view renders has no child node at all in that state, so the selector
 * matches. What it cannot prove — jsdom computes no cascade and lays nothing out
 * — is that the rule then paints nothing and takes no room; those are properties
 * of the real panel (measured there: 0x0 px and transparent while empty, the full
 * band back the moment a message lands).
 *
 * The stylesheet is read through Vite's glob: the webview tests run without Node
 * types, so `node:fs` is not available here (same approach as
 * `Settings.savedListLayout.test.ts`).
 */
const sources = import.meta.glob('../Settings.vue', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const settingsSource = Object.values(sources)[0] ?? '';

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\n)\\s*${escaped}\\s*(,[\\s\\S]*?)?\\{([^}]*)\\}`).exec(settingsSource);
  expect(match, `styles for ${selector}`).toBeTruthy();
  return match![3];
}

/**
 * The `.status` rule that draws the band — the region's own rule, not the shared
 * prose rule, which lists `.status` as one of its selectors and comes first.
 */
function bandRule(): string {
  for (const rule of settingsSource.matchAll(/(^|\n)\s*\.status\s*\{([^}]*)\}/g)) {
    if (rule[2].includes('padding:')) return rule[2];
  }
  throw new Error('no .status rule carrying the band');
}

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

async function mountSettings(): Promise<VueWrapper> {
  const wrapper = mount((await import('../Settings.vue')).default, {
    global: { plugins: [createTestRouter(), createTestI18n('en')] },
  });
  await flushPromises();
  return wrapper;
}

describe('Settings status region paints nothing while it is empty', () => {
  it('collapses the empty region instead of hiding it', () => {
    const empty = ruleBody('.status:empty');
    // No band: the padding and the background are what painted it.
    expect(empty).toContain('padding: 0');
    expect(empty).toContain('background-color: transparent');
    expect(empty).toContain('border-radius: 0');
    // Out of the section's flex flow as well, so the two row gaps it would add
    // between the header and the first row collapse with it.
    expect(empty).toContain('position: absolute');
    // The region has to stay rendered and stay in the accessibility tree:
    // `display: none` (or `v-if`) is the same "text and region appear together"
    // defect the always-present region exists to avoid.
    expect(empty).not.toContain('display: none');
    // Both regions — the list's and the editor's — are unconditional.
    const regions = settingsSource.match(/<div :class="\['status', statusType\]"[^>]*>/g) ?? [];
    expect(regions).toHaveLength(2);
    for (const opening of regions) expect(opening).not.toContain('v-if');
  });

  it('brings the band back with the first message', () => {
    // The message state is the region's own rule, which the `:empty` rule cannot
    // reach once the region holds text.
    const band = bandRule();
    expect(band).toContain('padding: 8px 12px');
    expect(band).toMatch(/background-color:\s*var\(--vscode-/);
  });

  it('is empty in the DOM the list state renders', async () => {
    const wrapper = await mountSettings();

    const region = wrapper.get('.settings-list [role="status"]');
    expect(region.attributes('aria-live')).toBe('polite');
    expect(region.text()).toBe('');
    // What `:empty` keys off, on the markup this view really renders: Vue writes
    // the interpolation with `textContent`, so an empty status leaves no text
    // node (and no comment anchor) behind. Were a child node ever left here, the
    // rule would stop matching and this assertion is where that shows up.
    expect(region.element.childNodes).toHaveLength(0);
    expect(region.element.matches(':empty')).toBe(true);

    wrapper.unmount();
  });

  it('is empty in the DOM the editor state renders', async () => {
    const wrapper = await mountSettings();
    const addInstance = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === 'Add Instance');
    await addInstance!.trigger('click');
    await nextTick();

    const region = wrapper.get('.instance-editor [role="status"]');
    expect(region.text()).toBe('');
    expect(region.element.childNodes).toHaveLength(0);
    expect(region.element.matches(':empty')).toBe(true);

    wrapper.unmount();
  });

  it('stops matching :empty as soon as the outcome lands', async () => {
    const wrapper = await mountSettings();
    const addInstance = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === 'Add Instance');
    await addInstance!.trigger('click');
    await nextTick();
    const region = wrapper.get('.instance-editor [role="status"]').element;

    // The form has to be submitted for the host's reply to be applied at all (an
    // unstamped reply for no submitted form is dropped), and the in-flight state
    // is already a message.
    const field = (selector: string, value: string) => {
      const input = wrapper.find(selector);
      (input.element as unknown as { value: string }).value = value;
      return input.trigger('input');
    };
    await field('#forgejo-url', 'https://forgejo.example.com');
    await field('#forgejo-token', 'tok');
    const test = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === 'Test Connection');
    await test!.trigger('click');
    await nextTick();

    // Same element, now carrying a message: the band is drawn again.
    expect(wrapper.get('.instance-editor [role="status"]').element).toBe(region);
    expect(region.matches(':empty')).toBe(false);
    expect(region.textContent).toBe('Testing connection...');

    dispatchMessage({ command: 'testConnectionResult', success: true, username: 'demo-user' });
    await nextTick();
    expect(region.matches(':empty')).toBe(false);
    expect(region.textContent).toBe('Connection OK. Username: demo-user');

    wrapper.unmount();
  });
});
