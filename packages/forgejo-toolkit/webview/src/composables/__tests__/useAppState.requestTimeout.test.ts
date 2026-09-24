import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

let messageHandlers: Array<(event: MessageEvent) => void> = [];
let vscodeApiMock: {
  postMessage: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  messageHandlers = [];
  vscodeApiMock = {
    postMessage: vi.fn(),
    getState: vi.fn(() => undefined),
    setState: vi.fn(),
  };
  (window as unknown as { acquireVsCodeApi: () => typeof vscodeApiMock }).acquireVsCodeApi = () => vscodeApiMock;
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

function postedMessage(index = 0): Record<string, unknown> {
  return vscodeApiMock.postMessage.mock.calls[index]?.[0] as Record<string, unknown>;
}

async function createState() {
  vi.resetModules();
  const mod = await import('../../composables/useAppState');
  const router = createTestRouter();
  const i18n = createTestI18n();
  const wrapper = mount(
    {
      template: '<div></div>',
      setup() {
        const state = mod.useAppState();
        return { state };
      },
    },
    {
      global: {
        plugins: [router, i18n],
      },
    },
  );
  await flushPromises();
  return { wrapper, state: wrapper.vm.state as ReturnType<typeof mod.useAppState>, mod, router };
}

describe('per-command host request timeouts', () => {
  it('keeps deleteReleaseAttachment pending past 60 s because the host waits on a modal confirmation', async () => {
    const { state } = await createState();
    vscodeApiMock.postMessage.mockClear();
    vi.useFakeTimers();
    try {
      let settled = false;
      const promise = state.deleteReleaseAttachment('inst-1', 'owner', 'repo', 1, 2);
      promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      const sent = postedMessage();
      expect(sent.command).toBe('deleteReleaseAttachment');
      const requestId = sent._requestId as string;
      expect(typeof requestId).toBe('string');

      // Far past the default minute: the request must still be in flight, not
      // rejected with a false timeout while the host sits on its own dialog.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(settled).toBe(false);
      expect(vscodeApiMock.postMessage).toHaveBeenCalledTimes(1);

      dispatchMessage({
        command: 'releaseAttachmentDeleted',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        id: 1,
        attachmentId: 2,
        deleted: true,
        _requestId: requestId,
      });

      await expect(promise).resolves.toBe(true);

      // The real reply cleared the timer: no late rejection can follow.
      await vi.advanceTimersByTimeAsync(600_000);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps deleteIssueAttachment pending past 60 s because the host waits on a modal confirmation', async () => {
    const { state } = await createState();
    vscodeApiMock.postMessage.mockClear();
    vi.useFakeTimers();
    try {
      let settled = false;
      const promise = state.deleteIssueAttachment('inst-1', 'owner', 'repo', 1, 2);
      promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      const sent = postedMessage();
      expect(sent.command).toBe('deleteIssueAttachment');
      const requestId = sent._requestId as string;
      expect(typeof requestId).toBe('string');

      // The host pops its own native confirmation before replying, so the
      // webview must not abandon a deletion the user is still confirming.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(settled).toBe(false);

      dispatchMessage({
        command: 'issueAttachmentDeleted',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 1,
        attachmentId: 2,
        _requestId: requestId,
      });

      await expect(promise).resolves.toBe(true);

      // The real reply cleared the timer: no late rejection can follow.
      await vi.advanceTimersByTimeAsync(600_000);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects renderMarkdown at the default 60 s when the host never answers', async () => {
    const { state } = await createState();
    vscodeApiMock.postMessage.mockClear();
    vi.useFakeTimers();
    try {
      const outcome = state.renderMarkdown('inst-1', 'hello').then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );

      const sent = postedMessage();
      expect(sent.command).toBe('renderMarkdown');

      // Still pending just before the default budget elapses.
      await vi.advanceTimersByTimeAsync(59_000);
      expect(vscodeApiMock.postMessage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(outcome).resolves.toBe('rejected');
    } finally {
      vi.useRealTimers();
    }
  });
});
