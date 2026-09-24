import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: { value: [] as Record<string, unknown>[] },
    locale: { value: 'en' },
    changeLocale: vi.fn(),
    worktreeOpenMode: { value: 'ask' },
    changeWorktreeOpenMode: vi.fn(),
    worktreeCacheDirectory: { value: '' },
    worktreeCacheDirectoryDefault: { value: '' },
    setWorktreeCacheDirectory: vi.fn(),
    browseWorktreeCacheDirectory: vi.fn(),
    importPreview: { value: undefined },
    importInstancesResult: { value: undefined },
    testConnectionResult: { value: undefined },
    saveInstanceResult: { value: undefined },
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    testConnection: vi.fn(),
    saveInstance: vi.fn(),
    loadRepositories: vi.fn(),
    removeInstance: vi.fn(),
    openExternal: vi.fn(),
    previewImportInstances: vi.fn(),
  },
}));

// The view and the test must read the same reactive proxy: a watcher only
// tracks `.value` reads through one (a bare object holding refs is not
// reactive), and two proxies over the same object would not see each other.
vi.mock('../../composables/useAppState', async () => {
  const { reactive } = await import('vue');
  const state = reactive(stateMock);
  return { useAppState: () => state };
});

import Onboarding from '../Onboarding.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

const state = useAppState() as unknown as {
  instances: { value: Record<string, unknown>[] };
  loading: Map<string, boolean>;
  errors: Map<string, string>;
  saveInstanceResult: { value: unknown };
  loadRepositories: ReturnType<typeof vi.fn>;
};

function mountView() {
  return mount(Onboarding, {
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { TokenScopeList: true, ImportPreview: true },
    },
  });
}

function buttonByLabel(wrapper: VueWrapper, label: string) {
  const button = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === label);
  expect(button, `button "${label}"`).toBeTruthy();
  return button!;
}

async function typeInto(wrapper: VueWrapper, selector: string, value: string) {
  const field = wrapper.find(selector);
  (field.element as unknown as { value: string }).value = value;
  await field.trigger('input');
}

/**
 * Fills the server step and saves, then runs the repositories probe the host
 * answers with. The connection test only calls `/user`, so a token with
 * `read:user` alone passes it; the scope check under test is what runs
 * afterwards. The connection success the save is gated on is set on the view
 * directly rather than driven through the result watcher.
 */
async function saveThroughTheForm(wrapper: VueWrapper) {
  // The wizard starts on the language step; the server form is step 1.
  await buttonByLabel(wrapper, 'Next').trigger('click');
  await typeInto(wrapper, '#onboarding-url', 'https://forgejo.example.com');
  await typeInto(wrapper, '#onboarding-token', 'token');

  const view = wrapper.vm as unknown as { connectionStatusType: string };
  view.connectionStatusType = 'success';
  await nextTick();

  await buttonByLabel(wrapper, 'Add Instance').trigger('click');
  await nextTick();

  // The host saves the instance and pushes the list carrying its id.
  state.instances.value = [
    { id: 'inst-1', url: 'https://forgejo.example.com', name: 'demo-user@forgejo.example.com', username: 'demo-user' },
  ];
  state.saveInstanceResult.value = { success: true };
  await nextTick();

  // The dashboard's repositories load starts (busy true) and its reply lands
  // (busy false) with whatever the host reported.
  return {
    replyFailed(error: string) {
      state.errors.set('repos-inst-1', error);
      state.loading.set('repos-inst-1', true);
      state.loading.set('repos-inst-1', false);
    },
    replySucceeded() {
      state.loading.set('repos-inst-1', true);
      state.loading.set('repos-inst-1', false);
    },
  };
}

/**
 * The connection test only calls `/user`, so a token that carries `read:user`
 * alone passes it and gets saved. The dashboard then shows "Permission denied"
 * with no repositories. The setup guide probes the repositories call the
 * dashboard starts with, so the status names the missing scope instead of
 * claiming a working connection.
 *
 * The probe's failure is whatever `getUserRepositories()` threw, and the host
 * replies it as `userFacingErrorMessage(error)` — a sentence with no status code
 * on it. Only the wording a refusal renders may be reported as a missing scope;
 * a connectivity, TLS or proxy failure has to be reported as itself.
 */
describe('Onboarding token scope check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.instances.value = [];
    state.loading.clear();
    state.errors.clear();
    state.saveInstanceResult.value = undefined;
  });

  it('saves and reports success when the token can list repositories', async () => {
    const wrapper = mountView();
    await nextTick();

    const probe = await saveThroughTheForm(wrapper);
    // The probe is the dashboard's own repositories load, addressed to the
    // instance the host just created.
    expect(state.loadRepositories).toHaveBeenCalledWith('inst-1', true);
    probe.replySucceeded();
    await nextTick();

    expect(wrapper.find('.status').text()).toContain('Instance saved successfully');
    expect(wrapper.find('.status').text()).not.toContain('read:repository');
    wrapper.unmount();
  });

  it('reports the missing scope when the token cannot list repositories', async () => {
    const wrapper = mountView();
    await nextTick();

    const probe = await saveThroughTheForm(wrapper);
    expect(state.loadRepositories).toHaveBeenCalledWith('inst-1', true);

    // The repositories call the dashboard starts with was refused: the token
    // lacks read:repository, and the /user test could not have seen that. This
    // is the exact sentence the host's API error layer renders for a 403.
    probe.replyFailed('Permission denied. The access token may lack the required scope.');
    await nextTick();

    const status = wrapper.find('.status').text();
    expect(status).toContain('read:repository');
    expect(status).toContain('Permission denied');
    expect(status).not.toContain('Instance saved successfully');
    // The instance stays saved: the token is valid, it just needs more scopes.
    expect(state.instances.value).toHaveLength(1);
    wrapper.unmount();
  });

  it('reports a connection failure as itself, not as a missing scope', async () => {
    const wrapper = mountView();
    await nextTick();

    const probe = await saveThroughTheForm(wrapper);
    expect(state.loadRepositories).toHaveBeenCalledWith('inst-1', true);

    // The probe never reached the instance, so nothing was refused and nothing
    // is known about the token's scopes. Naming read:repository here was a
    // cause the probe never established, and it sent the user to recreate a
    // token that is fine instead of looking at the connection.
    probe.replyFailed('Cannot connect to the instance. Check that it is running and that the URL is correct.');
    await nextTick();

    const status = wrapper.find('.status').text();
    expect(status).not.toContain('read:repository');
    expect(status).toContain('Cannot connect to the instance');
    // The save did succeed, and the status still says so.
    expect(status).toContain('Instance saved');
    expect(status).not.toContain('Instance saved successfully');
    wrapper.unmount();
  });

  it.each([
    [
      'The instance certificate is not trusted. The server presented a self-signed, expired or otherwise unverifiable certificate; install a trusted certificate on the instance, or add its certificate to your system trust store.',
    ],
    ['The request timed out. The instance is not responding.'],
  ])('reports a non-permission probe failure verbatim: %s', async (failure) => {
    const wrapper = mountView();
    await nextTick();

    const probe = await saveThroughTheForm(wrapper);
    probe.replyFailed(failure);
    await nextTick();

    const status = wrapper.find('.status').text();
    // The host's own message is kept, and no scope is claimed for it.
    expect(status).toContain(failure);
    expect(status).not.toContain('read:repository');
    wrapper.unmount();
  });
});
