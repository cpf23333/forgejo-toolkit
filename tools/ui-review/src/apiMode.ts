// Whether the build on disk can serve mock data — and what the launcher does
// about it.
//
// Two questions, both asked before anything is spawned, because either one
// answered wrong produces a run that reaches the network while calling itself
// mock-backed:
//
//   1. **Does the build contain the mock API at all?** (detection, below)
//   2. **Can the handlers serve what this profile configures?** (the mockability
//      gate, `mockableInstancePath` / `unmockableInstances`)
//
// Why detection and not a launcher flag: the mock API (msw plus
// `packages/forgejo-toolkit/src/test/mocks/`) is compiled in only for a
// non-production build. `packages/forgejo-toolkit/rolldown.config.mjs` *defines*
// `process.env.FORGEJO_TOOLKIT_INCLUDE_MOCKS` at build time (`'true'` without
// `--production`, `'false'` with it), and `src/extension.ts` guards its dynamic
// `import('./test/mocks/server')` with that expression — so a production build
// dead-code-eliminates the whole module, and no environment variable set by this
// harness can bring it back. The launcher therefore asks what the build can do
// and refuses to start a window when the answer is "only the real network".
//
// The scan reads every `.mjs` under `packages/forgejo-toolkit/out` — the build is
// code-split, so the mock module can live in a chunk rather than in
// `extension.mjs` — and looks for literals that exist *only* inside
// `src/test/mocks/`. Each marker is reachable from `startMockServer()`, so a
// build that keeps the module keeps the marker:
//
//   * `[mocks] no handler matched` and `(a test must never reach the real
//     network).` are inside `handleUnhandledRequest` in `server.ts`, which
//     `startMockServer` passes to `mockServer.listen`;
//   * the two fixture sentences come from `data/repositories.ts`, which
//     `handlers.ts` imports and spreads into the handler list.
//
// `mock-instance-1` (also unique to the mocks tree) was rejected on purpose:
// nothing in that tree references `mockInstance`, so a mock-inclusive build is
// free to tree-shake it away and the marker would report a false "production".
// Every marker below is checked by `apiMode.test.ts` against the mock sources,
// so rewording a fixture fails a test instead of silently switching detection
// off.
//
// Why the second question exists at all — measured 2026-10-05: the handlers were
// registered for `https://*/api/v1/…` while the isolated profile's instances were
// plain `http://`, so MSW matched none of them. Outside a test run
// `onUnhandledRequest` only warns and then hands the request to the network, and
// the run printed `Mock-backed run: mock API compiled in …` while the dev host
// polled a real Forgejo server. The handlers are scheme-agnostic now
// (`*://*/api/v1/…`, see `src/test/mocks/handlers.ts`), and this gate refuses any
// profile the handlers still cannot serve, so the two halves cannot disagree
// silently again.
import fs from 'node:fs';
import path from 'node:path';
import { mcpInstancesPath, type ConfiguredInstance } from './config';

/** Literals that survive only when `src/test/mocks/` was compiled in (see above). */
export const MOCK_BUILD_MARKERS: readonly string[] = [
  '[mocks] no handler matched',
  '(a test must never reach the real network).',
  'A demo repository for offline development.',
  'Demonstrates API failure states: changed-files fetches and edits fail with 500.',
];

/**
 * Where the mock API's handlers live, relative to the repository root. The gate
 * below reads this file to learn **which request paths the handlers serve**
 * instead of restating them: a hardcoded copy would be one fixture edit away
 * from describing handlers that no longer exist, which is the same class of
 * silent mismatch this gate exists to refuse.
 */
export const MOCKS_HANDLERS_SOURCE = 'packages/forgejo-toolkit/src/test/mocks/handlers.ts';

/**
 * The origin-root-relative path prefix the handlers cover: /api/v1/.
 *
 * Read out of the handler patterns themselves: every pattern is a scheme-agnostic
 * origin followed by the API path and then any endpoint path, parameters or
 * wildcards. The **longest common prefix** of those paths is taken and then cut
 * back to its last whole segment, so `/api/v1/user` and `/api/v1/repos/:owner`
 * both yield `/api/v1/`. That is deliberately the conservative direction: a
 * shorter prefix can only make the launcher's mockability gate stricter, never
 * laxer. Returns `undefined` when nothing could be read (the source moved, or no
 * pattern matched) — the caller then says "cannot verify" rather than pretending
 * the check passed.
 */
export function readHandledApiPath(text: string): string | undefined {
  const paths: string[] = [];
  for (const match of text.matchAll(/\*:\/\/\*(\/[^'"]*)/g)) {
    if (!match[1]) continue;
    // A pattern is truncated at its first parameter (`:repo`) or wildcard (`*`).
    const cut = match[1].search(/[:*]/);
    paths.push(cut === -1 ? match[1] : match[1].slice(0, cut));
  }
  const [first, ...rest] = paths;
  if (first === undefined) return undefined;
  let common = first;
  for (const candidate of rest) {
    let length = 0;
    while (length < common.length && length < candidate.length && common[length] === candidate[length]) {
      length += 1;
    }
    common = common.slice(0, length);
  }
  const trimmed = common.endsWith('/') ? common : common.slice(0, common.lastIndexOf('/') + 1);
  return trimmed || undefined;
}

/** The handled path prefix from the mock sources on disk, or `undefined`. */
export function handledApiPath(repoRoot: string = defaultRepoRoot()): string | undefined {
  try {
    return readHandledApiPath(fs.readFileSync(path.join(repoRoot, MOCKS_HANDLERS_SOURCE), 'utf8'));
  } catch {
    return undefined;
  }
}

function defaultRepoRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..');
}

/**
 * The URL path of an instance that these handlers serve, or `undefined` when
 * they cannot.
 *
 * The handlers match **any scheme and any host** (`*://*`, see
 * `src/test/mocks/handlers.ts`) but only under one API path, so an instance URL
 * is mockable when its own path is empty — the instance spells the API base
 * itself — and its scheme is http(s). A path prefix
 * (`https://host/forgejo`, a common reverse-proxy spelling) puts every request
 * outside the patterns: MSW does not match it, `onUnhandledRequest` warns and
 * passes it through, and the dev host reaches the real server while the run still
 * calls itself mock-backed.
 *
 * `apiPath` is what {@link readHandledApiPath} read out of the handlers, so the
 * gate follows the handlers rather than a second copy of their shape. It is also
 * spelled `/` when the patterns share no API path — see that function's comment
 * on why the conservative direction is the only safe one.
 */
export function mockableInstancePath(instanceUrl: string, apiPath: string): string | undefined {
  let url: URL;
  try {
    url = new URL(instanceUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return pathname === '/' || pathname === apiPath ? pathname : undefined;
}

/** The build the dev host loads: `<extension package>/out`. */
export function buildDirFor(extensionDevDir: string): string {
  return path.join(extensionDevDir, 'out');
}

/** Every `.mjs` in the build directory, recursively, relative and sorted. */
export function bundleFiles(outDir: string): string[] {
  const found: string[] = [];
  const visit = (relative: string): void => {
    const absolute = path.join(outDir, relative);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) found.push(child);
    }
  };
  visit('');
  return found;
}

export interface MockBuildDetection {
  /** `false` when the build directory itself is missing (the extension cannot run at all). */
  buildPresent: boolean;
  /** True when at least one mock-only marker is in the build. */
  mocksCompiledIn: boolean;
  /** The marker that matched, and the bundle file it was found in. */
  marker?: string;
  file?: string;
  /** Every bundle file the scan read, relative to the build directory. */
  scanned: readonly string[];
}

/**
 * Reads the build and decides whether the mock API is part of it.
 *
 * A marker match is conclusive: the literals exist nowhere else in the
 * repository (checked by the test suite), so finding one means the mock module
 * was bundled. Not finding one is *not* conclusive on its own — a production
 * build is the expected reason, which is why the report names both the build
 * directory and the `rolldown.config.mjs` define that removes it.
 */
export function detectMockBuild(outDir: string): MockBuildDetection {
  const buildPresent = fs.existsSync(outDir);
  const scanned: string[] = [];
  if (!buildPresent) {
    return { buildPresent: false, mocksCompiledIn: false, scanned };
  }
  for (const file of bundleFiles(outDir)) {
    scanned.push(file);
    let text: string;
    try {
      text = fs.readFileSync(path.join(outDir, file), 'utf8');
    } catch {
      continue;
    }
    for (const marker of MOCK_BUILD_MARKERS) {
      if (text.includes(marker)) {
        return { buildPresent: true, mocksCompiledIn: true, marker, file, scanned };
      }
    }
  }
  return { buildPresent: true, mocksCompiledIn: false, scanned };
}

/** What the launcher knows when it decides how a run may talk to Forgejo. */
export interface ApiModeContext {
  buildDir: string;
  profileDir: string;
  /** The profile's configured instances, for naming them in the warning. */
  instances: readonly ConfiguredInstance[];
  /** The profile's `forgejoToolkit.useMockApi`, when the settings file says. */
  mockApiSetting?: boolean;
  /** The detection's matched marker/file, for the "mocks are compiled in" notice. */
  marker?: string;
  file?: string;
  buildPresent: boolean;
  /**
   * The configured instances the mock handlers **cannot** serve (see
   * {@link mockableInstancePath}) — a mock-backed run with any of these would
   * reach the real network, so it is refused instead.
   */
  unmockableInstances?: readonly ConfiguredInstance[];
  /** What each unmockable instance cannot be modelled as, keyed by instance id. */
  unmockableReasons?: Readonly<Record<string, string>>;
  /** The path prefix the handlers cover (`/api/v1/`), or `undefined` if unreadable. */
  handledApiPath?: string;
}

export interface ApiModeInput {
  mocksCompiledIn: boolean;
  realApiRequested: boolean;
  /**
   * Configured instances the handlers cannot serve. Any entry makes a
   * mock-backed run impossible: the request would fall through MSW to the
   * network, which is exactly the failure this gate exists to refuse.
   */
  unmockableInstances?: readonly ConfiguredInstance[];
}

export type ApiModeDecision =
  /** Mocks are compiled in and no opt-in was given: today's behaviour, MSW intercepts. */
  | { action: 'launch'; mode: 'mock' }
  /**
   * The operator asked for the real API. `because` records what they are stepping
   * away from, because the two cases need different sentences: with mocks in the
   * build they must also be switched off, without them there is nothing to switch.
   */
  | { action: 'launch'; mode: 'real-api'; because: 'mocks-compiled-in' | 'production-build' }
  /** No mocks in the build and no opt-in: refuse before anything is started. */
  | { action: 'abort'; reason: 'no-mocks-and-no-opt-in' }
  /** Mocks are compiled in, but a configured instance cannot be served by them. */
  | { action: 'abort'; reason: 'unmockable-instances' };

/**
 * The whole decision, as a pure function of "can this build mock?", "did the
 * operator opt in?" and "can the handlers serve what the profile configures?".
 * Both entry points (`launch.ts` and `dual.ts launch`) run it before they spawn
 * anything, so there is one rule rather than two.
 *
 * The third input is not optional in spirit: a mock-capable build is still a run
 * that reaches the network when the profile's instances sit outside the handler
 * patterns (an `http://` instance under an `https://` handler was the measured
 * case — see `src/test/mocks/handlers.ts`). Refusing beats a run whose own log
 * line says "Mock-backed".
 */
export function decideApiMode(input: ApiModeInput): ApiModeDecision {
  if (input.realApiRequested) {
    return {
      action: 'launch',
      mode: 'real-api',
      because: input.mocksCompiledIn ? 'mocks-compiled-in' : 'production-build',
    };
  }
  if (input.mocksCompiledIn) {
    if ((input.unmockableInstances?.length ?? 0) > 0) {
      return { action: 'abort', reason: 'unmockable-instances' };
    }
    return { action: 'launch', mode: 'mock' };
  }
  return { action: 'abort', reason: 'no-mocks-and-no-opt-in' };
}

export interface ApiModeReport {
  /** Lines to print, in order; the caller prints fatal ones to stderr. */
  lines: readonly string[];
  fatal: boolean;
}

/** `name <url>` for a configured instance, without ever reading its token. */
function describeInstance(instance: ConfiguredInstance): string {
  const label = instance.name ?? instance.id;
  return `${label} <${instance.url}>`;
}

function instanceLines(context: ApiModeContext): string[] {
  if (context.instances.length === 0) {
    return [
      '  instances: none recorded in this profile yet — a window that runs would poll whatever',
      '             the profile has configured (or nothing, if it has no instance)',
    ];
  }
  const [first, ...rest] = context.instances.map(describeInstance);
  return [`  instances: ${first}`, ...rest.map((entry) => `             ${entry}`)];
}

/** The safety sentence both real-API messages carry (indented by the caller). */
const REAL_API_WARNING: readonly string[] = [
  'polling here is read-only, but instance-wide actions reach these servers',
  '(for example "mark all as read", which changes data on every configured instance)',
];

/** The header every refusal starts with (both refusals are the same promise). */
const REFUSAL_HEADER = 'Refusing to launch: this dev host would poll a real server.';

/**
 * The text for one decision. Kept separate from the printing so the exact
 * wording — including the two ways forward — is pinned by tests instead of
 * living only in a `console.error` call.
 */
export function apiModeReport(decision: ApiModeDecision, context: ApiModeContext): ApiModeReport {
  if (decision.action === 'abort' && decision.reason === 'unmockable-instances') {
    // A mock-capable build whose profile configures something the handlers do
    // not cover. Naming the instance and the reason is the whole point: the
    // measured failure was a run that printed "Mock-backed run" and then polled
    // a real server, because MSW matched no handler and passed the request on.
    const offending = context.unmockableInstances ?? [];
    const apiPath = context.handledApiPath ?? '/api/v1/';
    const lines = [
      REFUSAL_HEADER,
      '',
      `  build:     ${context.buildDir}  (mock API compiled in)`,
      `             every handler in ${MOCKS_HANDLERS_SOURCE} matches <any scheme>://<any host>${apiPath}…`,
      `  profile:   ${context.profileDir}`,
      ...instanceLines(context),
      '',
      `Cannot mock ${offending.length === 1 ? 'this instance' : 'these instances'}:`,
    ];
    for (const instance of offending) {
      lines.push(`  ${describeInstance(instance)}`);
      lines.push(`             ${context.unmockableReasons?.[instance.id] ?? 'outside the mocked API path'}`);
    }
    lines.push(
      '',
      'Two ways forward:',
      '  --real-api   run against those instances anyway. This is the explicit opt-in;',
      ...REAL_API_WARNING.map((line) => `               ${line}`),
      '  fix the profile, so every configured instance is one the mock API serves:',
      `               an http(s) URL with no path prefix (the handlers cover the origin root only),`,
      '               or remove the instance from the profile for this run',
    );
    return { fatal: true, lines };
  }

  if (decision.action === 'abort') {
    const buildLine = context.buildPresent
      ? `  build:     ${context.buildDir}  (no mock API compiled in)`
      : `  build:     ${context.buildDir} does not exist (nothing to load)`;
    const why = context.buildPresent
      ? [
          '             a production build defines FORGEJO_TOOLKIT_INCLUDE_MOCKS=false, which',
          '             dead-code-eliminates src/test/mocks/ (msw and its fixtures) — see',
          '             packages/forgejo-toolkit/rolldown.config.mjs',
        ]
      : ['             run a build first (packages/forgejo-toolkit/out is what the dev host loads)'];
    return {
      fatal: true,
      lines: [
        REFUSAL_HEADER,
        '',
        buildLine,
        ...why,
        `  profile:   ${context.profileDir}`,
        ...instanceLines(context),
        '',
        'Two ways forward:',
        '  --real-api   run against those instances anyway. This is the explicit opt-in;',
        ...REAL_API_WARNING.map((line) => `               ${line}`),
        '  rebuild without --production, so the mock API intercepts every request:',
        '               pnpm --filter forgejo-toolkit build:extension',
      ],
    };
  }

  if (decision.mode === 'real-api') {
    const build =
      decision.because === 'mocks-compiled-in'
        ? 'mock API compiled in, but forgejoToolkit.useMockApi is pinned to false for this run'
        : 'production build (no mock API compiled in)';
    return {
      fatal: false,
      lines: [
        'Running with --real-api: this window will use the real API.',
        `  profile:   ${context.profileDir}`,
        ...instanceLines(context),
        `  build:     ${build}`,
        ...REAL_API_WARNING.map((line) => `  ${line}`),
      ],
    };
  }

  const matched =
    context.marker === undefined
      ? 'mock API compiled in'
      : `mock API compiled in ("${context.marker}"${context.file ? ` in ${context.file}` : ''})`;
  if (context.mockApiSetting === false) {
    return {
      fatal: false,
      lines: [
        `Mock API available: ${matched}, but this profile has forgejoToolkit.useMockApi set to false.`,
        '  note:      the extension will not intercept, so this run would use the real instance(s) —',
        '             pass --real-api to say that on purpose, or set the setting back to true for a',
        '             mock-backed run',
      ],
    };
  }
  // What this line can honestly say: the registry is a mirror a window rewrites at
  // activation from the editor's own instance store, and this gate reads it *before*
  // the window starts. So "none recorded yet" is not "nothing to poll" — measured
  // 2026-10-05: an `--ai-mock` launch printed the empty-registry note and the window
  // then polled the profile's seeded mock instance, which it wrote into that file
  // during activation. The wording says which read this is and what has not been
  // checked, instead of letting a reader conclude the run polls nothing.
  const registryPath = mcpInstancesPath(context.profileDir);
  const recordedInstances =
    context.instances.length === 0
      ? `  instances: none recorded in the profile's registry yet (${registryPath}) —`
      : `  instances: ${context.instances.length} recorded in the profile's registry (${registryPath})` +
        (context.handledApiPath === undefined
          ? ':'
          : `, every one of them covered by the handlers (<any scheme>://<any host>${context.handledApiPath}…):`);
  return {
    fatal: false,
    lines: [
      `Mock-backed run: ${matched}, and forgejoToolkit.useMockApi is on in this profile.`,
      recordedInstances,
      ...context.instances.map((instance) => `             ${describeInstance(instance)}`),
      ...(context.instances.length === 0
        ? [
            '             that file is a mirror the window rewrites at activation, so "none recorded yet" is not',
            '             "nothing to poll": the window polls the instances its own store holds and writes them there,',
            '             and an instance the file does not name yet has not been checked against the handlers.',
          ]
        : []),
    ],
  };
}

export interface RequireApiModeOptions {
  buildDir: string;
  profileDir: string;
  instances: readonly ConfiguredInstance[];
  mockApiSetting?: boolean;
  realApiRequested: boolean;
}

/**
 * The configured instances the mock API cannot serve, with the reason for each.
 *
 * `handledPath` is the API path read out of the handlers themselves
 * ({@link handledApiPath}); when it cannot be read, **nothing** is called
 * mockable, so a mock-backed run is refused rather than started on a guess. That
 * is the conservative direction on purpose: the cost of refusing is one message
 * before anything is spawned, the cost of being wrong is a run that reaches the
 * network while claiming to be offline.
 */
export function unmockableInstances(
  instances: readonly ConfiguredInstance[],
  handledPath: string | undefined,
): { instances: ConfiguredInstance[]; reasons: Record<string, string> } {
  const blocked: ConfiguredInstance[] = [];
  const reasons: Record<string, string> = {};
  for (const instance of instances) {
    if (handledPath !== undefined && mockableInstancePath(instance.url, handledPath) !== undefined) {
      continue;
    }
    blocked.push(instance);
    reasons[instance.id] =
      handledPath === undefined
        ? `the handlers' own API path could not be read from ${MOCKS_HANDLERS_SOURCE}, so nothing is known to be mockable`
        : `its path is not the origin root the handlers match (they cover <any scheme>://<any host>${handledPath}…)`;
  }
  return { instances: blocked, reasons };
}

/**
 * The gate both entry points call before they start anything: detect, decide,
 * print the report, and `process.exit(1)` on the refusal. Returns the mode the
 * run may use.
 */
export function requireApiMode(options: RequireApiModeOptions): 'mock' | 'real-api' {
  const detection = detectMockBuild(options.buildDir);
  const apiPath = handledApiPath();
  const blocked = unmockableInstances(options.instances, apiPath);
  const decision = decideApiMode({
    mocksCompiledIn: detection.mocksCompiledIn,
    realApiRequested: options.realApiRequested,
    unmockableInstances: blocked.instances,
  });
  const report = apiModeReport(decision, {
    buildDir: options.buildDir,
    profileDir: options.profileDir,
    instances: options.instances,
    ...(options.mockApiSetting === undefined ? {} : { mockApiSetting: options.mockApiSetting }),
    ...(detection.marker === undefined ? {} : { marker: detection.marker }),
    ...(detection.file === undefined ? {} : { file: detection.file }),
    ...(apiPath === undefined ? {} : { handledApiPath: apiPath }),
    ...(blocked.instances.length === 0
      ? {}
      : { unmockableInstances: blocked.instances, unmockableReasons: blocked.reasons }),
    buildPresent: detection.buildPresent,
  });
  for (const line of report.lines) {
    if (report.fatal) console.error(line);
    else console.log(line);
  }
  if (report.fatal || decision.action === 'abort') {
    // Nothing has been spawned at this point: the refusal is what keeps a
    // production build — or a profile the handlers cannot serve — from silently
    // polling the real instance.
    process.exit(1);
  }
  return decision.mode;
}
