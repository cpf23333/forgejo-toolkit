import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

const { routeMock, stateMock } = vi.hoisted(() => ({
  routeMock: {
    params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', runId: '5' },
  },
  stateMock: {
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    actionRunDetails: { value: new Map<string, unknown>() },
    actionRunJobs: { value: new Map<string, unknown[]>() },
    actionRunArtifacts: { value: new Map<string, unknown[]>() },
    actionJobLogs: { value: new Map<string, string>() },
    loadActionRun: vi.fn(),
    loadActionRunJobs: vi.fn(),
    loadActionRunArtifacts: vi.fn(),
    loadActionJobLog: vi.fn(),
    cancelActionRun: vi.fn(),
    deleteActionRun: vi.fn(),
    downloadActionArtifact: vi.fn(),
    openExternal: vi.fn(),
  },
}));

vi.mock('vue-router', () => ({
  useRoute: () => routeMock,
}));

vi.mock('../../composables/useAppState', async () => {
  const { reactive } = await import('vue');
  const state = reactive(stateMock);
  return {
    useAppState: () => state,
    actionRunKey: (instanceId: string, owner: string, repo: string, runId: number) =>
      `${instanceId}:${owner}/${repo}:run:${runId}`,
    actionRunJobsKey: (instanceId: string, owner: string, repo: string, runId: number) =>
      `${instanceId}:${owner}/${repo}:run:${runId}:jobs`,
    actionRunArtifactsKey: (instanceId: string, owner: string, repo: string, runId: number) =>
      `${instanceId}:${owner}/${repo}:run:${runId}:artifacts`,
    actionJobLogKey: (instanceId: string, owner: string, repo: string, jobId: number) =>
      `${instanceId}:${owner}/${repo}:job:${jobId}:log`,
    actionRunCancelKey: (instanceId: string, owner: string, repo: string, runId: number) =>
      `${instanceId}:${owner}/${repo}:run:${runId}:cancel`,
    actionRunDeleteKey: (instanceId: string, owner: string, repo: string, runId: number) =>
      `${instanceId}:${owner}/${repo}:run:${runId}:delete`,
    actionArtifactDownloadKey: (instanceId: string, owner: string, repo: string, artifactId: number) =>
      `${instanceId}:${owner}/${repo}:artifact:${artifactId}`,
  };
});

import ActionRunDetail from '../ActionRunDetail.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

type TestState = {
  actionRunDetails: { value: Map<string, unknown> };
  actionRunJobs: { value: Map<string, unknown[]> };
  actionJobLogs: { value: Map<string, string> };
};

function state(): TestState {
  return useAppState() as unknown as TestState;
}

const LOG_KEY = 'inst-1:owner/repo:job:1:log';
const RUN_KEY = 'inst-1:owner/repo:run:5';
const JOBS_KEY = 'inst-1:owner/repo:run:5:jobs';

/**
 * jsdom does not lay anything out, so scrollTop/scrollHeight/clientHeight are
 * all 0. These accessors give one log element a stable, browser-like geometry
 * the view can read and write while the assertions watch a single field.
 */
function applyScrollGeometry(
  el: HTMLElement,
  initial: { scrollTop: number; scrollHeight: number; clientHeight: number },
) {
  const geometry = { ...initial };
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => geometry.scrollTop,
    set: (value: number) => {
      geometry.scrollTop = value;
    },
  });
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => geometry.scrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => geometry.clientHeight,
  });
  return geometry;
}

function mountDetail() {
  return mount(ActionRunDetail, {
    global: { plugins: [createTestI18n('en')] },
  });
}

function setRun(status: string) {
  state().actionRunDetails.value.set(RUN_KEY, { id: 5, status });
}

function setJobs(jobs: Array<{ id?: number; name: string; status: string }>) {
  state().actionRunJobs.value.set(JOBS_KEY, jobs);
}

function logElement(wrapper: VueWrapper) {
  return wrapper.find('pre.job-log');
}

/**
 * A poll reply rewrites the whole log string, so the `<pre>` is patched on
 * every 4 s tick. Its `:ref` is an inline function, and Vue invokes a function
 * ref again on every patch with a new identity: `setJobLogElement` therefore
 * ran on each poll and scrolled the element to the bottom unconditionally,
 * yanking a log the user had scrolled up back down while they were reading it.
 */
describe('ActionRunDetail job log scroll position', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.actionRunDetails.value.clear();
    stateMock.actionRunJobs.value.clear();
    stateMock.actionRunArtifacts.value.clear();
    stateMock.actionJobLogs.value.clear();
    routeMock.params = { instanceId: 'inst-1', owner: 'owner', repo: 'repo', runId: '5' };
    // A poll reply replaces the stored log with a longer one.
    stateMock.loadActionJobLog.mockImplementation((instanceId: string, owner: string, repo: string, jobId: number) => {
      const key = `${instanceId}:${owner}/${repo}:job:${jobId}:log`;
      const current = state().actionJobLogs.value.get(key) ?? 'line 1';
      state().actionJobLogs.value.set(key, `${current}\nline ${current.split('\n').length + 1}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the position of a log the user scrolled up when a poll reply re-renders it', async () => {
    vi.useFakeTimers();
    const wrapper = mountDetail();
    setRun('running');
    setJobs([{ id: 1, name: 'build', status: 'running' }]);
    await nextTick();
    // Let the mount-time "scroll to bottom" settle before measuring.
    await nextTick();

    const log = logElement(wrapper);
    expect(log.exists()).toBe(true);
    const geometry = applyScrollGeometry(log.element as HTMLElement, {
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 300,
    });

    // The user scrolls up to read an earlier line: 100 + 300 is far from the end.
    await log.trigger('scroll');
    expect(geometry.scrollTop).toBe(100);

    // The next poll tick appends a line, which re-renders the log.
    await vi.advanceTimersByTimeAsync(4000);
    await nextTick();
    await nextTick();

    // Before the fix this was 1000 (scrollHeight): the inline ref scrolled the
    // log back to the bottom under the reader.
    expect(geometry.scrollTop).toBe(100);
    wrapper.unmount();
  });

  it('still follows the tail while the user is at the bottom', async () => {
    vi.useFakeTimers();
    const wrapper = mountDetail();
    setRun('running');
    setJobs([{ id: 1, name: 'build', status: 'running' }]);
    await nextTick();
    // Let the mount-time "scroll to bottom" settle before measuring.
    await nextTick();

    const log = logElement(wrapper);
    expect(log.exists()).toBe(true);
    const geometry = applyScrollGeometry(log.element as HTMLElement, {
      scrollTop: 700,
      scrollHeight: 1000,
      clientHeight: 300,
    });

    // 700 + 300 reaches the end, so the log is being followed.
    await log.trigger('scroll');

    await vi.advanceTimersByTimeAsync(4000);
    await nextTick();
    await nextTick();

    expect(geometry.scrollTop).toBe(geometry.scrollHeight);
    wrapper.unmount();
  });

  it('scrolls a freshly mounted log to the bottom', async () => {
    // Seeded before mount so the log renders on the first pass, like a job that
    // was already expanded when the view opened.
    setRun('running');
    setJobs([{ id: 1, name: 'build', status: 'running' }]);
    state().actionJobLogs.value.set(LOG_KEY, 'line 1\nline 2');

    const wrapper = mountDetail();
    const log = logElement(wrapper);
    expect(log.exists()).toBe(true);
    // The mount-time scroll is queued on nextTick, so the geometry may be set
    // after the ref ran.
    const geometry = applyScrollGeometry(log.element as HTMLElement, {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 300,
    });

    await nextTick();

    expect(geometry.scrollTop).toBe(geometry.scrollHeight);
    wrapper.unmount();
  });
});
