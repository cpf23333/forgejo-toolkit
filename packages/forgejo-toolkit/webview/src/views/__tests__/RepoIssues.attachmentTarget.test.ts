import { describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, reactive } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

const { stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  return {
    keyFor,
    stateMock: {
      loading: new Map<string, boolean>(),
      errors: new Map<string, string>(),
      repoIssues: { value: new Map<string, unknown[]>() },
      repoDetails: { value: new Map<string, unknown>() },
      repoLabels: { value: new Map<string, unknown>() },
      repoAssignees: { value: new Map<string, unknown>() },
      repoMilestones: { value: new Map<string, unknown>() },
      repoRefs: { value: new Map<string, unknown>() },
      pendingNewIssue: { value: undefined },
      loadRepoIssues: vi.fn(),
      loadRepoDetail: vi.fn(),
      loadRepoLabels: vi.fn(),
      loadRepoAssignees: vi.fn(),
      loadRepoMilestones: vi.fn(),
      loadRepoRefs: vi.fn(),
      changeRepoIssuesState: vi.fn(),
      consumePendingNewIssue: vi.fn(),
      createIssue: vi.fn(),
      editIssue: vi.fn(),
      openExternal: vi.fn(),
      openIssueDetail: vi.fn(),
      uploadIssueAttachment: vi.fn(),
    },
  };
});

// The route is reactive so a test can move the user to another repository while
// a request from the create dialog is still in flight.
vi.mock('vue-router', async () => {
  const { reactive: makeReactive } = await import('vue');
  const params = makeReactive({ instanceId: 'inst-1', owner: 'owner', repo: 'repoA', state: 'open' });
  return {
    useRoute: () => ({ params }),
    useRouter: () => ({ push: vi.fn() }),
    __params: params,
  };
});

vi.mock('../../composables/useAppState', async () => {
  const state = reactive(stateMock);
  const keyBuilder = (...parts: unknown[]) => keyFor(...parts);
  return {
    useAppState: () => state,
    issueFormKey: keyBuilder,
    repoDetailKey: keyBuilder,
    repoIssuesKey: keyBuilder,
    repoLabelsKey: keyBuilder,
    repoAssigneesKey: keyBuilder,
    repoMilestonesKey: keyBuilder,
    repoRefsKey: keyBuilder,
  };
});

import * as routerModule from 'vue-router';
import RepoIssues from '../RepoIssues.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const routeParams = (routerModule as unknown as { __params: Record<string, string> }).__params;
const state = stateMock;

const IssueFormStub = defineComponent({
  name: 'IssueForm',
  props: {
    uploadImage: { type: Function, default: undefined },
  },
  emits: ['submit', 'cancel', 'dirty'],
  template: '<div class="issue-form-stub"><slot name="extra" /></div>',
});

const AttachmentListStub = defineComponent({
  name: 'AttachmentList',
  props: {
    assets: { type: Array, default: () => [] },
    allowUpload: { type: Boolean, default: false },
    allowDelete: { type: Boolean, default: false },
    uploading: { type: Boolean, default: false },
  },
  emits: ['upload', 'delete', 'openExternal'],
  template: '<div class="attachment-list-stub" />',
});

function mountView() {
  return mount(RepoIssues, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: { IssueForm: IssueFormStub, AttachmentList: AttachmentListStub },
    },
  });
}

/**
 * The create dialog spans several requests (create the issue, upload its
 * attachments, rewrite its body). `route.params` follows the global route, so
 * reading it again after an await would post the attachment to whatever
 * repository the user navigated to in the meantime.
 */
describe('RepoIssues create dialog target', () => {
  it('uploads attachments to the repository the form was opened for', async () => {
    vi.clearAllMocks();
    routeParams.instanceId = 'inst-1';
    routeParams.owner = 'owner';
    routeParams.repo = 'repoA';
    state.createIssue.mockImplementation(async () => {
      // The user switches repository while the create request is in flight.
      routeParams.repo = 'repoB';
      return { number: 7 };
    });
    state.uploadIssueAttachment.mockResolvedValue({ id: 1, uuid: 'uuid-1' });

    const wrapper = mountView();
    await nextTick();
    wrapper.findComponent(AttachmentListStub).vm.$emit('upload', new File(['x'], 'shot.png', { type: 'image/png' }));
    await nextTick();

    wrapper.findComponent(IssueFormStub).vm.$emit('submit', { title: 'New issue', body: 'body' });
    await flushPromises();

    expect(state.createIssue).toHaveBeenCalledWith(
      'inst-1',
      'owner',
      'repoA',
      expect.objectContaining({ title: 'New issue' }),
    );
    const uploadCall = state.uploadIssueAttachment.mock.calls[0];
    expect(uploadCall.slice(0, 4)).toEqual(['inst-1', 'owner', 'repoA', 7]);
    expect(state.openIssueDetail).toHaveBeenCalledWith('inst-1', 'owner', 'repoA', 7);
    wrapper.unmount();
  });

  it('strips the blob URL of a pending image the user removed before submitting', async () => {
    vi.clearAllMocks();
    routeParams.instanceId = 'inst-1';
    routeParams.owner = 'owner';
    routeParams.repo = 'repoA';
    state.createIssue.mockResolvedValue({ number: 7 });
    let objectUrlSeq = 0;
    URL.createObjectURL = vi.fn(() => `blob:pending-${++objectUrlSeq}`) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;

    const wrapper = mountView();
    await nextTick();

    // The editor's image picker hands the file to the view, which returns the
    // object URL the editor then writes into the body.
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    const uploadImage = wrapper.findComponent(IssueFormStub).props('uploadImage') as (
      picked: File,
      onSuccess: (url: string) => void,
      onError: (error: string) => void,
    ) => void;
    expect(uploadImage).toBeTypeOf('function');
    let objectUrl = '';
    uploadImage(
      file,
      (url) => (objectUrl = url),
      () => {},
    );
    await nextTick();
    expect(objectUrl).toBe('blob:pending-1');

    // The user removes the image again, but it is still referenced by the body.
    await wrapper.find('.pending-attachment-remove').trigger('click');
    await nextTick();

    wrapper.findComponent(IssueFormStub).vm.$emit('submit', {
      title: 'New issue',
      body: `before ![image](${objectUrl}) after`,
    });
    await flushPromises();

    // No upload happened, so the stored body must not keep the session blob URL.
    expect(state.uploadIssueAttachment).not.toHaveBeenCalled();
    expect(state.editIssue).toHaveBeenCalledWith(
      'inst-1',
      'owner',
      'repoA',
      7,
      expect.objectContaining({ body: 'before  after' }),
    );
    wrapper.unmount();
  });
});
