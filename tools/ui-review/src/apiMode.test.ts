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
  MOCKS_HANDLERS_SOURCE,
  apiModeReport,
  bundleFiles,
  decideApiMode,
  detectMockBuild,
  handledApiPath,
  mockableInstancePath,
  readHandledApiPath,
  unmockableInstances,
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

const HANDLED_PATH = '/api/v1/';

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

// The mockability gate (see `src/apiMode.ts`). The measured defect it answers:
// handlers registered for `https://*/api/v1/…` while the seeded profile's
// instances were `http://`, so MSW matched nothing, the unhandled path handed the
// request to the network, and the run still printed "Mock-backed run".

test('the handled API path is read out of the handler patterns, not restated', () => {
  // The longest common prefix, cut back to its last whole segment: one endpoint
  // deeper than another must not narrow the answer.
  assert.equal(readHandledApiPath("http.get('*://*/api/v1/user', () => x)"), HANDLED_PATH);
  assert.equal(
    readHandledApiPath("http.get('*://*/api/v1/user', () => x)\nhttp.get('*://*/api/v1/repos/:owner/:repo', () => x)"),
    HANDLED_PATH,
  );
  // A parameter or wildcard ends a pattern's literal part. One lone deep pattern
  // cannot say where its API root ends, so it narrows to its own parent segment —
  // still a strict superset of what the gate needs to see (`/api/v1/` instances
  // remain under it), and never a laxer answer.
  assert.equal(readHandledApiPath("http.get('*://*/api/v1/repos/:owner/:repo', () => x)"), '/api/v1/repos/');
  assert.equal(readHandledApiPath("http.get('*://*/api/v1/contents/*', () => x)"), '/api/v1/contents/');
  // Nothing to read is `undefined`, never a guess.
  assert.equal(readHandledApiPath('export const handlers = [];'), undefined);
  assert.equal(readHandledApiPath(''), undefined);
  // Patterns that do not share an API path leave nothing usable behind: the
  // answer collapses to the origin root, which accepts ordinary instances but
  // grants no API path — the conservative direction, never a laxer answer.
  assert.equal(readHandledApiPath("http.get('*://*/alpha/x', () => x)\nhttp.get('*://*/beta/y', () => x)"), '/');
});

test('the gate and the handlers on disk agree on the API path', () => {
  const read = handledApiPath();
  assert.equal(
    read,
    HANDLED_PATH,
    `every pattern in ${MOCKS_HANDLERS_SOURCE} must live under one literal prefix; if the mock API moved, ` +
      'update the gate (this test is what keeps the two from drifting apart silently)',
  );
  // The prefix has to be one the patterns really use: a regex that matched some
  // other literal would pass the equality above only by coincidence.
  const source = fs.readFileSync(path.join(REPO_ROOT, MOCKS_HANDLERS_SOURCE), 'utf8');
  assert.match(source, /\*:\/\/\*\/api\/v1\//, 'the handlers must be scheme-agnostic (see handlers.ts)');
});

test('an http(s) instance at the origin root is mockable; a path prefix is not', () => {
  assert.equal(mockableInstancePath('http://127.0.0.1:3004', HANDLED_PATH), '/');
  assert.equal(mockableInstancePath('http://127.0.0.1:3004/', HANDLED_PATH), '/');
  assert.equal(mockableInstancePath('https://forgejo.example.com', HANDLED_PATH), '/');
  assert.equal(mockableInstancePath('https://forgejo.example.com/', HANDLED_PATH), '/');
  assert.equal(mockableInstancePath('https://forgejo.example.com/api/v1', HANDLED_PATH), HANDLED_PATH);
  // A reverse-proxy spelling: every request lands under /forgejo/api/v1/…, which
  // no handler matches, so MSW would pass it straight to that real host.
  assert.equal(mockableInstancePath('https://forgejo.example.com/forgejo', HANDLED_PATH), undefined);
  assert.equal(mockableInstancePath('http://127.0.0.1:3004/forgejo/', HANDLED_PATH), undefined);
  // Not a URL, or not HTTP at all.
  assert.equal(mockableInstancePath('forgejo.example.com', HANDLED_PATH), undefined);
  assert.equal(mockableInstancePath('ftp://forgejo.example.com', HANDLED_PATH), undefined);
});

test('the gate names only the instances the handlers cannot serve', () => {
  const instances = [
    { id: 'plain', url: 'http://127.0.0.1:3004' },
    { id: 'prefixed', url: 'https://forgejo.example.com/forgejo', name: 'Behind a proxy' },
    { id: 'secure', url: 'https://forgejo.example.com' },
  ];
  const blocked = unmockableInstances(instances, HANDLED_PATH);
  assert.deepEqual(
    blocked.instances.map((instance) => instance.id),
    ['prefixed'],
  );
  assert.match(blocked.reasons['prefixed'] ?? '', /path is not the origin root/);
});

test('an unreadable handler path blocks every instance rather than guessing', () => {
  const instances = [
    { id: 'plain', url: 'http://127.0.0.1:3004' },
    { id: 'secure', url: 'https://forgejo.example.com' },
  ];
  const blocked = unmockableInstances(instances, undefined);
  assert.deepEqual(
    blocked.instances.map((instance) => instance.id),
    ['plain', 'secure'],
  );
  assert.match(blocked.reasons['plain'] ?? '', /could not be read from .*handlers\.ts/);
});

test('an unmockable instance turns a mock-backed launch into an abort', () => {
  const blocked = [{ id: 'prefixed', url: 'https://forgejo.example.com/forgejo' }];
  assert.deepEqual(decideApiMode({ mocksCompiledIn: true, realApiRequested: false, unmockableInstances: blocked }), {
    action: 'abort',
    reason: 'unmockable-instances',
  });
  // The explicit opt-in still wins: with --real-api the run is *meant* to reach
  // those instances, which is the whole point of asking for it.
  assert.deepEqual(decideApiMode({ mocksCompiledIn: true, realApiRequested: true, unmockableInstances: blocked }), {
    action: 'launch',
    mode: 'real-api',
    because: 'mocks-compiled-in',
  });
  // And an empty list changes nothing.
  assert.deepEqual(decideApiMode({ mocksCompiledIn: true, realApiRequested: false, unmockableInstances: [] }), {
    action: 'launch',
    mode: 'mock',
  });
});

test('the refusal names the instance, the reason and both ways forward', () => {
  const report = apiModeReport(
    { action: 'abort', reason: 'unmockable-instances' },
    {
      ...CONTEXT,
      instances: [
        { id: 'plain', url: 'http://127.0.0.1:3004' },
        { id: 'prefixed', url: 'https://forgejo.example.com/forgejo', name: 'Behind a proxy' },
      ],
      unmockableInstances: [{ id: 'prefixed', url: 'https://forgejo.example.com/forgejo', name: 'Behind a proxy' }],
      unmockableReasons: { prefixed: 'its path is not the origin root the handlers match (they cover …)' },
      handledApiPath: HANDLED_PATH,
    },
  );
  const text = report.lines.join('\n');
  assert.equal(report.fatal, true);
  assert.match(text, /Refusing to launch: this dev host would poll a real server\./);
  assert.match(text, /\(mock API compiled in\)/);
  assert.match(text, new RegExp(MOCKS_HANDLERS_SOURCE.replace(/[.]/g, '\\.')));
  assert.match(text, /Behind a proxy <https:\/\/forgejo\.example\.com\/forgejo>/);
  assert.match(text, /its path is not the origin root/);
  assert.match(text, /--real-api/);
  assert.match(text, /mark all as read/, 'the real-API caveat is spelled out');
  assert.match(text, /no path prefix/);
});

test('a mock-backed run says the instances it checked are all served', () => {
  const report = apiModeReport(
    { action: 'launch', mode: 'mock' },
    { ...CONTEXT, marker: 'A demo repository for offline development.', handledApiPath: HANDLED_PATH },
  );
  const text = report.lines.join('\n');
  assert.match(text, /Mock-backed run:/);
  assert.match(text, /every configured instance is one the handlers cover/);
  assert.doesNotMatch(text, /none recorded yet/, 'the profile has an instance, so that note is wrong here');
});

test('a mock-backed run with no configured instance is still honest about it', () => {
  const report = apiModeReport(
    { action: 'launch', mode: 'mock' },
    { ...CONTEXT, instances: [], handledApiPath: HANDLED_PATH },
  );
  const text = report.lines.join('\n');
  assert.match(text, /Mock-backed run:/);
  assert.match(text, /none recorded yet/);
});
