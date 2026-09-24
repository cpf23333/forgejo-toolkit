import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, createTestRouter } from '../../__tests__/helpers/test-utils';

// `useAppState` posts to the extension host on setup; these tests mount it
// without the real webview API in scope, so the helper is stubbed.
vi.mock('../../composables/vscode', () => ({ postMessage: vi.fn() }));

function dispatchMessage(message: unknown) {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

function reactionMessage(repo: string, commentId: number) {
  return {
    command: 'commentReactions',
    instanceId: 'inst-1',
    owner: 'owner',
    repo,
    commentId,
    reactions: [{ content: '+1', user: { login: 'demo-user' } }],
  };
}

/**
 * `useRouter()` injects rather than throws, so a composable that installs a
 * router hook unconditionally breaks every caller mounted without a router.
 * Two standalone panels do exactly that: `OnboardingPanel.vue` and
 * `PullReviewCommentPanel.vue` mount `useAppState()` with only the i18n plugin
 * (see `main.ts`), and both must render without a router.
 */
describe('useAppState without a vue-router instance', () => {
  it('mounts a component that calls it without a router', async () => {
    vi.resetModules();
    const mod = await import('../../composables/useAppState');

    let state: ReturnType<typeof mod.useAppState> | undefined;
    expect(() => {
      mount(
        {
          template: '<div></div>',
          setup() {
            state = mod.useAppState();
            return {};
          },
        },
        { global: { plugins: [createTestI18n('en')] } },
      );
    }).not.toThrow();

    // The composable is usable, not merely non-throwing: the panels read
    // instances/locale from it on setup.
    expect(state).toBeDefined();
    expect(state!.instances.value).toEqual([]);
  });

  it('binds no route-driven repository scope, so no payload is released', async () => {
    vi.resetModules();
    const mod = await import('../../composables/useAppState');

    let state: ReturnType<typeof mod.useAppState> | undefined;
    mount(
      {
        template: '<div></div>',
        setup() {
          state = mod.useAppState();
          return {};
        },
      },
      { global: { plugins: [createTestI18n('en')] } },
    );

    // Without a router there is no `afterEach` hook, so no repository ever
    // becomes "active". Every message must therefore be kept: dropping the ones
    // past the shared cap would blank rows the panel still renders.
    for (let commentId = 1; commentId <= 70; commentId += 1) {
      dispatchMessage(reactionMessage('repo', commentId));
    }

    expect(state!.commentReactions.value.size).toBe(70);
    expect(state!.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'repo', 1))).toBe(true);
    expect(state!.commentReactions.value.has(mod.commentReactionsKey('inst-1', 'owner', 'repo', 70))).toBe(true);
  });
});

/**
 * The hook only exists when a router was injected, and the release it drives is
 * what keeps a long session from holding every repository it ever visited. Mount
 * with a router and prove the real path still releases the repository left
 * behind — the router-less case above only proves the composable survives the
 * absence of one.
 */
describe('useAppState with an injected router', () => {
  it('releases the payloads of the repository the user left behind', async () => {
    vi.resetModules();
    const mod = await import('../../composables/useAppState');
    const router = createTestRouter();

    let state: ReturnType<typeof mod.useAppState> | undefined;
    mount(
      {
        template: '<div></div>',
        setup() {
          state = mod.useAppState();
          return {};
        },
      },
      { global: { plugins: [router, createTestI18n('en')] } },
    );

    const push = (repo: string) =>
      router.push({ name: 'repoDetail', params: { instanceId: 'inst-1', owner: 'owner', repo } });

    await push('alpha');
    dispatchMessage(reactionMessage('alpha', 1));
    const alphaKey = mod.commentReactionsKey('inst-1', 'owner', 'alpha', 1);
    expect(state!.commentReactions.value.has(alphaKey)).toBe(true);

    // Moving on to another repository releases the one left behind: its rows
    // are off screen, and the views re-fetch them if the user returns.
    await push('beta');
    expect(state!.commentReactions.value.has(alphaKey)).toBe(false);
  });
});
