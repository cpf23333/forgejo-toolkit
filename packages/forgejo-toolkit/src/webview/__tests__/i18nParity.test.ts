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
