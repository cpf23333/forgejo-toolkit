// Tests for what the launcher writes into the isolated profile
// (`src/config.ts`'s `seedProfileSettings`).
//
// The AI half of the seed is the harness's "no hand-editing" promise, so it is
// pinned here rather than only in the README:
//
//  1. the settings the extension actually reads are the ones written — a provider
//     whose base URL carries the port the endpoint bound, the egress switch, the
//     transport choice and the binding for the one AI feature;
//  2. **no credential is written, ever**: the seeded provider authenticates
//     nothing, so there is nothing to write, and the file is asserted to carry no
//     key-shaped text at all;
//  3. `forgejoToolkit.aiPreReviewPromptScope` is deliberately left alone: its
//     default `ask` *is* the consent question a human has to answer, and seeding
//     an answer would skip the only step this harness cannot automate;
//  4. seeding is additive: another provider, another feature's binding and every
//     unrelated setting survive, and seeding twice does not duplicate anything.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AI_MOCK_HOST, AI_MOCK_MODEL_ID } from './aiMockServer';
import { AI_MOCK_PROVIDER_ID, seedProfileSettings, type AiEndpointSeed } from './config';

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

test('an AI endpoint seed writes exactly the settings the extension reads', () => {
  const profileDir = tempProfile();
  seedProfileSettings(profileDir, { aiEndpoint: seedFor(43210) });
  const settings = settingsOf(profileDir);

  assert.equal(settings['forgejoToolkit.useMockApi'], true, 'the mock API default is unchanged');
  assert.equal(settings['forgejoToolkit.aiProvidersEnabled'], true);
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
      localOnly: true,
    },
  ]);
  assert.deepEqual(settings['forgejoToolkit.aiModelBindings'], [
    { feature: 'aiPreReview', providerId: AI_MOCK_PROVIDER_ID, modelId: AI_MOCK_MODEL_ID },
  ]);
  // The consent question stays unanswered on purpose (see the file comment).
  assert.equal('forgejoToolkit.aiPreReviewPromptScope' in settings, false);
});

test('the seeded profile carries no credential of any kind', () => {
  const profileDir = tempProfile();
  seedProfileSettings(profileDir, { aiEndpoint: seedFor(43210) });
  const text = fs.readFileSync(path.join(profileDir, 'User', 'settings.json'), 'utf8').toLowerCase();
  for (const forbidden of ['authorization', 'bearer', 'api-key', 'sk-', 'token', 'secret', 'password']) {
    assert.ok(!text.includes(forbidden), `the seeded settings must not contain "${forbidden}":\n${text}`);
  }
});

test('seeding preserves other settings, other providers and other bindings', () => {
  const profileDir = tempProfile();
  const keptProvider = {
    id: 'a-real-endpoint',
    name: 'Somewhere real',
    baseUrl: 'https://endpoint.example.com/v1',
    models: [{ id: 'kept-model', name: 'Kept' }],
    auth: 'bearer',
    headers: [],
    localOnly: false,
  };
  writeSettings(profileDir, {
    'forgejoToolkit.debug': true,
    'forgejoToolkit.aiProviders': [keptProvider],
    'forgejoToolkit.aiModelBindings': [
      { feature: 'aiPreReview', providerId: 'a-real-endpoint', modelId: 'kept-model' },
    ],
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
  assert.deepEqual(
    settings['forgejoToolkit.aiModelBindings'],
    [{ feature: 'aiPreReview', providerId: AI_MOCK_PROVIDER_ID, modelId: AI_MOCK_MODEL_ID }],
    'our own feature binding is replaced, not duplicated',
  );

  // Seeding twice is idempotent: a second launch on the same profile must not
  // accumulate providers or bindings.
  const before = JSON.stringify(settingsOf(profileDir));
  seedProfileSettings(profileDir, { useMockApi: true, aiEndpoint: seedFor(43211) });
  const after = settingsOf(profileDir);
  assert.equal((after['forgejoToolkit.aiProviders'] as unknown[]).length, providers.length);
  assert.equal((after['forgejoToolkit.aiModelBindings'] as unknown[]).length, 1);
  assert.notEqual(JSON.stringify(after), before, 'the mode line did change (useMockApi)');
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
