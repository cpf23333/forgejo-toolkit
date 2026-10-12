import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import Notifications from '../Notifications.vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

/**
 * The notification rows' `data-vscode-context` marker, as the rendered DOM carries it.
 *
 * The marker is the only thing that tells VS Code which item was right-clicked, and
 * the one place the *values* can be checked end to end: the section key selects the
 * items, the notification id feeds "Mark as Read", and the coordinates plus
 * `forgejoSubjectType` are what the "Open Issue" / "Open Pull Request" clauses test.
 * A repository notification has neither, so its marker must not claim them.
 */

let messageHandlers: Array<(event: MessageEvent) => void> = [];
let listenerInstalled = false;

beforeEach(() => {
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

async function mountRows(notifications: Array<Record<string, unknown>>) {
  const wrapper = mount(Notifications, {
    global: { plugins: [createTestRouter(), createTestI18n('en')] },
  });
  dispatchMessage({
    command: 'initialState',
    instances: [{ id: 'inst-1', url: 'https://forgejo.example.com' }],
    locale: 'en',
  });
  dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications });
  await flushPromises();
  return wrapper;
}

/** The marker one row published, parsed. */
function markerOf(wrapper: Awaited<ReturnType<typeof mountRows>>, index: number): Record<string, unknown> {
  const rows = wrapper.findAll('vscode-tree-item[data-vscode-context]');
  const raw = rows[index].attributes('data-vscode-context');
  expect(raw, `row ${index} carries a marker`).toBeTruthy();
  return JSON.parse(raw!) as Record<string, unknown>;
}

function notification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 11,
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

describe('notification row context markers', () => {
  it('publishes the section, the instance and the subject coordinates of an issue row', async () => {
    const wrapper = await mountRows([notification()]);
    const marker = markerOf(wrapper, 0);

    expect(marker.webviewSection).toBe('notificationRow');
    expect(marker.preventDefaultContextMenuItems).toBe(true);
    expect(marker.forgejoInstanceId).toBe('inst-1');
    expect(marker.forgejoNotificationId).toBe(11);
    expect(marker.forgejoOwner).toBe('demo-user');
    expect(marker.forgejoRepo).toBe('demo-repo');
    expect(marker.forgejoIndex).toBe(42);
    expect(marker.forgejoSubjectType).toBe('issue');
    wrapper.unmount();
  });

  it('reports a pull request row as a pull', async () => {
    const wrapper = await mountRows([
      notification({
        id: 12,
        subject: {
          type: 'PullRequest',
          title: 'Retry the request',
          html_url: 'https://forgejo.example.com/demo-user/demo-repo/pulls/7',
        },
      }),
    ]);

    expect(markerOf(wrapper, 0)).toMatchObject({ forgejoIndex: 7, forgejoSubjectType: 'pull' });
    wrapper.unmount();
  });

  it('asks for neither open item on a repository notification, but still offers its own id', async () => {
    const wrapper = await mountRows([
      notification({
        id: 13,
        subject: {
          type: 'Repository',
          title: 'demo-repo',
          html_url: 'https://forgejo.example.com/demo-user/demo-repo',
        },
      }),
    ]);
    const marker = markerOf(wrapper, 0);

    expect(marker.forgejoNotificationId).toBe(13);
    // The `when` clauses key on these; without them the notification row offers no
    // "open" item rather than one that would act on the wrong entity.
    expect(marker).not.toHaveProperty('forgejoSubjectType');
    expect(marker).not.toHaveProperty('forgejoIndex');
    wrapper.unmount();
  });
});
