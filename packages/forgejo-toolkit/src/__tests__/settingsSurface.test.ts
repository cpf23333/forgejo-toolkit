import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { SETTINGS_SURFACE_WRITABLE_KEYS } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { NATIVE_ONLY_SETTINGS, readSettingsSurface, writeSettingsSurfaceValue } from '../webview/settingsSurface';

/**
 * The drift guard (`docs/design/settings-page.md` §6) and the host half of the
 * settings page's own surface.
 *
 * A new setting can fail in exactly one way that nobody notices: it is **neither**
 * rendered by this page **nor** listed as deliberately native-only, so it is
 * silently absent from every place a user could find it. The record's §1.3 table
 * is the decision; this file is what keeps the decision true, by holding three
 * things against each other:
 *
 * 1. the manifest's configuration keys (what exists),
 * 2. the webview's English string catalogue (what the page renders — every
 *    rendered setting has an entry keyed by its full id there), and
 * 3. `NATIVE_ONLY_SETTINGS` (what stays native, with the reason).
 *
 * Both-absent **and** both-present fail: the second means the page started
 * rendering a setting the policy still calls native-only, which is precisely the
 * "two writable sources" state §7.1 forbids.
 *
 * The rest of the file exercises the surface's own two operations: the read comes
 * from the same readers the features use, and the write validates untrusted input
 * without ever echoing a value it was handed.
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface ManifestShape {
  contributes: { configuration: { properties: Record<string, unknown> } };
}

const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as ManifestShape;
const manifestKeys = Object.keys(manifest.contributes.configuration.properties);

const readCatalogue = (locale: 'en' | 'zh') =>
  JSON.parse(readFileSync(path.join(packageRoot, 'webview', 'src', 'i18n', `${locale}.json`), 'utf8')) as {
    settings: Record<string, unknown>;
  };

const en = readCatalogue('en');
const zh = readCatalogue('zh');

/** The rendered settings: the catalogue keys that are a setting's full id. */
const renderedKeys = Object.keys(en.settings).filter((key) => key.startsWith('forgejoToolkit.'));
const nativeOnly = new Map(NATIVE_ONLY_SETTINGS.map((entry) => [entry.key, entry.reason]));

const settingsSource = readFileSync(path.join(packageRoot, 'webview', 'src', 'views', 'Settings.vue'), 'utf8');

describe('the settings page ownership policy', () => {
  it('accounts for every configuration key exactly once', () => {
    const violations: string[] = [];
    for (const key of manifestKeys) {
      const rendered = renderedKeys.includes(key);
      const native = nativeOnly.has(key);
      if (!rendered && !native) {
        violations.push(
          `${key}: neither rendered by the settings page nor listed as native-only — render it and add its ` +
            'id to the webview string catalogue, or add it to NATIVE_ONLY_SETTINGS with a reason',
        );
      }
      if (rendered && native) {
        violations.push(
          `${key}: both rendered by the settings page and listed as native-only — the page renders it now, so ` +
            'remove it from NATIVE_ONLY_SETTINGS (one value may have one writable source)',
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('holds the same native-only settings the record decides', () => {
    // Named literally: a setting that quietly moves between the two lists is the
    // drift this guard exists for, and the record's §1.3 is what these two are.
    // `aiTransport` used to be a third and is rendered now — the choice decides
    // which half of the AI area the page presents, so the page has to make it.
    expect([...nativeOnly.keys()].sort()).toEqual([
      'forgejoToolkit.notificationPollingInterval',
      'forgejoToolkit.useMockApi',
    ]);
  });

  it('names a real manifest key and a reason for every native-only entry', () => {
    const unknown = NATIVE_ONLY_SETTINGS.filter((entry) => !manifestKeys.includes(entry.key)).map(
      (entry) => `${entry.key}: not a configuration key the manifest contributes`,
    );
    const reasonless = NATIVE_ONLY_SETTINGS.filter((entry) => entry.reason.trim() === '').map(
      (entry) => `${entry.key}: native-only without a reason`,
    );
    expect([...unknown, ...reasonless]).toEqual([]);
  });

  it('points every rendered setting at a string the page actually has', () => {
    // A rendered id's catalogue value is the key of the label the page shows for
    // it, so the mapping cannot rot in either direction: a value that names
    // nothing is a failure here, and a missing id is a failure above.
    const broken = renderedKeys
      .filter((id) => typeof en.settings[id] !== 'string' || (en.settings[id] as string).trim() === '')
      .map((id) => `${id}: the catalogue entry is not a label key`);
    const unresolvable = renderedKeys
      .map((id) => ({ id, labelKey: en.settings[id] as string }))
      .filter(({ labelKey }) => {
        const found = flatten(en).get(labelKey);
        return typeof found !== 'string' || found.trim() === '';
      })
      .map(({ id, labelKey }) => `${id}: "${labelKey}" is not a string in en.json`);
    const untranslated = renderedKeys
      .map((id) => ({ id, labelKey: en.settings[id] as string }))
      .filter(({ labelKey }) => {
        const found = flatten(zh).get(labelKey);
        return typeof found !== 'string' || found.trim() === '';
      })
      .map(({ id, labelKey }) => `${id}: "${labelKey}" is not a string in zh.json`);
    expect([...broken, ...unresolvable, ...untranslated]).toEqual([]);
  });

  it('lists only settings the page renders as writable from the page', () => {
    const notRendered = SETTINGS_SURFACE_WRITABLE_KEYS.filter((key) => !renderedKeys.includes(key)).map(
      (key) => `${key}: writable from the page but not in the rendered catalogue`,
    );
    expect(notRendered).toEqual([]);
  });

  it('spells every pointer as the id the policy names, and never mentions the dev switch', () => {
    // §2.2: the two native-only settings with a pointer row are named on the page
    // by their full ids (`Settings.vue` declares them as constants and the pointer
    // rows render them), and `useMockApi` is mentioned nowhere the user can see —
    // it is a development switch, and naming it is what would make it look like a
    // feature. The check reads the page's *markup* (comments stripped: a source
    // comment for maintainers is not the page) and the English catalogue, which is
    // where every sentence the user reads is written.
    const missing = [...nativeOnly.keys()]
      .filter((key) => key !== 'forgejoToolkit.useMockApi')
      .filter((key) => !settingsSource.includes(key))
      .map((key) => `${key}: the policy gives it a pointer row, but Settings.vue does not name it`);
    expect(missing).toEqual([]);
    expect(templateWithoutComments(settingsSource)).not.toContain('useMockApi');
    expect(JSON.stringify(en.settings)).not.toContain('useMockApi');
  });
});

describe('the settings page surface: reading', () => {
  it('reads each switch through the reader the behaviour itself uses', () => {
    // The default `vscode` mock answers every configuration read with
    // `undefined`, which is exactly the "nothing is configured" case. The
    // expected snapshot is therefore each reader's own closed/default answer —
    // including the two switches whose default is on, which is what proves the
    // page reads the features' rules rather than assuming `false`.
    expect(readSettingsSurface({ isNotificationPollingEnabled: () => true })).toEqual({
      notificationPollingEnabled: true,
      mcpEnabled: true,
      mcpWriteTools: { createIssueComment: false, submitPullReview: false, cancelActionRun: false },
      mcpWriteAuditToFile: false,
      multiWindowLease: true,
      aiPreReview: false,
      aiPreReviewPromptScope: 'ask',
      prDescription: false,
      prDescriptionPromptScope: 'ask',
    });
  });

  it('reports the notification switch exactly as the poller reads it', () => {
    expect(readSettingsSurface({ isNotificationPollingEnabled: () => false }).notificationPollingEnabled).toBe(false);
  });
});

describe('the settings page surface: writing', () => {
  const update = vi.fn(async () => undefined);
  const get = vi.fn((key: string): unknown => (key === 'mcpEnabled' ? false : undefined));

  afterEach(() => {
    update.mockReset();
    update.mockImplementation(async () => undefined);
    get.mockClear();
    vi.mocked(vscode.workspace.getConfiguration).mockReset();
  });

  /** Points the mocked configuration at this file's spies. */
  function useConfiguration(): void {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get, update } as never);
  }

  it('writes a boolean at global scope, with the key without its section', async () => {
    useConfiguration();

    expect(await writeSettingsSurfaceValue('forgejoToolkit.notificationPollingEnabled', true)).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith('notificationPollingEnabled', true, vscode.ConfigurationTarget.Global);
  });

  it('writes one write tool as its own dotted key, and never as the container', async () => {
    // A live walkthrough hit the editor's own refusal on all three switches: the
    // page wrote the **container** `forgejoToolkit.mcpWriteTools`, which the
    // manifest does not contribute (it contributes only the three dotted keys), so
    // the write was refused as an unregistered setting. The write has to address
    // the same key the manifest declares — and because it writes one dotted key,
    // a tool a newer build added is simply a key nothing here writes.
    expect(manifestKeys).toContain('forgejoToolkit.mcpWriteTools.createIssueComment');
    expect(manifestKeys).not.toContain('forgejoToolkit.mcpWriteTools');
    get.mockImplementation((key: string) => (key === 'mcpWriteTools' ? { futureTool: true } : undefined));
    useConfiguration();

    expect(await writeSettingsSurfaceValue('forgejoToolkit.mcpWriteTools.createIssueComment', true)).toEqual({
      ok: true,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('mcpWriteTools.createIssueComment', true, vscode.ConfigurationTarget.Global);
    // The unknown neighbour is not part of the write at all.
    expect(update).not.toHaveBeenCalledWith('mcpWriteTools', expect.anything(), expect.anything());
  });

  it('turns a write tool off through its own dotted key', async () => {
    get.mockImplementation((key: string) => (key === 'mcpWriteTools' ? { cancelActionRun: true } : undefined));
    useConfiguration();

    expect(await writeSettingsSurfaceValue('forgejoToolkit.mcpWriteTools.cancelActionRun', false)).toEqual({
      ok: true,
    });
    expect(update).toHaveBeenCalledWith('mcpWriteTools.cancelActionRun', false, vscode.ConfigurationTarget.Global);
  });

  it('leaves a write tool alone when the reader already reports that value', async () => {
    // The current value is read through the reader the behaviour itself uses
    // (`enabledMcpWriteTools`): an explicit `true` is on, everything else is off.
    get.mockImplementation((key: string) => (key === 'mcpWriteTools' ? { submitPullReview: true } : undefined));
    useConfiguration();

    expect(await writeSettingsSurfaceValue('forgejoToolkit.mcpWriteTools.submitPullReview', true)).toEqual({
      ok: true,
    });
    expect(await writeSettingsSurfaceValue('forgejoToolkit.mcpWriteTools.createIssueComment', false)).toEqual({
      ok: true,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('writes a switch whose stored value is not a boolean, rather than trusting it', async () => {
    // `"true"` is not `true`: the reader calls that tool off, so clicking the
    // switch on has to reach the setting.
    get.mockImplementation((key: string) => (key === 'mcpWriteTools' ? { createIssueComment: 'true' } : undefined));
    useConfiguration();

    expect(await writeSettingsSurfaceValue('forgejoToolkit.mcpWriteTools.createIssueComment', true)).toEqual({
      ok: true,
    });
    expect(update).toHaveBeenCalledWith('mcpWriteTools.createIssueComment', true, vscode.ConfigurationTarget.Global);
  });

  it('accepts every value of the prompt scope and nothing else', async () => {
    useConfiguration();

    for (const scope of ['ask', 'metadata-only', 'changed-lines-only', 'full-diff', 'changed-files']) {
      expect(await writeSettingsSurfaceValue('forgejoToolkit.aiPreReviewPromptScope', scope), scope).toEqual({
        ok: true,
      });
    }
    const refused = await writeSettingsSurfaceValue('forgejoToolkit.aiPreReviewPromptScope', 'changed');
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toContain('it takes one of');
    expect(refused.ok === false && refused.error).toContain('changed-files');
  });

  it('accepts every value of the PR-description scope and nothing else', async () => {
    // The second feature's scope has its own enumeration: the pre-review's values
    // describe line-level review content and mean something else here, so a value
    // only one of the two enumerations knows must be refused rather than stored.
    useConfiguration();

    for (const scope of ['ask', 'commits-only', 'commits-and-files']) {
      expect(await writeSettingsSurfaceValue('forgejoToolkit.prDescriptionPromptScope', scope), scope).toEqual({
        ok: true,
      });
    }
    expect(update).toHaveBeenLastCalledWith(
      'prDescriptionPromptScope',
      'commits-and-files',
      vscode.ConfigurationTarget.Global,
    );
    const refused = await writeSettingsSurfaceValue('forgejoToolkit.prDescriptionPromptScope', 'changed-files');
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toContain('it takes one of');
    expect(refused.ok === false && refused.error).toContain('commits-and-files');
    expect(refused.ok === false && refused.error).not.toContain('changed-files,');
  });

  it('refuses a key the page does not own', async () => {
    useConfiguration();

    const refused = await writeSettingsSurfaceValue('forgejoToolkit.aiProviders', []);
    expect(refused.ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a value of the wrong type without echoing it', async () => {
    // The webview is untrusted input: a forged message can put anything in
    // `value`, so the refusal names the setting and the shape and never the value
    // — otherwise the host would print a credential into the page and the log.
    useConfiguration();

    const secret = 'sk-should-never-be-printed';
    const refused = await writeSettingsSurfaceValue('forgejoToolkit.mcpEnabled', secret);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toContain('forgejoToolkit.mcpEnabled');
    expect(refused.ok === false && refused.error).toContain('on or off');
    expect(refused.ok === false && refused.error).not.toContain(secret);
    expect(update).not.toHaveBeenCalled();
  });

  it("reports a failed write with the editor's own sentence", async () => {
    update.mockRejectedValue(new Error('no write access'));
    useConfiguration();

    const refused = await writeSettingsSurfaceValue('forgejoToolkit.multiWindowLease', false);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toContain('forgejoToolkit.multiWindowLease');
    expect(refused.ok === false && refused.error).toContain('no write access');
  });
});

/** Flattens one catalogue into dotted key paths, the way the i18n parity test reads it. */
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

/** The page's markup with its HTML comments removed: what a user can read. */
function templateWithoutComments(source: string): string {
  const start = source.indexOf('<template>');
  const end = source.lastIndexOf('</template>');
  const template = start >= 0 && end > start ? source.slice(start, end) : source;
  return template.replace(/<!--[\s\S]*?-->/g, '');
}
