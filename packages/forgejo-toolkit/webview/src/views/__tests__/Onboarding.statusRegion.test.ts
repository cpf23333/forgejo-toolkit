import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

/**
 * The setup guide's server step renders its connection/save outcome into a
 * `.status` region that is in the document from the first paint, empty, so the
 * first message has a live region to land in (a region that appears together
 * with its text is one assistive technology is allowed to miss — see
 * `ConnectionStatus.liveRegion.test.ts`). Being always there made it a permanent
 * painted band: an empty `.status` still drew its `padding: 8px 12px`, its
 * `border-radius: 4px` and its background, which is the full-width empty strip
 * the maintainer saw between the Test/Add buttons and the Previous/Next row.
 *
 * That is the same defect `Settings.vue` fixed with `.status:empty`, and the fix
 * has to be repeated here because scoped styles do not reach across components:
 * this view carries its own copy of the `.status` band, so it needs its own copy
 * of the rule that collapses it. `Settings.statusRegion.test.ts` is the other
 * half of that pair and asserts the same declarations.
 *
 * The visible band is removed by `:empty`, which means the region must really be
 * `:empty` while it holds no message. That is the part a unit test can prove: the
 * DOM this view renders has no child node at all in that state, so the selector
 * matches. What it cannot prove — jsdom computes no cascade and lays nothing out
 * — is that the rule then paints nothing and takes no room; those are properties
 * of the real panel (measured in a browser on this view's own stylesheet at a
 * 600 px column: 600x16 px, opaque `--vscode-editor-inactiveSelectionBackground`
 * while empty, 0x0 px and transparent under the rule, and the full 600x36 px band
 * back the moment a message landed).
 *
 * The stylesheet is read through Vite's glob: the webview tests run without Node
 * types, so `node:fs` is not available here (same approach as
 * `Settings.statusRegion.test.ts` and `Settings.savedListLayout.test.ts`).
 */
const sources = import.meta.glob('../Onboarding.vue', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const onboardingSource = Object.values(sources)[0] ?? '';

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\n)\\s*${escaped}\\s*(,[\\s\\S]*?)?\\{([^}]*)\\}`).exec(onboardingSource);
  expect(match, `styles for ${selector}`).toBeTruthy();
  return match![3];
}

/** The `.status` rule that draws the band — the region's own rule. */
function bandRule(): string {
  for (const rule of onboardingSource.matchAll(/(^|\n)\s*\.status\s*\{([^}]*)\}/g)) {
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

function buttonByLabel(wrapper: VueWrapper, label: string) {
  const button = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === label);
  expect(button, `button "${label}"`).toBeTruthy();
  return button!;
}

/** Step 1 is the server step; the region only exists there. */
async function openServerStep(): Promise<VueWrapper> {
  const wrapper = mount((await import('../Onboarding.vue')).default, {
    global: { plugins: [createTestRouter(), createTestI18n('en')] },
  });
  await flushPromises();
  await buttonByLabel(wrapper, 'Next').trigger('click');
  await nextTick();
  return wrapper;
}

describe('Onboarding status region paints nothing while it is empty', () => {
  it('collapses the empty region instead of hiding it', () => {
    const empty = ruleBody('.status:empty');
    // No band: the padding, the background and the radius are what painted it.
    expect(empty).toContain('padding: 0');
    expect(empty).toContain('background-color: transparent');
    expect(empty).toContain('border-radius: 0');
    // Out of the section's flow as well, so the 16 px it would add above the
    // Previous/Next row collapses with it.
    expect(empty).toContain('position: absolute');
    // The region has to stay rendered and stay in the accessibility tree:
    // `display: none` (or `v-if`) is the same "text and region appear together"
    // defect the always-present region exists to avoid.
    expect(empty).not.toContain('display: none');
    // The region itself is unconditional. The other `.status` on this view (the
    // import failure, `class="status error"`) is a `v-if` alert, not this region.
    const regions = onboardingSource.match(/<div :class="\['status', connectionStatusType\]"[^>]*>/g) ?? [];
    expect(regions).toHaveLength(1);
    expect(regions[0]).not.toContain('v-if');
  });

  it('brings the band back with the first message', () => {
    // The message state is the region's own rule, which the `:empty` rule cannot
    // reach once the region holds text.
    const band = bandRule();
    expect(band).toContain('padding: 8px 12px');
    expect(band).toContain('border-radius: 4px');
    expect(band).toMatch(/background-color:\s*var\(--vscode-/);
  });

  it('is empty in the DOM the server step renders', async () => {
    const wrapper = await openServerStep();

    const region = wrapper.get('.status');
    expect(region.attributes('role')).toBe('status');
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

  it('renders that region between the Test/Add buttons and the step navigation', async () => {
    // Where the band was seen: below `.actions`, above `.step-actions`. The rule
    // above is only the right fix for the strip the maintainer reported as long
    // as this is the element that sits in that gap.
    const wrapper = await openServerStep();
    const section = wrapper.get('.step-content section').element;
    const region = wrapper.get('.status').element;

    expect(section.lastElementChild).toBe(region);
    const order = [...wrapper.get('.onboarding').element.querySelectorAll('.actions, .status, .step-actions')];
    expect(order.map((element) => element.className)).toEqual(['actions', 'status idle', 'step-actions']);

    wrapper.unmount();
  });

  it('stops matching :empty as soon as the outcome lands', async () => {
    const wrapper = await openServerStep();
    const region = wrapper.get('.status').element;

    const field = (selector: string, value: string) => {
      const input = wrapper.find(selector);
      (input.element as unknown as { value: string }).value = value;
      return input.trigger('input');
    };
    await field('#onboarding-url', 'https://forgejo.example.com');
    await field('#onboarding-token', 'tok');
    await buttonByLabel(wrapper, 'Test Connection').trigger('click');
    await nextTick();

    // Same element, now carrying a message: the band is drawn again.
    expect(wrapper.get('.status').element).toBe(region);
    expect(region.matches(':empty')).toBe(false);
    expect(region.textContent).toBe('Testing connection...');

    wrapper.unmount();
  });
});
