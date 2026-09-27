// Unit tests for CDP target normalisation — the defect that broke `dual targets`
// and `--target` on the first real run.
//
// `/json/list` (and every DevTools HTTP endpoint) spells the field `id`, while the
// protocol's own `Target.getTargets`/`Target.getTargetInfo` replies spell it
// `targetId`. Reading one spelling only produced `undefined` for every target, so
// the fixture below is the live payload measured on 2026-09-27 (page = workbench,
// iframe = webview, worker), with the ids kept as they were.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCdpTargets } from './driver';
import { workbenchTargetIds } from './windows';

/** The shape `/json/list` actually returns (fields trimmed to the documented ones). */
const LIVE_PAYLOAD = [
  {
    id: '5ED00343757B496793642A2E9698E9AA',
    type: 'page',
    title: '[扩展开发宿主] Forgejo Toolkit Setup - Visual Studio Code',
    url: 'vscode-file://vscode-app/c:/Users/x/AppData/Local/Programs/Microsoft%20VS%20Code/resources/app/out/vs/code/electron-browser/workbench/workbench.html',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/5ED00343757B496793642A2E9698E9AA',
  },
  {
    id: 'EBD38A0E3A1C3A69862BD99A0454D5B5',
    type: 'iframe',
    title: 'vscode-webview://0ajrd299k4tg0oi90joams4d13i66uhv1sp5cqieoncjf22cbh5u/index.html',
    url: 'vscode-webview://0ajrd299k4tg0oi90joams4d13i66uhv1sp5cqieoncjf22cbh5u/index.html?extensionId=cpf23333.forgejo-toolkit',
  },
  {
    id: 'FA67544B8E224C11D2109B5A9DB19D9C',
    type: 'page',
    title: '[扩展开发宿主] Forgejo Toolkit Setup - forgejo-toolkit - Visual Studio Code',
    url: 'vscode-file://vscode-app/c:/Users/x/AppData/Local/Programs/Microsoft%20VS%20Code/resources/app/out/vs/code/electron-browser/workbench/workbench.html',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/FA67544B8E224C11D2109B5A9DB19D9C',
  },
  {
    id: '6E1DD588A9F08D1B40CFD09DFC2C6FCC',
    type: 'worker',
    title: 'editorWorkerService',
    url: 'blob:vscode-file://vscode-app/c2293ffd-068d-4d6a-82ef-d2e7337c2b8a',
  },
];

test('the live /json/list payload yields real target ids, not undefined', () => {
  const targets = normalizeCdpTargets(LIVE_PAYLOAD);
  assert.equal(targets.length, 4);
  assert.deepEqual(
    targets.map((target) => target.targetId),
    [
      '5ED00343757B496793642A2E9698E9AA',
      'EBD38A0E3A1C3A69862BD99A0454D5B5',
      'FA67544B8E224C11D2109B5A9DB19D9C',
      '6E1DD588A9F08D1B40CFD09DFC2C6FCC',
    ],
  );
  assert.equal(targets[0].type, 'page');
  assert.equal(targets[0].title, '[扩展开发宿主] Forgejo Toolkit Setup - Visual Studio Code');
  assert.ok(targets[0].url.includes('workbench.html'));
});

test('exactly the two workbench pages are windows, with their ids', () => {
  const ids = workbenchTargetIds(normalizeCdpTargets(LIVE_PAYLOAD));
  assert.deepEqual(ids.slice().sort(), ['5ED00343757B496793642A2E9698E9AA', 'FA67544B8E224C11D2109B5A9DB19D9C']);
  // Neither the webview iframe nor the worker is a window.
  assert.ok(!ids.includes('EBD38A0E3A1C3A69862BD99A0454D5B5'));
  assert.ok(!ids.includes('6E1DD588A9F08D1B40CFD09DFC2C6FCC'));
});

test('the protocol spelling (targetId) is accepted too', () => {
  const targets = normalizeCdpTargets([
    { targetId: 'ABC', type: 'page', title: 't', url: 'vscode-file://app/workbench.html' },
  ]);
  assert.equal(targets[0].targetId, 'ABC');
});

test('malformed entries are dropped rather than becoming undefined ids', () => {
  const targets = normalizeCdpTargets([
    { id: '', type: 'page', url: 'workbench.html' },
    { type: 'page', url: 'workbench.html' },
    null,
    'nonsense',
    { id: 42, type: 'page', url: 'workbench.html' },
    { id: 'KEEP', type: 'page', url: 'workbench.html' },
  ]);
  assert.deepEqual(
    targets.map((target) => target.targetId),
    ['KEEP'],
  );
  // A non-array payload (an error body) yields no targets instead of throwing.
  assert.deepEqual(normalizeCdpTargets({ error: 'nope' }), []);
  assert.deepEqual(normalizeCdpTargets(null), []);
});
