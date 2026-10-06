import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the translation files that ship with the extension: the webview's
 * en/zh JSON pair and the host's l10n bundles. Both languages must define the
 * same keys, and every string interpolates the same placeholders — a missing key
 * shows a raw key in the UI, and a renamed placeholder shows `{count}` literally.
 *
 * The last two checks go the other way: a literal key used in the source that is
 * absent from the bundle means an untranslated string at runtime. Only string
 * literals are checked; computed keys cannot be verified statically.
 */
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const webviewI18nDir = path.join(packageRoot, 'webview', 'src', 'i18n');
const l10nDir = path.join(packageRoot, 'l10n');

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function flatten(value: unknown, prefix = ''): Map<string, string> {
  const entries = new Map<string, string>();
  if (value === null || typeof value !== 'object') {
    entries.set(prefix, String(value));
    return entries;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    for (const [childKey, childValue] of flatten(child, keyPath)) {
      entries.set(childKey, childValue);
    }
  }
  return entries;
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort();
}

function walk(dir: string, extensions: string[]): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      files.push(...walk(full, extensions));
    } else if (extensions.some((extension) => entry.endsWith(extension))) {
      files.push(full);
    }
  }
  return files;
}

/** Collects the string literals passed to every matching call form. */
function collectLiteralKeys(files: string[], pattern: RegExp): Map<string, string> {
  const keys = new Map<string, string>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) {
      const key = match[1];
      if (!keys.has(key)) keys.set(key, path.relative(packageRoot, file));
    }
  }
  return keys;
}

describe('webview i18n bundles', () => {
  const en = flatten(readJson(path.join(webviewI18nDir, 'en.json')));
  const zh = flatten(readJson(path.join(webviewI18nDir, 'zh.json')));

  it('defines the same keys in both languages', () => {
    const missingInZh = [...en.keys()].filter((key) => !zh.has(key));
    const missingInEn = [...zh.keys()].filter((key) => !en.has(key));
    expect({ missingInZh, missingInEn }).toEqual({ missingInZh: [], missingInEn: [] });
  });

  it('keeps every value non-empty', () => {
    const empty = [...en, ...zh].filter(([, value]) => value.trim() === '').map(([key]) => key);
    expect(empty).toEqual([]);
  });

  it('interpolates the same placeholders in both languages', () => {
    const mismatched = [...en.keys()]
      .filter((key) => zh.has(key))
      .filter((key) => placeholders(en.get(key) ?? '').join(',') !== placeholders(zh.get(key) ?? '').join(','))
      .map((key) => ({
        key,
        en: placeholders(en.get(key) ?? ''),
        zh: placeholders(zh.get(key) ?? ''),
      }));
    expect(mismatched).toEqual([]);
  });

  it('is reachable: every literal key used in the webview exists', () => {
    // `t('…')` is the i18n helper's call form across the webview sources.
    const used = collectLiteralKeys(
      walk(path.join(packageRoot, 'webview', 'src'), ['.vue', '.ts']),
      /\bt\(\s*'([^'$\\]+)'/g,
    );
    const unknown = [...used].filter(([key]) => !en.has(key));
    expect(unknown).toEqual([]);
  });

  it('pins the status-check states the checks panel can label', () => {
    // The case above reads single-quoted `t('…')` literals only, so it cannot
    // see a key the source builds with a template literal — and the pull request
    // checks panel builds exactly that one:
    // `dashboard.detail.checksState.${statusChecks.state}`. `statusChecks.state`
    // is the server's combined status passed straight through, so an
    // unanticipated value printed the raw key with every check still green. This
    // case pins the enumeration both catalogs have to define, which also means a
    // new Forgejo state has to be added here (and given wording in `en.json` and
    // `zh.json`) on purpose rather than slipping through as a raw key again.
    // The panel's fallback for an unlisted state is exercised in
    // `webview/src/views/__tests__/PullRequestDetail.checksStateLabel.test.ts`.
    const prefix = 'dashboard.detail.checksState.';
    const labelled = (bundle: Map<string, string>) =>
      [...bundle.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .sort();
    const states = ['error', 'failure', 'pending', 'skipped', 'success', 'unknown', 'warning'];
    expect(labelled(en)).toEqual(states);
    expect(labelled(zh)).toEqual(states);
  });
});

describe('host l10n bundles', () => {
  const en = flatten(readJson(path.join(l10nDir, 'bundle.l10n.json')));
  const zh = flatten(readJson(path.join(l10nDir, 'bundle.l10n.zh-cn.json')));

  it('defines the same keys in both bundles', () => {
    const missingInZh = [...en.keys()].filter((key) => !zh.has(key));
    const missingInEn = [...zh.keys()].filter((key) => !en.has(key));
    expect({ missingInZh, missingInEn }).toEqual({ missingInZh: [], missingInEn: [] });
  });

  it('interpolates the same placeholders in both bundles', () => {
    const mismatched = [...en.keys()]
      .filter((key) => zh.has(key))
      .filter((key) => placeholders(en.get(key) ?? '').join(',') !== placeholders(zh.get(key) ?? '').join(','))
      .map((key) => ({
        key,
        en: placeholders(en.get(key) ?? ''),
        zh: placeholders(zh.get(key) ?? ''),
      }));
    expect(mismatched).toEqual([]);
  });

  it('is reachable: every literal l10n.t() key exists in the bundle', () => {
    const used = collectLiteralKeys(
      walk(path.join(packageRoot, 'src'), ['.ts']),
      /(?:l10n\.t|translate)\(\s*'((?:[^'\\]|\\.)+)'/g,
    );
    const unknown = [...used].filter(([key]) => !en.has(key));
    expect(unknown).toEqual([]);
  });

  it('spells every key exactly as the source spells it', () => {
    // The check above reads single-quoted literals only, and it goes
    // source → bundle. This one is the other direction and is quote-agnostic:
    // a bundle key must appear verbatim in a source file, because that is the
    // string `vscode.l10n.t` is called with at runtime. A key that differs by
    // even one escape — `model\'s input budget` against the source's
    // `model's input budget` — never matches the lookup, and the UI then shows
    // the English source string in a translated window, silently and with no
    // error anywhere. That is the defect this test was added for: the two
    // bundles stored that one key with a backslash-escaped apostrophe, so the
    // Chinese `bundle.l10n.zh-cn.json` entry for the budget failure never
    // resolved.
    const sources = walk(path.join(packageRoot, 'src'), ['.ts']).map((file) => readFileSync(file, 'utf8'));
    const keys = new Set([...en.keys(), ...zh.keys()]);
    const unknown = [...keys].filter((key) => !sources.some((source) => source.includes(key)));
    expect(unknown).toEqual([]);
  });

  it('carries the dashboard README notice keys in both bundles', () => {
    // The README sentence for a symlink or submodule is built by the extension
    // host's dashboard (viewProvider) rather than by the API client, because that
    // is the localized surface; its keys therefore have to exist in both bundles
    // with the same placeholder, or a Chinese UI shows either the English
    // sentence or a raw `{0}`.
    const keys = [
      'README.md is a symlink to {0}, so Forgejo has no README text to show. Open {0} in the Forgejo web UI to read it.',
      'README.md is a submodule whose own repository is at {0}, so this repository has no README text to show. Open the submodule in the Forgejo web UI to read it there.',
      'README.md is not a regular file in this repository, so Forgejo has no README text to show. Open it in the Forgejo web UI to read it.',
    ];
    for (const key of keys) {
      expect(en.has(key), `en: ${key}`).toBe(true);
      expect(zh.has(key), `zh: ${key}`).toBe(true);
      expect(placeholders(zh.get(key) ?? ''), key).toEqual(placeholders(key));
      expect((zh.get(key) ?? '').trim(), key).not.toBe('');
    }
  });
});

describe('manifest nls pairs', () => {
  const manifest = readJson(path.join(packageRoot, 'package.json')) as {
    contributes: {
      configuration: {
        properties: Record<
          string,
          {
            title?: string;
            description?: string;
            type?: string;
            default?: unknown;
            enum?: unknown;
            enumDescriptions?: unknown;
          }
        >;
      };
    };
  };
  const en = flatten(readJson(path.join(packageRoot, 'package.nls.json')));
  const zh = flatten(readJson(path.join(packageRoot, 'package.nls.zh-cn.json')));

  it('defines the same keys in both nls files', () => {
    const missingInZh = [...en.keys()].filter((key) => !zh.has(key));
    const missingInEn = [...zh.keys()].filter((key) => !en.has(key));
    expect({ missingInZh, missingInEn }).toEqual({ missingInZh: [], missingInEn: [] });
  });

  it('resolves every %placeholder% the manifest uses in both nls files', () => {
    // The manifest is the one file VS Code reads both languages of, so a
    // placeholder missing from either nls file shows a raw `%config.…%` in the
    // Settings UI or the command palette rather than falling back to English.
    const used = [...readFileSync(path.join(packageRoot, 'package.json'), 'utf8').matchAll(/%([^%"]+)%/g)].map(
      (match) => match[1],
    );
    const unresolvedInEn = used.filter((key) => !en.has(key));
    const unresolvedInZh = used.filter((key) => !zh.has(key));
    expect({ unresolvedInEn, unresolvedInZh }).toEqual({ unresolvedInEn: [], unresolvedInZh: [] });
  });

  it('gives the AI pre-review, the endpoint and the MCP write settings a name from the pair', () => {
    // A setting with no `title` is labelled from its own key, so
    // `forgejoToolkit.aiPreReview` renders as "Forgejo Toolkit: Ai Pre Review"
    // — an English, mis-capitalized name — in every UI language, while its
    // description is translated. The names therefore have to come from the nls
    // pair like every other manifest string (AGENTS.md, i18n / host-side
    // strings), starting with the settings added by these changes. The three
    // settings the settings page presents with its own control and that had no
    // name yet (`notificationPollingEnabled`, `mcpEnabled`, `multiWindowLease`)
    // joined the list with it: the page's header opens VS Code's settings editor
    // filtered to this extension, so those entries are now a surface a user reads.
    // The last two to join are `notificationPollingInterval` and `useMockApi`,
    // which the page renders itself since 2026-10-06 — a setting whose control is
    // on the page is a name the reader meets there and in that filtered editor.
    const titled = Object.keys(manifest.contributes.configuration.properties).filter(
      (key) => typeof manifest.contributes.configuration.properties[key]?.title === 'string',
    );
    expect(titled).toEqual([
      'forgejoToolkit.notificationPollingEnabled',
      'forgejoToolkit.notificationPollingInterval',
      'forgejoToolkit.useMockApi',
      'forgejoToolkit.mcpEnabled',
      'forgejoToolkit.mcpWriteTools.createIssueComment',
      'forgejoToolkit.mcpWriteTools.submitPullReview',
      'forgejoToolkit.mcpWriteTools.cancelActionRun',
      'forgejoToolkit.mcpWriteAuditToFile',
      'forgejoToolkit.multiWindowLease',
      'forgejoToolkit.aiEnabled',
      'forgejoToolkit.aiPreReview',
      'forgejoToolkit.aiPreReviewPromptScope',
      'forgejoToolkit.aiPreReviewModel',
      'forgejoToolkit.prDescription',
      'forgejoToolkit.prDescriptionPromptScope',
      'forgejoToolkit.aiProviders',
      'forgejoToolkit.aiTransport',
      'forgejoToolkit.aiDefaultProvider',
      'forgejoToolkit.aiDefaultModel',
      'forgejoToolkit.aiModelBindings',
      'forgejoToolkit.aiModelRequestTimeoutMs',
    ]);
    const names = [
      'config.notificationPollingEnabled.title',
      'config.notificationPollingInterval.title',
      'config.useMockApi.title',
      'config.mcpEnabled.title',
      'config.mcpWriteTools.createIssueComment.title',
      'config.mcpWriteTools.submitPullReview.title',
      'config.mcpWriteTools.cancelActionRun.title',
      'config.mcpWriteAuditToFile.title',
      'config.multiWindowLease.title',
      'config.aiEnabled.title',
      'config.aiPreReview.title',
      'config.aiPreReviewPromptScope.title',
      'config.aiPreReviewModel.title',
      'config.prDescription.title',
      'config.prDescriptionPromptScope.title',
      'config.aiProviders.title',
      'config.aiTransport.title',
      'config.aiDefaultProvider.title',
      'config.aiDefaultModel.title',
      'config.aiModelBindings.title',
      'config.aiModelRequestTimeoutMs.title',
      'command.aiPreReviewPullRequest.title',
      'command.aiPreReviewChooseModel.title',
      'command.aiTestProvider.title',
      // The settings page's own way into the native settings editor: a second
      // entry whose title must not read like the existing "Open Settings" one,
      // which opens this page.
      'command.openNativeSettings.title',
      // The view-title refresh items: the icon is all a menu shows, so the
      // command's title *is* the tooltip that says what a press re-reads, and
      // each of the five names a different target.
      'command.refreshInstances.title',
      'command.refreshRepository.title',
      'command.refreshIssue.title',
      'command.refreshPullRequest.title',
      'command.refreshNotifications.title',
    ];
    for (const key of names) {
      expect(en.get(key), `en: ${key}`).toBeTruthy();
      expect(zh.get(key), `zh: ${key}`).toBeTruthy();
      expect(zh.get(key), key).not.toBe(en.get(key));
    }
  });

  it('contributes the prompt scope as a real dropdown, described in both languages', () => {
    // The scope is a **static** enum, so — unlike the model choice, whose list
    // only exists at runtime — VS Code can render a real dropdown. Both nls
    // pairs have to carry every value's description, because a missing
    // `enumDescriptions` entry shows the raw `%config.…%` placeholder in the
    // dropdown, which is where the egress decision is actually explained.
    const property = manifest.contributes.configuration.properties['forgejoToolkit.aiPreReviewPromptScope'];
    const values = ['ask', 'metadata-only', 'changed-lines-only', 'full-diff', 'changed-files'];
    const descriptions = (Array.isArray(property?.enumDescriptions) ? property.enumDescriptions : []) as unknown[];
    expect(property?.type).toBe('string');
    expect(property?.default).toBe('ask');
    expect(property?.enum).toEqual(values);
    expect(descriptions).toHaveLength(values.length);

    // Every description says what actually leaves the machine — the honest
    // wording the whole setting exists for — in both languages.
    const statesEgress: Record<string, string> = {
      ask: 'nothing is requested, sent or written until you answer',
      'metadata-only': 'Send no code at all',
      'changed-lines-only': 'Send the changed lines of code only',
      'full-diff': 'Send the whole diff',
      'changed-files': 'full text of every changed file',
    };
    for (const [index, value] of values.entries()) {
      const placeholder = String(descriptions[index] ?? '');
      expect(placeholder, value).toMatch(/^%config\.aiPreReviewPromptScope\.enumDescriptions\.[a-zA-Z]+%$/);
      const key = placeholder.slice(1, -1);
      const english = en.get(key) ?? '';
      const chinese = zh.get(key) ?? '';
      expect(english, `en: ${key}`).toContain(statesEgress[value]);
      expect(chinese, `zh: ${key}`).not.toBe('');
      expect(chinese, `zh: ${key}`).not.toBe(english);
      expect(chinese.length, `zh: ${key}`).toBeGreaterThan(30);
    }
  });

  it('contributes the PR-description scope as a real dropdown, described in both languages', () => {
    // The same contract as the pre-review's scope above, for the second feature
    // that has one (`docs/design/ai-model-transport.md` §7.6): a **static** enum
    // VS Code can render, and every value's description in both nls pairs, because
    // a missing `enumDescriptions` entry shows the raw `%config.…%` placeholder in
    // the dropdown — the one place the egress of each answer is explained.
    const property = manifest.contributes.configuration.properties['forgejoToolkit.prDescriptionPromptScope'];
    const values = ['ask', 'commits-only', 'commits-and-files'];
    const descriptions = (Array.isArray(property?.enumDescriptions) ? property.enumDescriptions : []) as unknown[];
    expect(property?.type).toBe('string');
    expect(property?.default).toBe('ask');
    expect(property?.enum).toEqual(values);
    expect(descriptions).toHaveLength(values.length);

    const statesEgress: Record<string, string> = {
      ask: 'nothing is requested, sent or written until you answer',
      'commits-only': 'No file content leaves the machine',
      'commits-and-files': 'plus the full text of the changed files at the head branch',
    };
    for (const [index, value] of values.entries()) {
      const placeholder = String(descriptions[index] ?? '');
      expect(placeholder, value).toMatch(/^%config\.prDescriptionPromptScope\.enumDescriptions\.[a-zA-Z]+%$/);
      const key = placeholder.slice(1, -1);
      const english = en.get(key) ?? '';
      const chinese = zh.get(key) ?? '';
      expect(english, `en: ${key}`).toContain(statesEgress[value]);
      expect(chinese, `zh: ${key}`).not.toBe('');
      expect(chinese, `zh: ${key}`).not.toBe(english);
      expect(chinese.length, `zh: ${key}`).toBeGreaterThan(30);
    }
  });
});
