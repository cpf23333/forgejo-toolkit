// Tests for what the launcher writes into the isolated profile
// (`src/config.ts`'s `seedProfileSettings`).
//
// The AI half of the seed is the harness's "no hand-editing" promise, so it is
// pinned here rather than only in the README:
//
//  1. the settings the extension actually reads are the ones written — a provider
//     whose base URL carries the port the endpoint bound, the transport choice and
//     **a binding for every AI feature the extension declares** (the measured gap:
//     only `aiPreReview` was bound, so the `prDescription` feature added later
//     could not draft until a walkthrough typed its binding into the profile by
//     hand) — and **no** key the extension's manifest does not contribute, which is
//     the check the seed's own `forgejoToolkit.aiProvidersEnabled` needed for the
//     months it kept writing a setting that had been deleted;
//  2. **no credential is written, ever**: the seeded provider authenticates
//     nothing, so there is nothing to write, and the file is asserted to carry no
//     key-shaped text at all;
//  3. the two prompt-scope settings are deliberately left alone: their default
//     `ask` *is* the consent question a human has to answer, and seeding an answer
//     would skip the only step this harness cannot automate;
//  4. seeding is additive and idempotent: another provider, another feature's
//     binding and every unrelated setting survive, a feature bound to some other
//     provider is never overwritten, a second seed does not duplicate anything,
//     and a binding this harness wrote before is refreshed to the new port.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AI_MOCK_HOST, AI_MOCK_MODEL_ID } from './aiMockServer';
import {
  AI_FEATURES_SOURCE,
  AI_MOCK_PROVIDER_ID,
  parseDeclaredAiFeatures,
  readDeclaredAiFeatures,
  seedProfileSettings,
  type AiEndpointSeed,
} from './config';

function tempProfile(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ui-review-config-'));
}

function settingsOf(profileDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(profileDir, 'User', 'settings.json'), 'utf8')) as Record<string, unknown>;
}

function writeSettings(profileDir: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.join(profileDir, 'User'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'User', 'settings.json'), JSON.stringify(settings, null, 2));
}

/** The endpoint the launcher would pass for a mock server on `port`. */
function seedFor(port: number): AiEndpointSeed {
  return { baseUrl: `http://${AI_MOCK_HOST}:${port}/v1` };
}

/** The bindings a seed wrote, as `feature -> providerId`, keyed by feature. */
function bindingsOf(settings: Record<string, unknown>): Map<string, string> {
  const bindings = settings['forgejoToolkit.aiModelBindings'] as Array<{ feature: string; providerId: string }>;
  return new Map(bindings.map((binding) => [binding.feature, binding.providerId]));
}

/** The features the extension's own source declares, read the way the seed reads them. */
function declaredFeatures(): string[] {
  const features = readDeclaredAiFeatures();
  assert.ok(features !== undefined, `could not read ${AI_FEATURES_SOURCE} — the seed's feature list is a guess`);
  return features;
}

test('an AI endpoint seed writes exactly the settings the extension reads', () => {
  const profileDir = tempProfile();
  seedProfileSettings(profileDir, { aiEndpoint: seedFor(43210) });
  const settings = settingsOf(profileDir);

  assert.equal(settings['forgejoToolkit.useMockApi'], true, 'the mock API default is unchanged');
  assert.equal(settings['forgejoToolkit.aiTransport'], 'openai-compatible');
  assert.equal(settings['forgejoToolkit.aiPreReview'], true);
  assert.deepEqual(settings['forgejoToolkit.aiProviders'], [
    {
      id: AI_MOCK_PROVIDER_ID,
      name: 'Local mock endpoint (tools/ui-review)',
      baseUrl: `http://${AI_MOCK_HOST}:43210/v1`,
      models: [{ id: AI_MOCK_MODEL_ID, name: 'Mock pre-review model' }],
      auth: 'none',
      headers: [],
    },
  ]);
  assert.deepEqual(
    settings['forgejoToolkit.aiModelBindings'],
    declaredFeatures().map((feature) => ({ feature, providerId: AI_MOCK_PROVIDER_ID, modelId: AI_MOCK_MODEL_ID })),
    'every feature the extension declares is bound to the harness endpoint',
  );
  // The gap this pins: `prDescription` was added to the extension after the seed
  // was written for `aiPreReview` alone, so a mock-backed run left it unbound.
  assert.ok(
    (settings['forgejoToolkit.aiModelBindings'] as Array<{ feature: string }>).some(
      (binding) => binding.feature === 'prDescription',
    ),
    'prDescription is bound too',
  );
  // The consent questions stay unanswered on purpose (see the file comment).
  assert.equal('forgejoToolkit.aiPreReviewPromptScope' in settings, false);
  assert.equal('forgejoToolkit.prDescriptionPromptScope' in settings, false);
});

test('every key the seed writes is one the extension still contributes', () => {
  // `forgejoToolkit.aiProvidersEnabled` was written here for months after the
  // extension deleted the setting, because nothing compared the seed against the
  // one file that says which keys exist. The manifest is that file, and this is the
  // comparison: a key the seed writes and the manifest does not contribute is a
  // profile entry nothing reads.
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'packages', 'forgejo-toolkit', 'package.json'), 'utf8'),
  ) as { contributes?: { configuration?: unknown } };
  const configuration = manifest.contributes?.configuration;
  const blocks = Array.isArray(configuration) ? configuration : [configuration];
  const contributed = new Set(
    blocks.flatMap((block) =>
      Object.keys((block as { properties?: Record<string, unknown> } | null)?.properties ?? {}),
    ),
  );

  const profileDir = tempProfile();
  seedProfileSettings(profileDir, { aiEndpoint: seedFor(43216) });
  const written = Object.keys(settingsOf(profileDir)).filter((key) => key.startsWith('forgejoToolkit.'));

  assert.deepEqual(
    written.filter((key) => !contributed.has(key)),
    [],
    'the seed writes no key the extension does not contribute',
  );
  // The whole list, so a new key is a deliberate line here rather than a silent
  // addition to the profile.
  assert.deepEqual(written.sort(), [
    'forgejoToolkit.aiModelBindings',
    'forgejoToolkit.aiPreReview',
    'forgejoToolkit.aiProviders',
    'forgejoToolkit.aiTransport',
    'forgejoToolkit.useMockApi',
  ]);
});

test('the feature list is read from the extension source, not restated here', () => {
  // The seed follows `AI_FEATURES` in `packages/forgejo-toolkit/src/ai/modelSettings.ts`.
  // Importing that module is not an option on plain Node (`import * as vscode`), so
  // the parse is what has to be pinned: this asserts the real declaration is what
  // the reader sees, so a reshaped or renamed declaration fails here instead of
  // silently falling back to a stale copy.
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  const source = fs.readFileSync(path.join(repoRoot, AI_FEATURES_SOURCE), 'utf8');
  const parsed = parseDeclaredAiFeatures(source);
  assert.deepEqual(parsed, ['aiPreReview', 'prDescription', 'issueTriage']);
  assert.deepEqual(readDeclaredAiFeatures(repoRoot), parsed);
  // A source that does not carry the declaration answers "could not read it":
  // `undefined` rather than an empty list, which would seed nothing at all.
  assert.equal(parseDeclaredAiFeatures('export const AI_FEATURES = [] as const;'), undefined);
  assert.equal(parseDeclaredAiFeatures('export const SOMETHING_ELSE = true;'), undefined);
});

test('the seeded profile carries no credential of any kind', () => {
  const profileDir = tempProfile();
  seedProfileSettings(profileDir, { aiEndpoint: seedFor(43210) });
  const text = fs.readFileSync(path.join(profileDir, 'User', 'settings.json'), 'utf8').toLowerCase();
  for (const forbidden of ['authorization', 'bearer', 'api-key', 'sk-', 'token', 'secret', 'password']) {
    assert.ok(!text.includes(forbidden), `the seeded settings must not contain "${forbidden}":\n${text}`);
  }
});

test('seeding preserves other settings and other providers', () => {
  const profileDir = tempProfile();
  const keptProvider = {
    id: 'a-real-endpoint',
    name: 'Somewhere real',
    baseUrl: 'https://endpoint.example.com/v1',
    models: [{ id: 'kept-model', name: 'Kept' }],
    auth: 'bearer',
    headers: [],
  };
  writeSettings(profileDir, {
    'forgejoToolkit.debug': true,
    'forgejoToolkit.aiProviders': [keptProvider],
  });

  seedProfileSettings(profileDir, { useMockApi: false, aiEndpoint: seedFor(43211) });
  const settings = settingsOf(profileDir);

  assert.equal(settings['forgejoToolkit.debug'], true, 'an unrelated setting survives');
  assert.equal(settings['forgejoToolkit.useMockApi'], false, 'an explicit mode is still written');
  const providers = settings['forgejoToolkit.aiProviders'] as Array<{ id: string }>;
  assert.deepEqual(
    providers.map((provider) => provider.id),
    ['a-real-endpoint', AI_MOCK_PROVIDER_ID],
    'the real provider is kept and the mock one is added',
  );
});

test('a binding the user configured is never overwritten, and a feature with none gets one', () => {
  const profileDir = tempProfile();
  const keptBinding = { feature: 'aiPreReview', providerId: 'a-real-endpoint', modelId: 'kept-model' };
  writeSettings(profileDir, { 'forgejoToolkit.aiModelBindings': [keptBinding] });

  seedProfileSettings(profileDir, { aiEndpoint: seedFor(43212) });

  const bindings = settingsOf(profileDir)['forgejoToolkit.aiModelBindings'] as Array<Record<string, unknown>>;
  // `aiPreReview` names a provider that is not this harness's, so the user's
  // choice stands even though the harness has an endpoint to offer.
  assert.deepEqual(bindings[0], keptBinding, "the user's binding is left exactly as it was");
  // `prDescription` had none, so the seed binds it — that is the gap this fixes.
  assert.deepEqual(
    bindings.slice(1),
    declaredFeatures()
      .filter((feature) => feature !== 'aiPreReview')
      .map((feature) => ({ feature, providerId: AI_MOCK_PROVIDER_ID, modelId: AI_MOCK_MODEL_ID })),
  );
});

test('an entry naming a feature this build does not know is passed through untouched', () => {
  const profileDir = tempProfile();
  const fromANewerBuild = { feature: 'fromANewerBuild', providerId: 'x', modelId: 'y' };
  writeSettings(profileDir, { 'forgejoToolkit.aiModelBindings': [fromANewerBuild] });

  seedProfileSettings(profileDir, { aiEndpoint: seedFor(43213) });

  const bindings = settingsOf(profileDir)['forgejoToolkit.aiModelBindings'] as Array<Record<string, unknown>>;
  assert.deepEqual(bindings[0], fromANewerBuild);
  assert.deepEqual(bindingsOf(settingsOf(profileDir)).size, declaredFeatures().length + 1);
});

test('seeding twice is idempotent and refreshes the entries the harness itself wrote', () => {
  const profileDir = tempProfile();
  seedProfileSettings(profileDir, { useMockApi: true, aiEndpoint: seedFor(43214) });
  const first = settingsOf(profileDir);
  assert.deepEqual(bindingsOf(first).size, declaredFeatures().length);

  // A second `--ai-mock` launch: the endpoint binds a fresh OS-picked port every
  // time, so both entries the previous run wrote have to follow it — otherwise the
  // feature would keep talking to a port nothing listens on any more.
  seedProfileSettings(profileDir, { useMockApi: true, aiEndpoint: seedFor(43215) });
  const second = settingsOf(profileDir);
  const bindings = second['forgejoToolkit.aiModelBindings'] as Array<Record<string, unknown>>;

  assert.equal(bindings.length, declaredFeatures().length, 'no binding is duplicated');
  assert.equal(new Set(bindings.map((entry) => entry.feature)).size, bindings.length, 'one binding per feature');
  assert.deepEqual(
    bindings,
    declaredFeatures().map((feature) => ({ feature, providerId: AI_MOCK_PROVIDER_ID, modelId: AI_MOCK_MODEL_ID })),
    'a fresh profile is fully bound',
  );
  assert.deepEqual(second['forgejoToolkit.aiProviders'], [
    {
      id: AI_MOCK_PROVIDER_ID,
      name: 'Local mock endpoint (tools/ui-review)',
      baseUrl: `http://${AI_MOCK_HOST}:43215/v1`,
      models: [{ id: AI_MOCK_MODEL_ID, name: 'Mock pre-review model' }],
      auth: 'none',
      headers: [],
    },
  ]);
  assert.notEqual(
    (first['forgejoToolkit.aiProviders'] as Array<{ baseUrl: string }>)[0].baseUrl,
    (second['forgejoToolkit.aiProviders'] as Array<{ baseUrl: string }>)[0].baseUrl,
    'the new port replaced the old one',
  );
  // The refresh is in place, not an append: seeding the same endpoint again
  // changes nothing at all.
  const before = JSON.stringify(settingsOf(profileDir));
  seedProfileSettings(profileDir, { useMockApi: true, aiEndpoint: seedFor(43215) });
  assert.equal(JSON.stringify(settingsOf(profileDir)), before);
});

test('a launch without an AI endpoint leaves the AI settings alone', () => {
  const profileDir = tempProfile();
  seedProfileSettings(profileDir, { useMockApi: true });
  const settings = settingsOf(profileDir);
  assert.equal(settings['forgejoToolkit.useMockApi'], true);
  for (const key of Object.keys(settings)) {
    assert.ok(!key.startsWith('forgejoToolkit.ai'), `unexpected AI setting written: ${key}`);
  }
});
