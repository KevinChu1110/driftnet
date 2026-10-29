/** Tiny argument parser for the `driftnet` subcommands: no dependency, `--flag value`, `--flag=value`, `-o file`. */
export class UsageError extends Error {}

export interface ArgSpec {
  /** Flags that take a value. */
  value?: string[];
  /** Flags that are on/off. */
  bool?: string[];
  /** Short names: `{ o: "output" }`. */
  short?: Record<string, string>;
}

export interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Flags every command accepts. */
const COMMON: ArgSpec = { value: ["url", "token"], bool: ["help"] };

export function parseArgs(argv: string[], spec: ArgSpec = {}): Parsed {
  const values = new Set([...(COMMON.value ?? []), ...(spec.value ?? [])]);
  const bools = new Set([...(COMMON.bool ?? []), ...(spec.bool ?? [])]);
  const short = spec.short ?? {};
  const out: Parsed = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { out.positional.push(...argv.slice(i + 1)); break; }
    let name: string | undefined;
    let inline: string | undefined;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (eq >= 0) inline = a.slice(eq + 1);
    } else if (/^-[A-Za-z]$/.test(a)) {
      name = short[a.slice(1)];
      if (!name) throw new UsageError(`unknown option ${a}`);
    } else {
      out.positional.push(a);
      continue;
    }
    if (values.has(name)) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new UsageError(`--${name} needs a value`);
      out.flags[name] = v;
    } else if (bools.has(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      out.flags[name] = true;
    } else {
      throw new UsageError(`unknown option ${a}`);
    }
  }
  return out;
}
