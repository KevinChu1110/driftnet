import type { Judge } from "./index.ts";

/** Builds a judge from the settings; return undefined when it isn't configured (a missing key, say). */
export type JudgeFactory = (env: NodeJS.ProcessEnv) => Judge | undefined;

const judges = new Map<string, JudgeFactory>();

/**
 * Add a judge selectable with DRIFTNET_JUDGE=<name>. Built-in names (jev, llm,
 * heuristic, off, rules) are handled first, except that a registered `jev` or
 * `rules` replaces the built-in one.
 */
export function registerJudge(name: string, factory: JudgeFactory): void {
  judges.set(name.toLowerCase(), factory);
}

export function judgeFactory(name: string): JudgeFactory | undefined {
  return judges.get(name.toLowerCase());
}

export function registeredJudges(): string[] {
  return [...judges.keys()];
}

/** The judge DRIFTNET_JUDGE names among the registered ones; undefined when none is registered under that name. */
export function createJudge(name: string, env: NodeJS.ProcessEnv): Judge | undefined {
  return judgeFactory(name)?.(env);
}
