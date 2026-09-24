import { describe, expect, it, vi, afterEach } from 'vitest';
import { defineComponent, nextTick, reactive } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

const { stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  return {
    keyFor,
    stateMock: {
      loading: new Map<string, boolean>(),
      errors: new Map<string, string>(),
      repoPullRequests: { value: new Map<string, unknown[]>() },
      repoDetails: { value: new Map<string, unknown>() },
      repoLabels: { value: new Map<string, unknown>() },
      repoAssignees: { value: new Map<string, unknown>() },
      repoMilestones: { value: new Map<string, unknown>() },
      pendingCreatePr: { value: undefined },
      loadRepoPullRequests: vi.fn(),
      loadRepoDetail: vi.fn(),
      loadRepoLabels: vi.fn(),
      loadRepoAssignees: vi.fn(),
      loadRepoMilestones: vi.fn(),
      changeRepoPullRequestsState: vi.fn(),
      consumePendingCreatePr: vi.fn(),
      createPullRequest: vi.fn(),
      editPullRequest: vi.fn(),
      openExternal: vi.fn(),
      openPullRequestDetail: vi.fn(),
      uploadIssueAttachment: vi.fn(),
    },
  };
});

vi.mock('vue-router', () => ({
  useRoute: () => ({
    path: '/repo/inst-1/owner/repoA/pulls/open',
    params: { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', state: 'open' },
  }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('../../composables/useAppState', async () => {
  const state = reactive(stateMock);
  const keyBuilder = (...parts: unknown[]) => keyFor(...parts);
  return {
    useAppState: () => state,
    pullRequestFormKey: keyBuilder,
    repoDetailKey: keyBuilder,
    repoLabelsKey: keyBuilder,
    repoAssigneesKey: keyBuilder,
    repoMilestonesKey: keyBuilder,
    repoPullRequestsKey: keyBuilder,
  };
});

import RepoPullRequests from '../RepoPullRequests.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const state = useAppState() as unknown as typeof stateMock;
const CREATE_FORM_KEY = keyFor('inst-1', 'owner', 'repoA', 0);

const PullRequestFormStub = defineComponent({
  name: 'PullRequestForm',
  props: {
    uploadImage: { type: Function, default: undefined },
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
  },
  emits: ['submit', 'cancel', 'dirty'],
  template: '<div class="pr-form-stub"><slot name="extra" /></div>',
});

const AttachmentListStub = defineComponent({
  name: 'AttachmentList',
  props: { assets: { type: Array, default: () => [] }, allowUpload: { type: Boolean, default: false } },
  emits: ['upload', 'delete', 'openExternal'],
  template: '<div class="attachment-list-stub" />',
});

function mountView() {
  return mount(RepoPullRequests, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: { PullRequestForm: PullRequestFormStub, AttachmentList: AttachmentListStub },
    },
  });
}

/** Picks an image in the create dialog's editor and returns its session URL. */
function pickImage(wrapper: ReturnType<typeof mountView>): string {
  const uploadImage = wrapper.findComponent(PullRequestFormStub).props('uploadImage') as (
    file: File,
    onSuccess: (url: string) => void,
    onError: (error: string) => void,
  ) => void;
  expect(uploadImage, 'editor upload handler').toBeTypeOf('function');
  let objectUrl = '';
  uploadImage(
    new File(['x'], 'shot.png', { type: 'image/png' }),
    (url) => (objectUrl = url),
    () => {},
  );
  return objectUrl;
}

/**
 * The body's own session URL. `PendingAttachmentList` creates and revokes object
 * URLs of its own for the thumbnails, so the assertions have to name the URL the
 * body references instead of counting every revoke.
 */
function bodyUrlRevoked(objectUrl: string): boolean {
  return (URL.revokeObjectURL as unknown as { mock: { calls: [string][] } }).mock.calls.some(
    (call) => call[0] === objectUrl,
  );
}

async function submit(wrapper: ReturnType<typeof mountView>, body: string) {
  wrapper.findComponent(PullRequestFormStub).vm.$emit('submit', {
    title: 'New pull request',
    body,
    base: 'main',
    head: 'feature',
    labels: [],
    assignees: [],
  });
  await flushPromises();
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Creating a pull request with a pasted image is three round-trips: the pull
 * request, the attachment uploads, and a follow-up PUT that rewrites the body so
 * it points at the uploaded attachments instead of the session's `blob:` URLs.
 * That PUT was fire-and-forget: its failure was filed under the create form's
 * key, which the dialog that was closing no longer rendered, while the view
 * revoked the object URLs and navigated to the detail page. The pull request was
 * then stored with `blob:` image sources no reader can load, and nothing said so.
 */
describe('RepoPullRequests create body rewrite', () => {
  function prepare() {
    vi.clearAllMocks();
    state.loading.clear();
    state.errors.clear();
    state.repoPullRequests.value.clear();
    state.createPullRequest.mockResolvedValue({ number: 7 });
    state.uploadIssueAttachment.mockResolvedValue({ id: 1, uuid: 'uuid-1' });
    let seq = 0;
    URL.createObjectURL = vi.fn(() => `blob:pending-${++seq}`) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  }

  it('releases the image URLs and navigates only after the rewrite landed', async () => {
    prepare();
    let finishRewrite: (() => void) | undefined;
    state.editPullRequest.mockImplementation((_instanceId: string, _owner: string, _repo: string, index: number) => {
      const key = keyFor('inst-1', 'owner', 'repoA', index);
      state.loading.set(key, true);
      finishRewrite = () => state.loading.set(key, false);
    });

    const wrapper = mountView();
    await nextTick();
    const objectUrl = pickImage(wrapper);
    await nextTick();
    expect(objectUrl).toBe('blob:pending-1');

    await submit(wrapper, `before ![image](${objectUrl}) after`);

    expect(state.editPullRequest).toHaveBeenCalledWith(
      'inst-1',
      'owner',
      'repoA',
      7,
      expect.objectContaining({ body: 'before ![image](/attachments/uuid-1) after' }),
    );
    // Still on the wire: nothing may be released or navigated yet.
    expect(bodyUrlRevoked(objectUrl)).toBe(false);
    expect(state.openPullRequestDetail).not.toHaveBeenCalled();

    finishRewrite?.();
    await flushPromises();

    expect(bodyUrlRevoked(objectUrl)).toBe(true);
    expect(state.openPullRequestDetail).toHaveBeenCalledWith('inst-1', 'owner', 'repoA', 7);
    wrapper.unmount();
  });

  it('surfaces a failed rewrite, keeps the image URLs and offers the retry', async () => {
    prepare();
    state.editPullRequest.mockImplementation((_instanceId: string, _owner: string, _repo: string, index: number) => {
      const key = keyFor('inst-1', 'owner', 'repoA', index);
      state.loading.set(key, true);
      // The host rejects the rewrite: it answers on that key with an error.
      void Promise.resolve().then(() => {
        state.errors.set(key, 'Forbidden');
        state.loading.set(key, false);
      });
    });

    const wrapper = mountView();
    await nextTick();
    const objectUrl = pickImage(wrapper);
    await nextTick();

    await submit(wrapper, `before ![image](${objectUrl}) after`);

    // Retried once, then reported.
    expect(state.editPullRequest).toHaveBeenCalledTimes(2);
    // The failure is visible on the dialog that is still open ...
    expect(wrapper.findComponent(PullRequestFormStub).props('error')).toContain('Forbidden');
    // ... the session URLs are still alive (the stored body references them) ...
    expect(bodyUrlRevoked(objectUrl)).toBe(false);
    // ... and the user is still on the form, not on a detail page showing a body
    // full of broken images.
    expect(state.openPullRequestDetail).not.toHaveBeenCalled();

    // Submitting again retries the rewrite: no second pull request is created and
    // the already-uploaded attachment is not uploaded again.
    await submit(wrapper, `before ![image](${objectUrl}) after`);
    expect(state.createPullRequest).toHaveBeenCalledTimes(1);
    expect(state.uploadIssueAttachment).toHaveBeenCalledTimes(1);
    expect(state.editPullRequest).toHaveBeenCalledTimes(4);
    wrapper.unmount();
  });

  it('navigates straight away when nothing needed rewriting', async () => {
    prepare();
    const wrapper = mountView();
    await nextTick();

    await submit(wrapper, 'a body without images');

    expect(state.editPullRequest).not.toHaveBeenCalled();
    expect(state.openPullRequestDetail).toHaveBeenCalledWith('inst-1', 'owner', 'repoA', 7);
    expect(state.errors.get(CREATE_FORM_KEY)).toBeUndefined();
    wrapper.unmount();
  });
});
