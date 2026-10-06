import { config, mount, type ComponentMountingOptions } from '@vue/test-utils';
import {
  SETTINGS_SURFACE_WRITABLE_KEYS,
  type SettingsSourceLevel,
  type SettingsSurfaceSnapshot,
  type SettingsSurfaceWritableKey,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { NOTIFICATION_POLLING_INTERVAL_DEFAULT_SECONDS } from '@cpf23333-forgejo-toolkit/shared/limits';
import { createAppRouter } from '../../router';
import { createI18nInstance, type Locale } from '../../i18n';
import { VSCODE_ELEMENT_STUBS } from './vscodeElements';
import type { Component } from 'vue';
import en from '../../i18n/en.json';
import zh from '../../i18n/zh.json';

export function createTestRouter() {
  return createAppRouter();
}

/**
 * The source map of the settings page's own surface, every key at one level.
 *
 * The page reads which configuration level each of its values comes from
 * (`docs/design/settings-page.md` §3.5) and marks the controls a level above the
 * user's own holds. A test that is about something else states the reading that
 * produces no marks at all — one level for every key — and a test that is about
 * the mark overrides the one key it means. A test that needs a whole reading does
 * not call this directly: `settingsSurfaceFixture()` below builds one, map
 * included.
 */
export function settingSources(
  level: SettingsSourceLevel = 'user',
): Record<SettingsSurfaceWritableKey, SettingsSourceLevel> {
  return Object.fromEntries(SETTINGS_SURFACE_WRITABLE_KEYS.map((key) => [key, level])) as Record<
    SettingsSurfaceWritableKey,
    SettingsSourceLevel
  >;
}

/**
 * One complete reading of the settings page's own surface: every key at the
 * manifest's default, and the whole source map (`docs/design/settings-page.md`
 * §3.2, §3.5).
 *
 * This is how a test states a reading — the map is **required** by the snapshot
 * type, so a fixture built without one could not compile, and building it here
 * rather than in each file is what makes "every fixture carries the map" one
 * decision instead of a dozen copies. `sources` is filled from `settingSources()`
 * before the overrides are spread, so a test about the marker overrides the one
 * key it means and still gets a total map for every other key.
 *
 * The defaults are the manifest's, i.e. what a fresh install reports; the level
 * every value comes from is the user's own unless a test says otherwise, which is
 * the reading that renders no source note anywhere.
 */
export function settingsSurfaceFixture(overrides: Partial<SettingsSurfaceSnapshot> = {}): SettingsSurfaceSnapshot {
  return {
    notificationPollingEnabled: true,
    notificationPollingInterval: NOTIFICATION_POLLING_INTERVAL_DEFAULT_SECONDS,
    useMockApi: false,
    mcpEnabled: true,
    mcpWriteTools: { createIssueComment: false, submitPullReview: false, cancelActionRun: false },
    mcpWriteAuditToFile: false,
    multiWindowLease: true,
    aiEnabled: true,
    aiPreReview: false,
    aiPreReviewPromptScope: 'ask',
    prDescription: false,
    prDescriptionPromptScope: 'ask',
    issueTriage: false,
    issueTriagePromptScope: 'ask',
    sources: settingSources(),
    ...overrides,
  };
}

/**
 * Builds an i18n instance with the requested language already on screen.
 *
 * The webview ships only the base catalog and loads the others on demand (see
 * `src/i18n/locales.ts`), but a component test mounts synchronously: a test that
 * asks for `zh` has to start in Chinese, not one async chunk later, and a test
 * that flips `i18n.global.locale.value = 'zh'` by hand has to find the catalog
 * there. Handing the catalogs to the factory is what keeps every existing
 * `createTestI18n('zh')` call site synchronous and unchanged. The tests that
 * care about the *lazy load* itself call `applyLocale` on a base-only instance
 * (`src/i18n/__tests__/localeCatalog.test.ts`).
 */
export function createTestI18n(locale: Locale = 'zh') {
  return createI18nInstance(locale, { en, zh });
}

export function mockVSCodeApi() {
  if (typeof window === 'undefined') {
    return;
  }

  (window as any).__FORGEJO_TOOLKIT_CONFIG__ = {
    vscodeVersion: '1.90.0',
  };

  if (!(window as any).acquireVsCodeApi) {
    (window as any).acquireVsCodeApi = () => ({
      postMessage: vi.fn(),
      getState: vi.fn(() => undefined),
      setState: vi.fn(),
    });
  }
}

export function stubVSCodeElements() {
  // One list, shared with the setup file: the tags the webview renders are
  // declared in ./vscodeElements.ts and kept in step with the sources by
  // ./vscodeElements.test.ts.
  config.global.stubs = {
    ...config.global.stubs,
    ...VSCODE_ELEMENT_STUBS,
  };
}

export function mountWithPlugins<T extends Component>(component: T, options: ComponentMountingOptions<T> = {}) {
  const router = createTestRouter();
  const i18n = createTestI18n();

  return mount(component, {
    global: {
      plugins: [router, i18n],
    },
    ...options,
  });
}
