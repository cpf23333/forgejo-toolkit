import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ActionRunDetail from '../ActionRunDetail.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

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
  // Wrap in reactive so the component's computed/watch observe Map mutations
  // the tests perform through useAppState().
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

import { useAppState } from '../../composables/useAppState';

type TestState = {
  actionRunDetails: { value: Map<string, unknown> };
  actionRunJobs: { value: Map<string, unknown[]> };
  actionJobLogs: { value: Map<string, string> };
};

function state(): TestState {
  return useAppState() as unknown as TestState;
}

function setRun(status: string) {
  state().actionRunDetails.value.set('inst-1:owner/repo:run:5', { id: 5, status });
}

function setJobs(jobs: Array<{ id?: number; name: string; status: string }>) {
  state().actionRunJobs.value.set('inst-1:owner/repo:run:5:jobs', jobs);
}

function logCallsFor(jobId: number) {
  return stateMock.loadActionJobLog.mock.calls.filter((args) => args[3] === jobId);
}

function mountDetail() {
  return mount(ActionRunDetail, {
    global: {
      plugins: [createTestI18n('en')],
    },
  });
}

describe('ActionRunDetail job log collapsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.actionRunDetails.value.clear();
    stateMock.actionRunJobs.value.clear();
    stateMock.actionRunArtifacts.value.clear();
    stateMock.actionJobLogs.value.clear();
    routeMock.params = { instanceId: 'inst-1', owner: 'owner', repo: 'repo', runId: '5' };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads logs only for jobs that are expanded by default', async () => {
    const wrapper = mountDetail();
    setRun('running');
    setJobs([
      { id: 1, name: 'build', status: 'running' },
      { id: 2, name: 'test', status: 'success' },
      { id: 3, name: 'publish', status: 'failure' },
    ]);
    await nextTick();

    // Live and failed jobs start expanded; finished successful jobs start collapsed.
    expect(logCallsFor(1)).toEqual([['inst-1', 'owner', 'repo', 1, false]]);
    expect(logCallsFor(2)).toEqual([]);
    expect(logCallsFor(3)).toEqual([['inst-1', 'owner', 'repo', 3, false]]);
    expect(wrapper.findAll('.job-log-panel')).toHaveLength(2);
    wrapper.unmount();
  });

  it('poll refreshes logs of expanded live jobs only', async () => {
    vi.useFakeTimers();
    const wrapper = mountDetail();
    setRun('running');
    setJobs([
      { id: 1, name: 'build', status: 'running' },
      { id: 2, name: 'test', status: 'running' },
    ]);
    await nextTick();
    expect(logCallsFor(1)).toHaveLength(1);
    expect(logCallsFor(2)).toHaveLength(1);

    // Collapse the second job, then let a poll cycle run.
    await wrapper.findAll('.job-header')[1].trigger('click');
    stateMock.loadActionJobLog.mockClear();
    vi.advanceTimersByTime(4000);

    expect(logCallsFor(1)).toEqual([['inst-1', 'owner', 'repo', 1, true]]);
    expect(logCallsFor(2)).toEqual([]);
    wrapper.unmount();
  });

  it('keeps polling a live job that stays expanded', async () => {
    vi.useFakeTimers();
    const wrapper = mountDetail();
    setRun('running');
    setJobs([{ id: 1, name: 'build', status: 'running' }]);
    await nextTick();

    stateMock.loadActionJobLog.mockClear();
    vi.advanceTimersByTime(8000);

    expect(logCallsFor(1)).toEqual([
      ['inst-1', 'owner', 'repo', 1, true],
      ['inst-1', 'owner', 'repo', 1, true],
    ]);
    wrapper.unmount();
  });

  it('fetches a live job log immediately with force when expanded', async () => {
    vi.useFakeTimers();
    const wrapper = mountDetail();
    setRun('running');
    setJobs([
      { id: 1, name: 'build', status: 'running' },
      { id: 2, name: 'test', status: 'running' },
    ]);
    await nextTick();

    // Collapse job 2, then expand it again: it must pull fresh logs right away.
    await wrapper.findAll('.job-header')[1].trigger('click');
    stateMock.loadActionJobLog.mockClear();
    await wrapper.findAll('.job-header')[1].trigger('click');

    expect(logCallsFor(2)).toEqual([['inst-1', 'owner', 'repo', 2, true]]);
    expect(wrapper.findAll('.job-log-panel')).toHaveLength(2);
    wrapper.unmount();
  });

  it('fetches a finished job log once (no force) when the user expands it', async () => {
    const wrapper = mountDetail();
    setRun('success');
    setJobs([{ id: 2, name: 'test', status: 'success' }]);
    await nextTick();
    expect(logCallsFor(2)).toEqual([]);
    expect(wrapper.findAll('.job-log-panel')).toHaveLength(0);

    await wrapper.findAll('.job-header')[0].trigger('click');

    expect(logCallsFor(2)).toEqual([['inst-1', 'owner', 'repo', 2, false]]);
    expect(wrapper.findAll('.job-log-panel')).toHaveLength(1);
    wrapper.unmount();
  });

  it('exposes the job header as a keyboard-operable disclosure with its expanded state', async () => {
    const wrapper = mountDetail();
    setRun('success');
    setJobs([{ id: 2, name: 'test', status: 'success' }]);
    await nextTick();

    const header = wrapper.findAll('.job-header')[0];
    expect(header.attributes('role')).toBe('button');
    expect(header.attributes('tabindex')).toBe('0');
    expect(header.attributes('aria-expanded')).toBe('false');

    // A keyboard user can expand the job and read its log.
    await header.trigger('keydown.enter');
    expect(header.attributes('aria-expanded')).toBe('true');
    expect(wrapper.findAll('.job-log-panel')).toHaveLength(1);
    expect(logCallsFor(2)).toEqual([['inst-1', 'owner', 'repo', 2, false]]);

    // Space collapses it again (and preventDefault keeps the page from scrolling).
    await header.trigger('keydown.space');
    expect(header.attributes('aria-expanded')).toBe('false');
    expect(wrapper.findAll('.job-log-panel')).toHaveLength(0);
    wrapper.unmount();
  });

  it('leaves jobs without an id out of the tab order', async () => {
    const wrapper = mountDetail();
    setRun('success');
    setJobs([{ name: 'anonymous', status: 'success' }]);
    await nextTick();

    const header = wrapper.findAll('.job-header')[0];
    expect(header.attributes('tabindex')).toBe('-1');
    expect(header.attributes('aria-expanded')).toBeUndefined();
    wrapper.unmount();
  });
});

/**
 * A run that cannot be loaded stores no run entry, so `run.status` stays
 * undefined and `isFinalStatus(undefined)` is false: the poll interval used to
 * keep refetching a failing request forever.
 *
 * The two tests here cover the state the user sees and the requests that stop.
 * Whether this file's tree is actually polled is not asserted: mounting the
 * view directly (the way this file does) never arms the poll interval, because
 * the watcher that starts it only reacts to changes that happen after the first
 * flush. The polling itself is covered by the "ActionRunDetail job log
 * collapsing" tests above, which drive it through state written after mount.
 */
describe('ActionRunDetail polling after a failed load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.actionRunDetails.value.clear();
    stateMock.actionRunJobs.value.clear();
    stateMock.actionRunArtifacts.value.clear();
    stateMock.actionJobLogs.value.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function failRunLoad() {
    // Through `useAppState()`: that is the reactive proxy the component reads,
    // while `stateMock.errors` is the raw Map behind it.
    (useAppState() as unknown as { errors: Map<string, string> }).errors.set(
      'inst-1:owner/repo:run:5',
      'run not found',
    );
  }

  it('stops polling once the run load failed and says so', async () => {
    // A live run, so a mount that does poll has an interval to stop.
    setRun('running');
    const wrapper = mountDetail();
    await nextTick();

    // The refresh fails: no run entry is stored (so the status stays undefined
    // and `isFinalStatus(undefined)` is false) and the loaders' in-flight guard
    // is cleared, which is exactly the state that used to keep the interval
    // refetching a failing request forever.
    stateMock.actionRunDetails.value.delete('inst-1:owner/repo:run:5');
    failRunLoad();
    await nextTick();
    await nextTick();

    expect(wrapper.text()).toContain('run not found');
    expect(wrapper.text()).toContain('Auto-refresh is paused');

    stateMock.loading.clear();
    const afterFailure = stateMock.loadActionRun.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000 * 3);
    expect(stateMock.loadActionRun.mock.calls.length).toBe(afterFailure);
    wrapper.unmount();
  });

  it('resumes polling after a successful retry', async () => {
    const wrapper = mountDetail();
    await nextTick();
    failRunLoad();
    await nextTick();

    // A reply that clears the error (the retry landed and the run resolved)
    // turns the interval back on.
    (useAppState() as unknown as { errors: Map<string, string> }).errors.delete('inst-1:owner/repo:run:5');
    setRun('running');
    await nextTick();

    const before = stateMock.loadActionRun.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(stateMock.loadActionRun.mock.calls.length).toBeGreaterThan(before);
    wrapper.unmount();
  });
});

describe('ActionRunDetail run actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.actionRunDetails.value.clear();
    stateMock.actionRunJobs.value.clear();
    stateMock.actionRunArtifacts.value.clear();
    stateMock.actionJobLogs.value.clear();
  });

  function cancelButtons(wrapper: ReturnType<typeof mountDetail>) {
    return wrapper.findAll('[icon="circle-slash"]');
  }

  function deleteButtons(wrapper: ReturnType<typeof mountDetail>) {
    return wrapper.findAll('[icon="trash"]');
  }

  it('offers cancel for exactly the statuses the API accepts', async () => {
    // blocked (waiting for approval) is a real state the API cancels; the views
    // used to list GitHub's pending/requested instead and hid the button for it.
    for (const status of ['unknown', 'waiting', 'running', 'blocked']) {
      const wrapper = mountDetail();
      setRun(status);
      await nextTick();
      expect(cancelButtons(wrapper), status).toHaveLength(1);
      wrapper.unmount();
      stateMock.actionRunDetails.value.clear();
    }
    for (const status of ['success', 'failure', 'cancelled', 'skipped', 'pending', 'requested']) {
      const wrapper = mountDetail();
      setRun(status);
      await nextTick();
      expect(cancelButtons(wrapper), status).toHaveLength(0);
      wrapper.unmount();
      stateMock.actionRunDetails.value.clear();
    }
  });

  it('offers delete only once the run is finished', async () => {
    // DELETE on a queued, running or blocked run answers 500, so the button must
    // not be offered for those states.
    for (const status of ['running', 'blocked', 'waiting', 'unknown']) {
      const wrapper = mountDetail();
      setRun(status);
      await nextTick();
      expect(deleteButtons(wrapper), status).toHaveLength(0);
      wrapper.unmount();
      stateMock.actionRunDetails.value.clear();
    }
    for (const status of ['success', 'failure', 'cancelled', 'skipped']) {
      const wrapper = mountDetail();
      setRun(status);
      await nextTick();
      expect(deleteButtons(wrapper), status).toHaveLength(1);
      wrapper.unmount();
      stateMock.actionRunDetails.value.clear();
    }
  });
});
