/**
 * obsidian-cmd-runner as a package: the same run the command line does, to
 * be called from code.
 *
 * ```ts
 * import { run, DEFAULTS } from "obsidian-cmd-runner";
 *
 * const result = await run(
 *   { ...DEFAULTS, vault: "notes", plugins: ["./my-plugin"], commands: ["my-plugin:export"] },
 *   { say: console.error, console: () => {}, fetch, env: process.env },
 * );
 * ```
 */
export { DEFAULTS, parseArgs, type Options } from "./args.ts";
export { main } from "./cli.ts";
export { defaultCacheDir, installObsidian, type Installed } from "./install.ts";
export { resolveVersion } from "./releases.ts";
export { EXIT, run, RunError, type CommandResult, type Io, type RunResult } from "./run.ts";
export type { RunnerInPage } from "./session.ts";
