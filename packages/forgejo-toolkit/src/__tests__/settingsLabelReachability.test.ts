import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every setting the page may write must have its label **somewhere in the page's own
 * sources**.
 *
 * This exists because of a gap the settings-page guards cannot see: they hold the
 * catalogue's mapping (`settings["forgejoToolkit.x"] = "settings.x.enabled"`) against the
 * manifest and the writable list, but nothing holds that mapping against the page. A
 * feature can therefore land with its manifest key, its writable entry, its group mapping,
 * its label strings and its parity lists all in place — and **no control rendered at all**,
 * green everywhere. That is exactly what happened to the notification-summary settings
 * (2026-10-06/07), and it is why this check reads the sources instead of the catalogue.
 *
 * What it **cannot** see, stated plainly rather than implied:
 *
 * - a key referenced only through a **dynamic** expression (`t(\`settings.${feature}.enabled\`)`)
 *   is a reference this scan will not find — the failure it reports is therefore "no
 *   literal mention anywhere", not "the page cannot render it";
 * - a key mentioned in a comment or a type counts as a mention, deliberately: this is a
 *   cheap guard against a whole control going missing, not a proof that a control renders;
 * - it says nothing about whether the control is reachable, enabled, or wired to the right
 *   setting id — the page's own suites hold that.
 */
const extensionRoot = join(__dirname, '..', '..');
const webviewRoot = join(extensionRoot, 'webview', 'src');

/** Every `.vue`/`.ts` source under the webview, concatenated for literal scanning. */
function webviewSources(): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(vue|ts)$/.test(entry.name) && !full.includes(`${join('src', '__tests__')}`)) {
        parts.push(readFileSync(full, 'utf8'));
      }
    }
  };
  walk(webviewRoot);
  // The page's own sources are the point, but `types/global.d.ts` and the entries are part
  // of the same bundle: a mention anywhere there is a mention.
  return parts.join('\n');
}

describe('the settings page names every setting it may write', () => {
  it('mentions each writable setting’s label key in the webview sources', () => {
    const catalogue = JSON.parse(readFileSync(join(webviewRoot, 'i18n', 'en.json'), 'utf8')) as {
      settings: Record<string, unknown>;
    };
    const sources = webviewSources();
    /**
     * Whether the sources mention this key **as a whole token**.
     *
     * A plain substring test is not enough, and that is not a theory: the first version of
     * this guard used one, and an injected rename of `settings.x.enabled` left it green
     * because `settings.x.enabledDefault` still contains that key as a prefix. A key counts
     * as mentioned only when nothing word-like, dotted or dashed touches either end of it.
     */
    const mentioned = (label: string): boolean =>
      new RegExp(`(?<![\\w.-])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`).test(sources);
    // The mapping itself is the source of truth here rather than the shared writable list:
    // the extension resolves that package through its build output, which a stale `dist`
    // would let this guard pass against vacuously (it did, on the first attempt). The
    // catalogue is the same file the page and `settingsSurface.test.ts` read, unbuilt.
    const unnamed = Object.entries(catalogue.settings)
      .filter(([key]) => key.startsWith('forgejoToolkit.'))
      .filter(([, label]) => typeof label === 'string' && !mentioned(label));

    expect(
      unnamed.map(
        ([key, label]) =>
          `${key}: the catalogue names "${String(label)}" as its label, but no webview source mentions that key, so nothing renders this setting`,
      ),
    ).toEqual([]);
  });
});
