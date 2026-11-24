import { existsSync, statSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Options } from "./args.ts";
import { connect, PageClosed, PageReloaded, type Page } from "./cdp.ts";
import { defaultCacheDir, installObsidian, programOfApp, resolveVersionKept, workDir } from "./install.ts";
import { chooseScreen, freePort, makeScreen, start, startArgs, type Running } from "./launch.ts";
import { parsePlugin, placePlugin, removePlaced, type Placed, type PluginSource } from "./plugins.ts";
import type { Fetch } from "./releases.ts";
import { dropUnkept, offerRunner, runCode, startCommand, stopFollowing, windowLeftOpen, turnOn, whenDone, whenIndexed, whenReady, workLeft, type Outcome, type Work } from "./session.ts";
import { keepSettings, prepareProfile, restoreSettings, type Kept } from "./vault.ts";

/** How a run can end. The number is what the program ends with. */
export const EXIT = { ok: 0, failed: 1, usage: 2, obsidian: 3, timeout: 124, stopped: 130 } as const;

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
  /**
   * What told the run that the command had ended: the command itself
   * (`said`), its work coming to an end (`work`), a file (`file`), or
   * nothing, where the run did not wait (`none`)
   */
  ended: "said" | "work" | "file" | "none";
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

/**
 * Gives work a time to be done in, and gives it up when Obsidian is closed.
 *
 * @param exit what the run ends with when the time is over: a command that takes too long is not an Obsidian that does not start
 */
export function within<T>(work: Promise<T>, millis: number, what: string, page: Page | null, running: Pick<Running, "ended">, exit: number = EXIT.timeout): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RunError(`${what} took longer than ${String(Math.round(millis / 1000))} seconds.`, exit)), millis);
  });
  const gone = (page?.closed ?? new Promise<never>(() => undefined)).then(() => {
    throw new RunError(`Obsidian was closed while ${what.charAt(0).toLowerCase() + what.slice(1)} ran. ${running.ended() ?? ""}`.trim(), EXIT.obsidian);
  });
  return Promise.race([work, late, gone]).finally(() => clearTimeout(timer));
}

/** What is noted of a file before a command, to see later that the command has written it. Null when the file is not there. */
export type FileState = { mtime: number; size: number } | null;

export const fileState = (path: string): Promise<FileState> =>
  stat(path).then(
    (found) => ({ mtime: found.mtimeMs, size: found.size }),
    () => null,
  );

/** True when a file is there and is not the file that was there before: one that an earlier run has left does not count */
export const isWritten = (before: FileState, now: FileState): boolean => now !== null && (before === null || now.mtime !== before.mtime || now.size !== before.size);

/**
 * Waits until a file is written. It is looked at ten times a second, and
 * only as long as somebody waits: looking on after a command was given up
 * would keep the program from ending.
 */
export async function whenWritten(file: string, before: FileState, waited: () => boolean): Promise<void> {
  while (waited() && !isWritten(before, await fileState(file))) {
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** For how long nothing of the work of a command may go on before the command is said to have ended, in milliseconds */
export const CALM = 150;
/** After how long with nothing left but promises the browser is asked to take away those that nothing can reach */
export const STALE = 250;
/** How long the browser is given between two such askings */
const BETWEEN_COLLECTIONS = 400;

/** What is kept between two looks at the work of a command */
export interface Watch {
  /** `Work.moves` at the last look */
  moves: number;
  /** Since when nothing has gone on */
  since: number;
  /** When the browser was last asked to take away what nothing can reach */
  collected: number;
}

/**
 * Says what a look at the work of a command means.
 *
 * A command has ended when nothing of its work is left, nothing is being
 * asked of the system, and it has stayed so for a moment: between two steps
 * of a command there can be an instant with nothing open.
 *
 * Promises that stay open with nothing else going on are either waiting for
 * something the run cannot see, or nothing can keep them any more. The
 * browser is asked to take the second kind away (`collect`), and the first
 * kind is waited for: a command that waits for a click in a window is not
 * done, and a run with nobody to click ends when its time is over.
 */
export function judgeWork(left: Work, watch: Watch, now: number): "ended" | "failed" | "collect" | "wait" {
  if (left.failed !== null) {
    return "failed";
  }
  if (left.said) {
    return "ended";
  }
  if (left.moves !== watch.moves || left.going > 0) {
    watch.moves = left.moves;
    watch.since = now;
    return "wait";
  }
  const still = now - watch.since;
  if (left.promise + left.timer + left.frame + left.system === 0) {
    return still >= CALM ? "ended" : "wait";
  }
  if (left.timer + left.frame + left.system === 0 && still >= STALE && now - watch.collected >= BETWEEN_COLLECTIONS) {
    watch.collected = now;
    return "collect";
  }
  return "wait";
}

/** What is left of the work of a command, in words: for the one whose run ended because it took too long */
export function leftInWords(left: Work): string {
  const count = (many: number, one: string, more: string): string | null => (many === 0 ? null : `${String(many)} ${many === 1 ? one : more}`);
  const parts = [
    count(left.promise, "promise", "promises"),
    count(left.timer, "timer", "timers"),
    count(left.frame, "call before the next drawing", "calls before the next drawing"),
    count(left.system, "request to the system", "requests to the system"),
  ].filter((part) => part !== null);
  const what = parts.length === 0 ? "nothing that is followed" : parts.join(", ");
  return left.started.length === 0 ? what : `${what}. Started at: ${left.started.join("; ")}`;
}

/**
 * Waits until the work of a command has ended, for a command that does not
 * say so itself. Looked at forty times a second, and only as long as
 * somebody waits.
 *
 * @param seen told what was left at each look
 */
export async function whenWorkEnds(page: Page, waited: () => boolean, seen: (left: Work) => void = () => undefined): Promise<Outcome> {
  const watch: Watch = { moves: -1, since: Date.now(), collected: 0 };
  while (waited()) {
    const left = await workLeft(page);
    if (left === null) {
      break;
    }
    seen(left);
    const verdict = judgeWork(left, watch, Date.now());
    if (verdict === "failed") {
      return { ok: false, result: null, error: left.failed };
    }
    if (verdict === "ended") {
      // A command that said itself that it is done, later than it should have: what it said counts
      return left.said ? whenDone(page) : { ok: true, result: null, error: null };
    }
    if (verdict === "collect") {
      await dropUnkept(page);
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  return { ok: true, result: null, error: null };
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

  // Told nothing, nothing is run: no plugin and no command is the one of this program
  if (options.commands.length === 0 && options.evalFile === null && options.evalCode === null) {
    throw new RunError(
      'Nothing to run: name a command with --command, or a file of JavaScript with --eval. "obsidian-cmd-runner commands" lists the commands there are.',
      EXIT.usage,
    );
  }
  const vault = resolve(options.vault);
  if (!isFolder(vault)) {
    throw new RunError(`"${options.vault}" is not a folder: --vault names the folder of a vault.`, EXIT.usage);
  }

  const commands = [...options.commands];
  const args = { ...options.args };
  const configDir = ".obsidian";
  const pluginsDir = join(vault, configDir, "plugins");
  const code = options.evalCode ?? (options.evalFile === null ? null : await readFile(resolve(options.evalFile), "utf8").catch(() => null));
  if (options.evalFile !== null && code === null) {
    throw new RunError(`"${options.evalFile}" could not be read.`, EXIT.usage);
  }
  const sourceOf = (spec: string): PluginSource => {
    try {
      return parsePlugin(spec, isFolder);
    } catch (error) {
      throw new RunError(error instanceof Error ? error.message : String(error), EXIT.usage);
    }
  };
  const sources = options.plugins.map(sourceOf);

  let kept: Kept | null = null;
  const placed: Placed[] = [];
  /** The settings files of plugins that were written over for the run, with what they held, or null for none */
  const own: { file: string; before: string | null }[] = [];
  let profile: string | null = null;
  let running: Running | null = null;
  let made: { display: string; stop(): void } | null = null;
  let page: Page | null = null;
  // A run that is given up: what is being fetched is let go, and Obsidian is ended when it runs. All that
  // follows is inside `try`, so that the run ends as a stopped one whatever it was doing.
  let stopped = false;
  const givenUp = (): RunError => new RunError("The run was stopped.", EXIT.stopped);
  const fetching = new AbortController();
  void stop.then(() => {
    stopped = true;
    fetching.abort();
    page?.close();
    void running?.stop();
  });
  const fetcher: typeof fetch = (from, init) => io.fetch(from, { ...init, signal: fetching.signal });

  try {
    // The program of Obsidian
    let program: string;
    if (options.obsidianApp !== null) {
      program = programOfApp(resolve(options.obsidianApp));
      if (!existsSync(program)) {
        throw new RunError(`There is no Obsidian at "${options.obsidianApp}".`, EXIT.usage);
      }
    } else {
      const cache = options.cacheDir ?? defaultCacheDir(io.env);
      const version = await lap("resolve", () => resolveVersionKept(options.obsidianVersion, cache, fetcher as unknown as Fetch)).catch((error: unknown) => {
        throw new RunError(error instanceof Error ? error.message : String(error), EXIT.usage);
      });
      const installed = await lap("fetch", () => installObsidian(version, cache, fetcher, io.say)).catch((error: unknown) => {
        throw new RunError(error instanceof Error ? error.message : String(error), EXIT.obsidian);
      });
      program = installed.program;
      io.say(`Obsidian ${version}${installed.fromCache ? " (kept from before)" : ""}`);
    }

    kept = await keepSettings(vault, configDir);
    if (!options.vaultPlugins && kept.files.has(ENABLED_PLUGINS)) {
      // Obsidian turns on what this list names. Emptied for the run, and put back after it.
      await writeFile(join(kept.folder, ENABLED_PLUGINS), "[]");
    }
    const token = options.githubToken ?? io.env.GITHUB_TOKEN ?? io.env.GH_TOKEN ?? null;
    const place = async (source: PluginSource): Promise<void> => {
      const one = await placePlugin(source, pluginsDir, process.cwd(), fetcher, token === "" ? null : token).catch((error: unknown) => {
        throw new RunError(error instanceof Error ? error.message : String(error), EXIT.usage);
      });
      placed.push(one);
      if (!one.placed) {
        io.say(`The vault has the plugin ${one.id} already: that one is used.`);
      }
    };
    await lap("plugins", async () => {
      for (const source of sources) {
        await place(source);
      }
      // The settings a plugin is given for the run: its own, when it has some, are put back after it
      for (const [id, from] of Object.entries(options.settings)) {
        const folder = join(pluginsDir, id);
        if (!isFolder(folder)) {
          throw new RunError(`--settings names the plugin "${id}", which is not in the vault and was not named with --plugin.`, EXIT.usage);
        }
        const given = await readFile(resolve(from), "utf8").catch(() => null);
        let isJson = given !== null;
        try {
          JSON.parse(given ?? "");
        } catch {
          isJson = false;
        }
        if (given === null || !isJson) {
          throw new RunError(`"${from}" could not be read as JSON: it was to be the settings of the plugin "${id}".`, EXIT.usage);
        }
        const file = join(folder, "data.json");
        own.push({ file, before: await readFile(file, "utf8").catch(() => null) });
        await writeFile(file, given);
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
    // Given up before this point, there is no Obsidian to end: it is not started
    if (stopped) {
      throw givenUp();
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
          const ready = await lap("open", () => within(whenReady(open), START_LIMIT, "Opening the vault", open, live, EXIT.obsidian));
          const turned = await lap("plugins", () => within(turnOn(open, wanted), START_LIMIT, "Turning the plugins on", open, live, EXIT.obsidian));
          await lap("index", () => within(whenIndexed(open), START_LIMIT, "Reading the notes", open, live, EXIT.obsidian));
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
    const record = (command: string, ended: CommandResult["ended"], outcome: Outcome, from: number): boolean => {
      results.push({ command, ok: outcome.ok, claimed: ended === "said", ended, result: outcome.result, error: outcome.error, millis: clock() - from });
      return outcome.ok;
    };
    if (code !== null) {
      const from = clock();
      record("eval", "said", await lap("commands", () => within(offerRunner(open, args).then(() => runCode(open, code)), limit, "The code", open, live)), from);
    }
    let saidNotFollowed = false;
    // The file that says a command is done, when one was named
    const file = options.wait.startsWith("file:") ? resolve(vault, options.wait.slice(5)) : null;
    for (const id of commands) {
      const from = clock();
      // As the file is before the command: it may be there from an earlier run
      const before = file === null ? null : await fileState(file);
      // Starting is part of the time a command may take: a command can do all its work before it gives the page back
      const started = await lap("commands", () => within(offerRunner(open, args, options.verbose).then(() => startCommand(open, id)), limit, `The command "${id}"`, open, live));
      if (!started.found) {
        const hint = started.similar.length > 0 ? ` The plugin has: ${started.similar.join(", ")}.` : " Is its plugin in the vault? Name it with --plugin.";
        record(id, "none", { ok: false, result: null, error: `Obsidian has no command "${id}".${hint}` }, from);
        break;
      }
      if (!started.ran) {
        record(id, "none", { ok: false, result: null, error: `The command "${id}" cannot run now: it says that it does not apply.` }, from);
        break;
      }
      if (started.threw !== null) {
        await stopFollowing(open);
        record(id, "none", { ok: false, result: null, error: started.threw }, from);
        break;
      }
      let outcome: Outcome = { ok: true, result: null, error: null };
      let ended: CommandResult["ended"] = "none";
      if (file !== null) {
        ended = "file";
        let waiting = true;
        const written = whenWritten(file, before, () => waiting).then((): Outcome => ({ ok: true, result: null, error: null }));
        outcome = await lap("commands", () => within(written, limit, `The command "${id}"`, open, live)).finally(() => {
          waiting = false;
        });
      } else if (options.wait === "auto" && started.claimed) {
        ended = "said";
        outcome = await lap("commands", () => within(whenDone(open), limit, `The command "${id}"`, open, live));
      } else if (options.wait === "auto" && started.followed) {
        // A command that knows nothing of the run: it has ended when the work it started has
        ended = "work";
        let waiting = true;
        let last: Work | null = null;
        outcome = await lap("commands", () => within(whenWorkEnds(open, () => waiting, (left) => (last = left)), limit, `The command "${id}"`, open, live))
          .catch((error: unknown) => {
            const left = last as Work | null;
            if (error instanceof RunError && error.exit === EXIT.timeout && left !== null) {
              throw new RunError(`${error.message} Of its work there was left: ${leftInWords(left)}.`, EXIT.timeout);
            }
            throw error;
          })
          .finally(() => {
            waiting = false;
          });
        // Nothing of its work is left, and a window it opened is: it asks something, and nobody is there to answer
        const asking = outcome.ok ? await windowLeftOpen(open) : null;
        if (asking !== null) {
          outcome = { ok: false, result: null, error: `The command opened a window and left it open ("${asking}"). It waits for an answer that nobody is there to give, so its work was not done.` };
        }
      } else if (options.wait === "auto" && !saidNotFollowed) {
        // Not passed over in silence: the run goes on while the command may still be working
        saidNotFollowed = true;
        io.say(`This Obsidian cannot follow the work of a command, so the run does not wait for "${id}". Name a file to wait for with --wait file:PATH.`);
      }
      await stopFollowing(open);
      if (!record(id, ended, outcome, from)) {
        break;
      }
    }
    return { ok: results.every((one) => one.ok), obsidian: ready.obsidian, vault: ready.vault, plugins: turned.on, commands: results, timings };
  } catch (error) {
    if (stopped) {
      throw givenUp();
    }
    if (error instanceof PageReloaded) {
      throw new RunError("Obsidian loaded its page anew while a command ran, so what came of the command is not known.", EXIT.obsidian);
    }
    if (error instanceof PageClosed) {
      throw new RunError(`Obsidian was closed before the run was over. ${running?.ended() ?? ""}`.trim(), EXIT.obsidian);
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
    // The settings of a plugin of the vault are its owner's: put back also when the rest is left
    for (const { file, before } of own) {
      await (before === null ? rm(file, { force: true }) : writeFile(file, before)).catch(() => undefined);
    }
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
