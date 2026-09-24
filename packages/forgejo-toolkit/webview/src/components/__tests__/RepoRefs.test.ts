import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import RepoRefs from '../RepoRefs.vue';
import RepoRefFormDialog from '../RepoRefFormDialog.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    repoRefs: {
      value: new Map<string, unknown>([['inst-1:owner/repo:refs', { branches: [], tags: [], releases: [] }]]),
    },
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    loadRepoRefs: vi.fn(),
    createRepoBranch: vi.fn(),
    createRepoTag: vi.fn(),
    editRepoRelease: vi.fn(),
    deleteRepoBranch: vi.fn(),
    deleteRepoTag: vi.fn(),
    deleteRepoRelease: vi.fn(),
    createRepoRelease: vi.fn(),
    uploadReleaseAttachment: vi.fn(),
  },
}));

vi.mock('../../composables/useAppState', () => ({
  useAppState: () => stateMock,
  repoRefsKey: (instanceId: string, owner: string, repo: string) => `${instanceId}:${owner}/${repo}:refs`,
}));

function mountRepoRefs() {
  return mount(RepoRefs, {
    props: { instanceId: 'inst-1', owner: 'owner', repo: 'repo' },
    global: {
      plugins: [createTestI18n('en')],
      stubs: { RepoRefFormDialog: true },
    },
  });
}

async function openReleaseDialog(wrapper: ReturnType<typeof mountRepoRefs>) {
  const releasesTab = wrapper.findAll('.tab-button').find((b) => b.text() === 'Releases');
  expect(releasesTab).toBeTruthy();
  await releasesTab!.trigger('click');
  const createButton = wrapper.findAll('.ref-action-button').find((b) => b.text().includes('New release'));
  expect(createButton).toBeTruthy();
  await createButton!.trigger('click');
}

describe('RepoRefs release attachment upload', () => {
  beforeEach(() => {
    stateMock.loadRepoRefs.mockClear();
    stateMock.createRepoRelease.mockReset();
    stateMock.uploadReleaseAttachment.mockReset();
  });

  it('keeps failed attachments queued with an error and retries only the remainder', async () => {
    stateMock.createRepoRelease.mockResolvedValue({ id: 7 });
    stateMock.uploadReleaseAttachment.mockImplementation(
      (_i: string, _o: string, _r: string, _id: number, name: string) =>
        name === 'bad.txt' ? Promise.reject(new Error('boom')) : Promise.resolve({}),
    );

    const wrapper = mountRepoRefs();
    await openReleaseDialog(wrapper);
    const dialog = () => wrapper.findComponent(RepoRefFormDialog);
    expect(dialog().exists()).toBe(true);

    dialog().vm.$emit('upload-pending', new File(['good'], 'good.txt'));
    dialog().vm.$emit('upload-pending', new File(['bad'], 'bad.txt'));
    await nextTick();
    expect(dialog().props('pendingAttachments')).toHaveLength(2);

    dialog().vm.$emit('submit', { tagName: 'v1.0.0' });
    await flushPromises();

    // The release was created once, both uploads attempted, the failure stays
    // queued and the error surfaces in the dialog instead of being swallowed.
    expect(stateMock.createRepoRelease).toHaveBeenCalledTimes(1);
    expect(stateMock.uploadReleaseAttachment).toHaveBeenCalledTimes(2);
    expect(dialog().props('error')).toContain('failed to upload');
    expect(dialog().props('pendingAttachments')).toHaveLength(1);
    expect(stateMock.loadRepoRefs).not.toHaveBeenCalledWith('inst-1', 'owner', 'repo', true);

    // Retry: no duplicate release creation; only the failed file re-uploads.
    stateMock.createRepoRelease.mockClear();
    stateMock.uploadReleaseAttachment.mockClear();
    stateMock.uploadReleaseAttachment.mockResolvedValue({});
    dialog().vm.$emit('submit', { tagName: 'v1.0.0' });
    await flushPromises();

    expect(stateMock.createRepoRelease).not.toHaveBeenCalled();
    expect(stateMock.uploadReleaseAttachment).toHaveBeenCalledTimes(1);
    expect(stateMock.uploadReleaseAttachment.mock.calls[0][4]).toBe('bad.txt');
    expect(dialog().props('error')).toBeFalsy();
    expect(dialog().props('pendingAttachments')).toHaveLength(0);
    expect(stateMock.loadRepoRefs).toHaveBeenCalledWith('inst-1', 'owner', 'repo', true);
  });

  it('surfaces the creation error when the release itself fails', async () => {
    stateMock.createRepoRelease.mockRejectedValue(new Error('tag already exists'));

    const wrapper = mountRepoRefs();
    await openReleaseDialog(wrapper);
    const dialog = () => wrapper.findComponent(RepoRefFormDialog);

    dialog().vm.$emit('submit', { tagName: 'v1.0.0' });
    await flushPromises();

    expect(dialog().props('error')).toBe('tag already exists');
    expect(stateMock.uploadReleaseAttachment).not.toHaveBeenCalled();
  });
});

describe('RepoRefs truncation notice', () => {
  it('says when the active reference list was cut off at the cap', async () => {
    const branch = (index: number) => ({ name: `branch-${index}`, commit: { id: 'abc' }, protected: false });
    stateMock.repoRefs.value.set('inst-1:owner/repo:refs', {
      branches: Array.from({ length: 500 }, (_, index) => branch(index)),
      tags: [],
      releases: [],
    });

    const capped = mountRepoRefs();
    await nextTick();
    expect(capped.find('.list-truncated').exists()).toBe(true);

    stateMock.repoRefs.value.set('inst-1:owner/repo:refs', {
      branches: Array.from({ length: 499 }, (_, index) => branch(index)),
      tags: [],
      releases: [],
    });
    const below = mountRepoRefs();
    await nextTick();
    expect(below.find('.list-truncated').exists()).toBe(false);
  });
});
