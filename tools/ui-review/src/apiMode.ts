// Whether the build on disk can serve mock data — and what the launcher does
// about it.
//
// Why detection and not a launcher flag: the mock API (msw plus
// `packages/forgejo-toolkit/src/test/mocks/`) is compiled in only for a
// non-production build. `packages/forgejo-toolkit/esbuild.js` *defines*
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
import fs from 'node:fs';
import path from 'node:path';
import type { ConfiguredInstance } from './config';

/** Literals that survive only when `src/test/mocks/` was compiled in (see above). */
export const MOCK_BUILD_MARKERS: readonly string[] = [
  '[mocks] no handler matched',
  '(a test must never reach the real network).',
  'A demo repository for offline development.',
  'Demonstrates API failure states: changed-files fetches fail with 500.',
];

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
 * directory and the `esbuild.js` define that removes it.
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
}

export interface ApiModeInput {
  mocksCompiledIn: boolean;
  realApiRequested: boolean;
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
  | { action: 'abort'; reason: 'no-mocks-and-no-opt-in' };

/**
 * The whole decision, as a pure function of "can this build mock?" and "did the
 * operator opt in?". Both entry points (`launch.ts` and `dual.ts launch`) run it
 * before they spawn anything, so there is one rule rather than two.
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

/**
 * The text for one decision. Kept separate from the printing so the exact
 * wording — including the two ways forward — is pinned by tests instead of
 * living only in a `console.error` call.
 */
export function apiModeReport(decision: ApiModeDecision, context: ApiModeContext): ApiModeReport {
  if (decision.action === 'abort') {
    const buildLine = context.buildPresent
      ? `  build:     ${context.buildDir}  (no mock API compiled in)`
      : `  build:     ${context.buildDir} does not exist (nothing to load)`;
    const why = context.buildPresent
      ? [
          '             a production build defines FORGEJO_TOOLKIT_INCLUDE_MOCKS=false, which',
          '             dead-code-eliminates src/test/mocks/ (msw and its fixtures) — see',
          '             packages/forgejo-toolkit/esbuild.js',
        ]
      : ['             run a build first (packages/forgejo-toolkit/out is what the dev host loads)'];
    return {
      fatal: true,
      lines: [
        'Refusing to launch: this dev host would poll a real server.',
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
  return {
    fatal: false,
    lines: [`Mock-backed run: ${matched}, and forgejoToolkit.useMockApi is on in this profile.`],
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
 * The gate both entry points call before they start anything: detect, decide,
 * print the report, and `process.exit(1)` on the refusal. Returns the mode the
 * run may use.
 */
export function requireApiMode(options: RequireApiModeOptions): 'mock' | 'real-api' {
  const detection = detectMockBuild(options.buildDir);
  const decision = decideApiMode({
    mocksCompiledIn: detection.mocksCompiledIn,
    realApiRequested: options.realApiRequested,
  });
  const report = apiModeReport(decision, {
    buildDir: options.buildDir,
    profileDir: options.profileDir,
    instances: options.instances,
    ...(options.mockApiSetting === undefined ? {} : { mockApiSetting: options.mockApiSetting }),
    ...(detection.marker === undefined ? {} : { marker: detection.marker }),
    ...(detection.file === undefined ? {} : { file: detection.file }),
    buildPresent: detection.buildPresent,
  });
  for (const line of report.lines) {
    if (report.fatal) console.error(line);
    else console.log(line);
  }
  if (report.fatal || decision.action === 'abort') {
    // Nothing has been spawned at this point: the refusal is what keeps a
    // production build from silently polling the profile's real instance.
    process.exit(1);
  }
  return decision.mode;
}
