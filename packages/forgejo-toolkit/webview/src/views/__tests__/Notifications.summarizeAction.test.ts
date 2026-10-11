import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import Notifications from '../Notifications.vue';
import { vscode } from '../../composables/vscode';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

/**
 * The "summarize the discussion" action on a notification row
 * (`docs/design/notification-summary.md` §2, §6, §8, §9).
 *
 * Two gates, and this file is where both are observable:
 *
 * - the action exists **only** on issue and pull notifications — never on a
 *   repository, commit or release one — and only when the row names an entity the
 *   host can be asked about;
 * - it is hidden entirely while `forgejoToolkit.notificationSummary` is off, which
 *   the webview learns from the host (a missing value reads as off).
 *
 * Pressing it sends the coordinates and the subject type and nothing else: no
 * model, no scope, no prompt, no timeline. Everything after that is host-side.
 */

let messageHandlers: Array<(event: MessageEvent) => void> = [];
let listenerInstalled = false;

const postMessageMock = vscode.postMessage as unknown as {
  mock: { calls: Array<[Record<string, unknown>]> };
  mockClear: () => void;
};

function postedMessages(): Array<Record<string, unknown>> {
  return postMessageMock.mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  postMessageMock.mockClear();
  if (!listenerInstalled) {
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
      if (type === 'message') {
        messageHandlers.push(listener as (event: MessageEvent) => void);
      }
    });
    listenerInstalled = true;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function dispatchMessage(message: unknown) {
  const event = new MessageEvent('message', { data: message });
  messageHandlers.forEach((handler) => handler(event));
}

/**
 * Renders the view with the host's reading of the feature switch.
 *
 * `notificationSummary` is passed through as given so a test can state all three
 * readings the host can send: `true`, `false`, and the field's **absence** (an
 * older host build), which has to behave exactly like `false`.
 */
async function renderNotifications(
  notifications: Array<Record<string, unknown>>,
  options: { notificationSummary?: boolean | undefined } = {},
) {
  const wrapper = mount(Notifications, {
    global: { plugins: [createTestRouter(), createTestI18n('en')] },
  });
  dispatchMessage({
    command: 'initialState',
    instances: [{ id: 'inst-1', url: 'https://forgejo.example.com' }],
    locale: 'en',
    ...(options.notificationSummary === undefined ? {} : { notificationSummary: options.notificationSummary }),
  });
  dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications });
  await flushPromises();
  return wrapper;
}

function issueNotification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    unread: true,
    repository: { full_name: 'demo-user/demo-repo' },
    subject: {
      type: 'Issue',
      title: 'Crash on startup',
      html_url: 'https://forgejo.example.com/demo-user/demo-repo/issues/42',
    },
    ...overrides,
  };
}

function pullNotification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return issueNotification({
    id: 2,
    subject: {
      type: 'PullRequest',
      title: 'Retry the request',
      html_url: 'https://forgejo.example.com/demo-user/demo-repo/pulls/7',
    },
    ...overrides,
  });
}

/** The action button inside a row, found by its accessible name. */
function summarizeAction(wrapper: Awaited<ReturnType<typeof renderNotifications>>) {
  return wrapper
    .findAll('.icon-action-button')
    .find((button) => button.attributes('aria-label') === 'Summarize discussion');
}

describe('Notifications summarize action', () => {
  it('appears on an issue notification and asks the host for that entity', async () => {
    const wrapper = await renderNotifications([issueNotification()], { notificationSummary: true });

    const action = summarizeAction(wrapper);
    expect(action).toBeTruthy();
    expect(action!.attributes('title')).toBe('Summarize discussion');

    // Only the click's own traffic: the view's mount-time list reads are dropped so
    // the count below is about the action alone.
    postMessageMock.mockClear();
    await action!.trigger('click');

    expect(postedMessages()).toContainEqual({
      command: 'notificationSummary',
      instanceId: 'inst-1',
      owner: 'demo-user',
      repo: 'demo-repo',
      index: 42,
      type: 'issue',
    });
    // The identity and nothing else: no timeline read, no model, no scope, no
    // prompt. The host owns every step after the click (§4, §5).
    expect(postedMessages()).toHaveLength(1);
    wrapper.unmount();
  });

  it('appears on a pull notification and reports it as a pull', async () => {
    const wrapper = await renderNotifications([pullNotification()], { notificationSummary: true });

    const action = summarizeAction(wrapper);
    expect(action).toBeTruthy();
    await action!.trigger('click');

    expect(postedMessages()).toContainEqual({
      command: 'notificationSummary',
      instanceId: 'inst-1',
      owner: 'demo-user',
      repo: 'demo-repo',
      index: 7,
      type: 'pull',
    });
    wrapper.unmount();
  });

  it('is absent on a repository notification, which has no discussion to summarize', async () => {
    const wrapper = await renderNotifications(
      [
        issueNotification({
          id: 3,
          subject: {
            type: 'Repository',
            title: 'demo-repo',
            // Deliberately shaped like an issue URL with a numeric tail: the
            // **subject type** is what decides here (§8), not what the address
            // happens to look like. Without this shape the row would be excluded by
            // the index derivation instead, and the type gate would go untested.
            html_url: 'https://forgejo.example.com/demo-user/demo-repo/issues/42',
          },
        }),
      ],
      { notificationSummary: true },
    );

    // The list itself rendered (the row is there), so the absence is the action's
    // gate and not an empty view.
    expect(wrapper.text()).toContain('demo-repo');
    expect(summarizeAction(wrapper)).toBeUndefined();
    wrapper.unmount();
  });

  it('is absent on a commit notification', async () => {
    const wrapper = await renderNotifications(
      [
        issueNotification({
          id: 4,
          subject: {
            type: 'Commit',
            title: 'Fix the thing',
            html_url: 'https://forgejo.example.com/demo-user/demo-repo/commit/abc123',
          },
        }),
      ],
      { notificationSummary: true },
    );

    expect(summarizeAction(wrapper)).toBeUndefined();
    wrapper.unmount();
  });

  it('is absent on an issue notification whose entity cannot be named', async () => {
    const wrapper = await renderNotifications(
      [
        issueNotification({
          id: 5,
          subject: { type: 'Issue', title: 'No link' },
        }),
      ],
      { notificationSummary: true },
    );

    // Without a `html_url` there is no index to summarise: an action here would
    // post a request the host has to refuse, so it is not offered at all.
    expect(summarizeAction(wrapper)).toBeUndefined();
    wrapper.unmount();
  });

  it('does not appear when the feature switch is off', async () => {
    const wrapper = await renderNotifications([issueNotification()], { notificationSummary: false });
    expect(summarizeAction(wrapper)).toBeUndefined();
    wrapper.unmount();
  });

  it('treats a missing switch as off, so an older host offers nothing', async () => {
    const wrapper = await renderNotifications([issueNotification()]);
    expect(summarizeAction(wrapper)).toBeUndefined();
    wrapper.unmount();
  });

  it('follows the switch when it changes in VS Code settings', async () => {
    const wrapper = await renderNotifications([issueNotification()], { notificationSummary: false });
    expect(summarizeAction(wrapper)).toBeUndefined();

    dispatchMessage({ command: 'setNotificationSummary', notificationSummary: true });
    await flushPromises();
    expect(summarizeAction(wrapper)).toBeTruthy();

    dispatchMessage({ command: 'setNotificationSummary', notificationSummary: false });
    await flushPromises();
    expect(summarizeAction(wrapper)).toBeUndefined();
    wrapper.unmount();
  });
});
