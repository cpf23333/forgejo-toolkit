// Unit tests for the build-capability gate.
//
// Two things are load-bearing here and are pinned rather than assumed:
//
//  1. The markers must still exist in `src/test/mocks/`. Detection works by
//     looking for mock-only literals in the *build*; if a fixture is reworded,
//     the marker silently stops matching and every run would be refused as
//     "production". The first test turns that silent rot into a failure.
//  2. The decision is a truth table (mocks available × opt-in). It is what keeps
//     a development build from being refused and a production build from
//     silently polling a real server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  MOCK_BUILD_MARKERS,
  apiModeReport,
  bundleFiles,
  decideApiMode,
  detectMockBuild,
  type ApiModeContext,
} from './apiMode';
import { readConfiguredInstances, readMockApiSetting } from './config';

const HARNESS_DIR = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(HARNESS_DIR, '..', '..');
const MOCKS_DIR = path.join(REPO_ROOT, 'packages', 'forgejo-toolkit', 'src', 'test', 'mocks');

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ui-review-apimode-'));
}

function writeBundle(dir: string, relative: string, contents: string): void {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function mocksSourceText(): string {
  const files = fs
    .readdirSync(MOCKS_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name));
  assert.ok(files.length > 10, `expected the mocks tree at ${MOCKS_DIR} to hold its fixtures`);
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

const CONTEXT: ApiModeContext = {
  buildDir: 'D:\\repo\\packages\\forgejo-toolkit\\out',
  profileDir: 'D:\\repo\\tools\\ui-review\\profile',
  instances: [{ id: 'demo-1', url: 'https://forgejo.example.com', name: 'Demo Forgejo' }],
  buildPresent: true,
};

test('every detection marker still exists in the mock sources', () => {
  const text = mocksSourceText();
  for (const marker of MOCK_BUILD_MARKERS) {
    assert.ok(
      text.includes(marker),
      `marker ${JSON.stringify(marker)} is no longer in src/test/mocks — detection would read every ` +
        'build as "no mocks"; update MOCK_BUILD_MARKERS in src/apiMode.ts to the new literal',
    );
  }
});

test('a missing build is reported as such, not as a production build', () => {
  const detection = detectMockBuild(path.join(tempDir(), 'nope'));
  assert.equal(detection.buildPresent, false);
  assert.equal(detection.mocksCompiledIn, false);
  assert.deepEqual(detection.scanned, []);
});

test('a production-shaped bundle has no marker', () => {
  const dir = tempDir();
  writeBundle(dir, 'extension.mjs', 'var x=1;console.log("Forgejo Toolkit extension activated");');
  writeBundle(dir, 'chunks/chunk-AAAA.mjs', 'export const y=2;');
  const detection = detectMockBuild(dir);
  assert.equal(detection.buildPresent, true);
  assert.equal(detection.mocksCompiledIn, false);
  assert.deepEqual(detection.scanned, ['chunks/chunk-AAAA.mjs', 'extension.mjs']);
});

test('a marker in a chunk counts — the build is code-split', () => {
  const dir = tempDir();
  writeBundle(dir, 'extension.mjs', 'var x=1;');
  writeBundle(dir, 'chunks/chunk-BBBB.mjs', 'const m="[mocks] no handler matched ";');
  const detection = detectMockBuild(dir);
  assert.equal(detection.mocksCompiledIn, true);
  assert.equal(detection.marker, '[mocks] no handler matched');
  assert.equal(detection.file, 'chunks/chunk-BBBB.mjs');
});

test('a fixture sentence in the main bundle is found too', () => {
  const dir = tempDir();
  writeBundle(dir, 'extension.mjs', 'description:"A demo repository for offline development."');
  const detection = detectMockBuild(dir);
  assert.equal(detection.mocksCompiledIn, true);
  assert.equal(detection.marker, 'A demo repository for offline development.');
  assert.equal(detection.file, 'extension.mjs');
});

test('bundleFiles only walks .mjs files', () => {
  const dir = tempDir();
  writeBundle(dir, 'extension.mjs', 'x');
  writeBundle(dir, 'webview/assets/index.js', 'y');
  writeBundle(dir, 'chunks/deep/one.mjs', 'z');
  assert.deepEqual(bundleFiles(dir), ['chunks/deep/one.mjs', 'extension.mjs']);
});

test('the decision table: mocks available × opt-in', () => {
  assert.deepEqual(decideApiMode({ mocksCompiledIn: true, realApiRequested: false }), {
    action: 'launch',
    mode: 'mock',
  });
  assert.deepEqual(decideApiMode({ mocksCompiledIn: true, realApiRequested: true }), {
    action: 'launch',
    mode: 'real-api',
    because: 'mocks-compiled-in',
  });
  assert.deepEqual(decideApiMode({ mocksCompiledIn: false, realApiRequested: true }), {
    action: 'launch',
    mode: 'real-api',
    because: 'production-build',
  });
  assert.deepEqual(decideApiMode({ mocksCompiledIn: false, realApiRequested: false }), {
    action: 'abort',
    reason: 'no-mocks-and-no-opt-in',
  });
});

test('the refusal names what it found, the profile, the instances and both ways forward', () => {
  const report = apiModeReport({ action: 'abort', reason: 'no-mocks-and-no-opt-in' }, CONTEXT);
  const text = report.lines.join('\n');
  assert.equal(report.fatal, true);
  assert.match(text, /Refusing to launch: this dev host would poll a real server\./);
  assert.match(text, /forgejo-toolkit\\out {2}\(no mock API compiled in\)/);
  assert.match(text, /FORGEJO_TOOLKIT_INCLUDE_MOCKS=false/);
  assert.match(text, /src\/test\/mocks\//);
  assert.ok(text.includes(CONTEXT.profileDir), 'the profile is named');
  assert.match(text, /Demo Forgejo <https:\/\/forgejo\.example\.com>/, 'the instance is named');
  assert.match(text, /--real-api/);
  assert.match(text, /pnpm --filter forgejo-toolkit build:extension/);
  assert.match(text, /mark all as read/, 'the real-API caveat is spelled out');
});

test('the refusal changes its reason when there is no build at all', () => {
  const report = apiModeReport(
    { action: 'abort', reason: 'no-mocks-and-no-opt-in' },
    { ...CONTEXT, buildPresent: false },
  );
  const text = report.lines.join('\n');
  assert.match(text, /does not exist \(nothing to load\)/);
  assert.doesNotMatch(text, /FORGEJO_TOOLKIT_INCLUDE_MOCKS=false/);
  assert.match(text, /run a build first/);
});

test('a profile without a recorded instance still gets an honest refusal', () => {
  const report = apiModeReport({ action: 'abort', reason: 'no-mocks-and-no-opt-in' }, { ...CONTEXT, instances: [] });
  const text = report.lines.join('\n');
  assert.match(text, /none recorded in this profile yet/);
});

test('the --real-api warning names the instances and the read-only caveat', () => {
  const report = apiModeReport({ action: 'launch', mode: 'real-api', because: 'production-build' }, CONTEXT);
  const text = report.lines.join('\n');
  assert.equal(report.fatal, false);
  assert.match(text, /Running with --real-api: this window will use the real API\./);
  assert.match(text, /Demo Forgejo <https:\/\/forgejo\.example\.com>/);
  assert.match(text, /production build \(no mock API compiled in\)/);
  assert.match(text, /mark all as read/);
});

test('the opt-in says when it had to switch the mock setting off', () => {
  const report = apiModeReport({ action: 'launch', mode: 'real-api', because: 'mocks-compiled-in' }, CONTEXT);
  assert.match(
    report.lines.join('\n'),
    /mock API compiled in, but forgejoToolkit\.useMockApi is pinned to false for this run/,
  );
});

test('a mock-backed run says which marker it matched', () => {
  const report = apiModeReport(
    { action: 'launch', mode: 'mock' },
    { ...CONTEXT, marker: '[mocks] no handler matched', file: 'chunks/chunk-BBBB.mjs' },
  );
  const text = report.lines.join('\n');
  assert.match(
    text,
    /Mock-backed run: mock API compiled in \("\[mocks\] no handler matched" in chunks\/chunk-BBBB\.mjs\)/,
  );
});

test('a mock-capable build with the setting off is called out instead of silently using the real API', () => {
  const report = apiModeReport({ action: 'launch', mode: 'mock' }, { ...CONTEXT, mockApiSetting: false });
  const text = report.lines.join('\n');
  assert.match(text, /forgejoToolkit\.useMockApi set to false/);
  assert.match(text, /pass --real-api to say that\s+on purpose/);
});

test('the profile helpers read the instance list without any credential field', () => {
  const profileDir = tempDir();
  const globalStorage = path.join(profileDir, 'User', 'globalStorage', 'cpf23333.forgejo-toolkit');
  fs.mkdirSync(globalStorage, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'User', 'settings.json'),
    JSON.stringify({ 'forgejoToolkit.useMockApi': false }),
  );
  fs.writeFileSync(
    path.join(globalStorage, 'mcp-instances.json'),
    JSON.stringify({
      instances: [
        { id: 'demo-1', url: 'https://forgejo.example.com', name: 'Demo Forgejo', token: 'secret-must-not-be-read' },
        { id: 'broken' },
      ],
    }),
  );

  assert.equal(readMockApiSetting(profileDir), false);
  const instances = readConfiguredInstances(profileDir);
  assert.deepEqual(instances, [{ id: 'demo-1', url: 'https://forgejo.example.com', name: 'Demo Forgejo' }]);
  assert.equal(
    JSON.stringify(instances).includes('secret-must-not-be-read'),
    false,
    'a token in the profile file must not survive into what the launcher prints',
  );
});

test('missing profile files read as "unknown" rather than throwing', () => {
  const profileDir = tempDir();
  assert.equal(readMockApiSetting(profileDir), undefined);
  assert.deepEqual(readConfiguredInstances(profileDir), []);
});
