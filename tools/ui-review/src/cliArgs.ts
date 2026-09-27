// Argument parsing for the dual-window CLI, kept separate from the orchestrator
// (which imports Playwright) so it is unit-testable.
//
// Flags are spelled out rather than abbreviated: this mode launches an app and
// kills processes, so a typo must fail loudly instead of falling back to a
// default. Unknown flags are an error, exactly like an unknown window selector.
export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

export interface FlagSpec {
  /** Flags that take a value. */
  value: readonly string[];
  /** Flags that are booleans. */
  boolean: readonly string[];
}

export function parseArgs(argv: readonly string[], spec: FlagSpec): ParsedArgs {
  const known = new Set([...spec.value, ...spec.boolean]);
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = splitFlag(arg);
    if (!known.has(name)) {
      throw new Error(`unknown flag '${name}' (known: ${[...known].sort().join(', ')})`);
    }
    if (spec.boolean.includes(name)) {
      if (inline !== undefined) throw new Error(`flag '${name}' does not take a value`);
      flags.set(name, true);
      continue;
    }
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`flag '${name}' needs a value`);
    }
    flags.set(name, next);
    index += 1;
  }
  return { positional, flags };
}

function splitFlag(arg: string): [string, string | undefined] {
  const equals = arg.indexOf('=');
  if (equals === -1) return [arg, undefined];
  return [arg.slice(0, equals), arg.slice(equals + 1)];
}

export function flagString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') throw new Error(`flag '${name}' needs a value`);
  return value;
}

export function flagNumber(parsed: ParsedArgs, name: string, fallback: number): number {
  const raw = flagString(parsed, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`flag '${name}' needs a number, got '${raw}'`);
  return value;
}

export function flagBool(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}
