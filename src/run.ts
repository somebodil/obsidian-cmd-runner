import { existsSync, statSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Options } from "./args.ts";
import { connect, PageReloaded, type Page } from "./cdp.ts";
import { defaultCacheDir, installObsidian, programOfApp, workDir } from "./install.ts";
import { chooseScreen, freePort, makeScreen, start, startArgs, type Running } from "./launch.ts";
import { parsePlugin, placePlugin, removePlaced, type Placed } from "./plugins.ts";
import { resolveVersion, type Fetch } from "./releases.ts";
import { offerRunner, runCode, startCommand, turnOn, whenDone, whenIndexed, whenReady, type Outcome } from "./session.ts";
import { keepSettings, prepareProfile, restoreSettings, type Kept } from "./vault.ts";

/** The plugin that builds a site, and its command: what a run does when it is told nothing else */
export const SITE_PLUGIN = { id: "vault-to-site", source: "somebodil/vault-to-site", command: "vault-to-site:build-again", config: "vault-to-site.json" };

/** How a run can end. The number is what the program ends with. */
export const EXIT = { ok: 0, failed: 1, usage: 2, obsidian: 3, timeout: 124 } as const;

export class RunError extends Error {
  readonly exit: number;
  constructor(message: string, exit: number) {
    super(message);
    this.exit = exit;
  }
}

export interface CommandResult {
  /** The id of the command, or `eval` for a file of JavaScript */
  command: string;
  ok: boolean;
  /** True when the command said itself when it was done */
  claimed: boolean;
  result: unknown;
  error: string | null;
  millis: number;
}

export interface RunResult {
  ok: boolean;
  /** The version of Obsidian that ran */
  obsidian: string;
  vault: string;
  /** The plugins that were on */
  plugins: string[];
  commands: CommandResult[];
  /** How long each part took, in milliseconds */
  timings: Record<string, number>;
}

export interface Io {
  /** A line for the one who watches */
  say(text: string): void;
  /** A line Obsidian wrote to its console */
  console(kind: string, text: string): void;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
}

const isFolder = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

function within<T>(work: Promise<T>, millis: number, what: string, page: Page | null, running: Running): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RunError(`${what} took longer than ${String(Math.round(millis / 1000))} seconds.`, EXIT.timeout)), millis);
  });
  const gone = (page?.closed ?? new Promise<never>(() => undefined)).then(() => {
    throw new RunError(`Obsidian was closed while ${what.charAt(0).toLowerCase() + what.slice(1)} ran. ${running.ended() ?? ""}`.trim(), EXIT.obsidian);
  });
  return Promise.race([work, late, gone]).finally(() => clearTimeout(timer));
}

/** The file in which a vault keeps the plugins it has turned on */
const ENABLED_PLUGINS = "community-plugins.json";
/** Before a line that a command writes for the one who watches the run: see `RunnerInPage.log` */
const SAID_BY_COMMAND = "[runner] ";

/** How long Obsidian may take to open the vault, before any command */
const START_LIMIT = 120_000;

/**
 * Runs commands in a vault, in an Obsidian that is started for it and ended
 * after it. The vault is left as it was found, apart from what the commands
 * themselves do to it.
 *
 * @param stop resolves when the run is to be given up, as on Ctrl+C: what was put into the vault is still taken away
 */
export async function run(options: Options, io: Io, stop: Promise<void> = new Promise(() => undefined)): Promise<RunResult> {
  const timings: Record<string, number> = {};
  const clock = (): number => Number(process.hrtime.bigint() / 1_000_000n);
  const lap = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const from = clock();
    try {
      return await work();
    } finally {
      timings[name] = (timings[name] ?? 0) + clock() - from;
    }
  };

  const vault = resolve(options.vault);
  if (!isFolder(vault)) {
    throw new RunError(`"${options.vault}" is not a folder: --vault names the folder of a vault.`, EXIT.usage);
  }

  // What to run. Told nothing, a site is built.
  const commands = [...options.commands];
  const specs = [...options.plugins];
  const args = { ...options.args };
  const configDir = ".obsidian";
  const pluginsDir = join(vault, configDir, "plugins");
  if (commands.length === 0 && options.evalFile === null) {
    commands.push(SITE_PLUGIN.command);
    if (specs.length === 0 && !isFolder(join(pluginsDir, SITE_PLUGIN.id))) {
      specs.push(SITE_PLUGIN.source);
    }
    const config = options.config !== null ? resolve(options.config) : join(vault, SITE_PLUGIN.config);
    if (options.config !== null || existsSync(config)) {
      try {
        args.settings = JSON.parse(await readFile(config, "utf8")) as unknown;
      } catch (error) {
        throw new RunError(`"${config}" could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`, EXIT.usage);
      }
    }
  }
  const code = options.evalFile === null ? null : await readFile(resolve(options.evalFile), "utf8").catch(() => null);
  if (options.evalFile !== null && code === null) {
    throw new RunError(`"${options.evalFile}" could not be read.`, EXIT.usage);
  }
  const sources = specs.map((spec) => {
    try {
      return parsePlugin(spec, isFolder);
    } catch (error) {
      throw new RunError(error instanceof Error ? error.message : String(error), EXIT.usage);
    }
  });

  // The program of Obsidian
  let program: string;
  if (options.obsidianApp !== null) {
    program = programOfApp(resolve(options.obsidianApp));
    if (!existsSync(program)) {
      throw new RunError(`There is no Obsidian at "${options.obsidianApp}".`, EXIT.usage);
    }
  } else {
    const version = await lap("resolve", () => resolveVersion(options.obsidianVersion, io.fetch as unknown as Fetch)).catch((error: unknown) => {
      throw new RunError(error instanceof Error ? error.message : String(error), EXIT.usage);
    });
    const installed = await lap("fetch", () => installObsidian(version, options.cacheDir ?? defaultCacheDir(io.env), io.fetch, io.say)).catch((error: unknown) => {
      throw new RunError(error instanceof Error ? error.message : String(error), EXIT.obsidian);
    });
    program = installed.program;
    io.say(`Obsidian ${version}${installed.fromCache ? " (kept from before)" : ""}`);
  }

  let kept: Kept | null = null;
  const placed: Placed[] = [];
  let profile: string | null = null;
  let running: Running | null = null;
  let made: { display: string; stop(): void } | null = null;
  let page: Page | null = null;
  let stopped = false;
  void stop.then(() => {
    stopped = true;
    page?.close();
    void running?.stop();
  });

  try {
    kept = await keepSettings(vault, configDir);
    if (!options.vaultPlugins && kept.files.has(ENABLED_PLUGINS)) {
      // Obsidian turns on what this list names. Emptied for the run, and put back after it.
      await writeFile(join(kept.folder, ENABLED_PLUGINS), "[]");
    }
    const token = options.githubToken ?? io.env.GITHUB_TOKEN ?? io.env.GH_TOKEN ?? null;
    await lap("plugins", async () => {
      for (const source of sources) {
        const one = await placePlugin(source, pluginsDir, process.cwd(), io.fetch, token === "" ? null : token).catch((error: unknown) => {
          throw new RunError(error instanceof Error ? error.message : String(error), EXIT.usage);
        });
        placed.push(one);
        if (!one.placed) {
          io.say(`The vault has the plugin ${one.id} already: that one is used.`);
        }
      }
    });

    profile = await workDir();
    await prepareProfile(profile, vault, Date.now());
    const port = await freePort();
    const screen = chooseScreen(process.platform, io.env, options.show);
    if (screen === "made") {
      made = await lap("start", () => makeScreen()).catch((error: unknown) => {
        throw new RunError(error instanceof Error ? error.message : String(error), EXIT.obsidian);
      });
    }
    running = start(program, startArgs(profile, port, screen), made === null ? io.env : { ...io.env, DISPLAY: made.display });
    const live = running;

    page = await lap("start", () => connect(port, START_LIMIT, () => live.ended())).catch((error: unknown) => {
      throw new RunError(error instanceof Error ? error.message : String(error), EXIT.obsidian);
    });
    const open = page;
    // What a command says to the one who watches is passed on as that; the rest is the console of Obsidian
    open.onConsole((kind, text) => {
      if (text.startsWith(SAID_BY_COMMAND)) {
        io.say(text.slice(SAID_BY_COMMAND.length));
      } else {
        io.console(kind, text);
      }
    });
    const wanted = [...new Set([...placed.map((plugin) => plugin.id), ...commands.map((id) => id.split(":")[0] ?? "").filter((id) => isFolder(join(pluginsDir, id)))])];
    // Obsidian loads its page anew at times while it starts. What was done in the page is gone then,
    // and is done again: each of these steps can be done twice.
    const prepare = async (): Promise<{ ready: Awaited<ReturnType<typeof whenReady>>; turned: Awaited<ReturnType<typeof turnOn>> }> => {
      for (let attempt = 1; ; attempt++) {
        try {
          const ready = await lap("open", () => within(whenReady(open), START_LIMIT, "Opening the vault", open, live));
          const turned = await lap("plugins", () => within(turnOn(open, wanted), START_LIMIT, "Turning the plugins on", open, live));
          await lap("index", () => within(whenIndexed(open), START_LIMIT, "Reading the notes", open, live));
          return { ready, turned };
        } catch (error) {
          if (!(error instanceof PageReloaded) || attempt === 5) {
            throw error;
          }
        }
      }
    };
    const { ready, turned } = await prepare();
    if (turned.failed.length > 0) {
      throw new RunError(turned.failed.map((one) => `The plugin ${one.id} could not be turned on. ${one.why}`).join("\n"), EXIT.failed);
    }

    const results: CommandResult[] = [];
    const limit = options.timeout * 1000;
    const record = (command: string, claimed: boolean, outcome: Outcome, from: number): boolean => {
      results.push({ command, ok: outcome.ok, claimed, result: outcome.result, error: outcome.error, millis: clock() - from });
      return outcome.ok;
    };
    if (code !== null) {
      const from = clock();
      await offerRunner(open, args);
      record("eval", true, await lap("commands", () => within(runCode(open, code), limit, "The code", open, live)), from);
    }
    for (const id of commands) {
      const from = clock();
      await offerRunner(open, args);
      const started = await startCommand(open, id);
      if (!started.found) {
        const hint = started.similar.length > 0 ? ` The plugin has: ${started.similar.join(", ")}.` : " Is its plugin in the vault? Name it with --plugin.";
        record(id, false, { ok: false, result: null, error: `Obsidian has no command "${id}".${hint}` }, from);
        break;
      }
      if (!started.ran) {
        record(id, false, { ok: false, result: null, error: `The command "${id}" cannot run now: it says that it does not apply.` }, from);
        break;
      }
      let outcome: Outcome = { ok: true, result: null, error: null };
      if (options.wait.startsWith("file:")) {
        const file = resolve(vault, options.wait.slice(5));
        const appear = (async (): Promise<Outcome> => {
          while (!(await stat(file).then(() => true, () => false))) {
            await new Promise((done) => setTimeout(done, 100));
          }
          return { ok: true, result: null, error: null };
        })();
        outcome = await lap("commands", () => within(appear, limit, `The command "${id}"`, open, live));
      } else if (options.wait === "auto" && started.claimed) {
        outcome = await lap("commands", () => within(whenDone(open), limit, `The command "${id}"`, open, live));
      }
      if (!record(id, started.claimed, outcome, from)) {
        break;
      }
    }
    return { ok: results.every((one) => one.ok), obsidian: ready.obsidian, vault: ready.vault, plugins: turned.on, commands: results, timings };
  } catch (error) {
    if (stopped) {
      throw new RunError("The run was stopped.", 130);
    }
    if (error instanceof PageReloaded) {
      throw new RunError("Obsidian loaded its page anew while a command ran, so what came of the command is not known.", EXIT.obsidian);
    }
    throw error;
  } finally {
    const from = clock();
    // On Linux Obsidian ends at once when its browser is asked to close, and not soon when the program is
    // told to end. On macOS it is the other way round: asking only closes the window, and the program
    // ends at once when told to, once nothing is connected to it any more.
    const asked = page;
    if (process.platform === "linux" && asked !== null) {
      await running?.stop(() => void asked.send("Browser.close").catch(() => undefined));
      asked.close();
    } else {
      page?.close();
      await running?.stop();
    }
    made?.stop();
    if (!options.keep) {
      await removePlaced(placed).catch(() => undefined);
      if (kept !== null) {
        await restoreSettings(kept).catch(() => undefined);
      }
    } else if (kept !== null && !options.vaultPlugins) {
      // Also when the rest is left: the list of the vault's own plugins was emptied only for the run
      const list = kept.files.get(ENABLED_PLUGINS);
      if (list !== undefined) {
        await writeFile(join(kept.folder, ENABLED_PLUGINS), list).catch(() => undefined);
      }
    }
    if (profile !== null) {
      await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    }
    timings.end = clock() - from;
  }
}
