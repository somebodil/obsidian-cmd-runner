import type { Page } from "./cdp.ts";

/**
 * What is done inside Obsidian during a run. Each step is a piece of
 * JavaScript that runs in the page of Obsidian and answers with plain data.
 *
 * The pieces use what Obsidian gives its plugins (`app.commands`,
 * `app.vault`, `app.metadataCache`), and for turning plugins on what its own
 * settings page uses (`app.plugins`), which is not promised to stay as it is.
 */

/** What a command that takes part in a run finds as `window.obsidianCmdRunner` */
export interface RunnerInPage {
  /** The version of this agreement */
  version: 1;
  /** What the run was given for the command */
  args: Record<string, unknown>;
  /** Says that the command will tell when it is done. To be called before the command first waits for anything. */
  claim(): void;
  /** The command is done, and this is what it has to say */
  done(result?: unknown): void;
  /** The command could not do its work */
  fail(error: unknown): void;
  /** A line for the one who watches the run */
  log(message: string): void;
}

const asCode = (value: unknown): string => JSON.stringify(value);

/** Waits until Obsidian has opened the vault and laid out its window */
export async function whenReady(page: Page): Promise<{ vault: string; obsidian: string }> {
  return page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    while (typeof app === "undefined" || !app.workspace || !app.vault) await sleep(25);
    await new Promise((r) => app.workspace.onLayoutReady(r));
    const version = /obsidian\\/([0-9.]+)/i.exec(navigator.userAgent);
    return { vault: app.vault.getName(), obsidian: version ? version[1] : "" };
  })()`);
}

/**
 * Turns the plugins on. A vault that is opened for the first time asks
 * whether its plugins are trusted; the one who starts a run on a vault has
 * said so, and the question is answered.
 */
export async function turnOn(page: Page, ids: readonly string[]): Promise<{ on: string[]; failed: { id: string; why: string }[] }> {
  return page.evaluate(`(async () => {
    const ids = ${asCode(ids)};
    const closeModals = () => document.querySelectorAll(".modal-container .modal-close-button").forEach((b) => b.click());
    closeModals();
    const plugins = app.plugins;
    // Lets plugins run in this vault, and loads the ones the vault has turned on: the list of those was
    // emptied before Obsidian started when they are to stay off
    await plugins.setEnable(true);
    await plugins.loadManifests();
    const failed = [];
    for (const id of ids) {
      const manifest = plugins.manifests[id];
      if (!manifest) { failed.push({ id, why: "Obsidian does not find it in the vault." }); continue; }
      try {
        await plugins.enablePlugin(id);
      } catch (error) {
        failed.push({ id, why: String(error && error.message || error) });
        continue;
      }
      if (!plugins.plugins[id]) {
        failed.push({ id, why: "Obsidian did not load it." + (manifest.minAppVersion ? " It asks for Obsidian " + manifest.minAppVersion + " or later." : "") });
      }
    }
    closeModals();
    return { on: Object.keys(plugins.plugins).sort(), failed };
  })()`);
}

/** Waits until Obsidian has read every note: what plugins ask it about notes is complete only then */
export async function whenIndexed(page: Page): Promise<{ notes: number }> {
  return page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (;;) {
      const notes = app.vault.getMarkdownFiles();
      const busy = app.metadataCache.inProgressTaskCount;
      if ((busy === undefined || busy === 0) && notes.every((note) => app.metadataCache.getFileCache(note) !== null)) return { notes: notes.length };
      await sleep(50);
    }
  })()`);
}

/** Puts `window.obsidianCmdRunner` into the page, fresh for one command */
export async function offerRunner(page: Page, args: Record<string, unknown>): Promise<void> {
  await page.evaluate(`(() => {
    const state = { claimed: false, finished: false, ok: false, result: null, error: null };
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    window.__obsidianCmdRunner = { state, done };
    window.obsidianCmdRunner = {
      version: 1,
      args: ${asCode(args)},
      claim() { state.claimed = true; },
      done(result) { if (state.finished) return; state.claimed = true; state.finished = true; state.ok = true; state.result = result === undefined ? null : result; settle(); },
      fail(error) { if (state.finished) return; state.claimed = true; state.finished = true; state.error = error instanceof Error ? error.message : String(error); settle(); },
      log(message) { console.log("[runner] " + String(message)); },
    };
  })()`);
}

export interface Started {
  /** False when Obsidian knows no command with the id */
  found: boolean;
  /** Commands of the same plugin, for the one who mistyped */
  similar: string[];
  /** False when the command said that it cannot run now */
  ran: boolean;
  /** True when the command will say when it is done */
  claimed: boolean;
}

/** Starts a command. A command that takes part in the run has a moment to say so. */
export async function startCommand(page: Page, id: string): Promise<Started> {
  return page.evaluate(`(async () => {
    const id = ${asCode(id)};
    const state = window.__obsidianCmdRunner.state;
    if (!app.commands.commands[id]) {
      const plugin = id.split(":")[0] + ":";
      return { found: false, similar: Object.keys(app.commands.commands).filter((known) => known.startsWith(plugin)).sort().slice(0, 30), ran: false, claimed: false };
    }
    // A command can say that it does not apply now. Obsidian does not pass that on, so it is asked first.
    const command = app.commands.commands[id];
    const applies = typeof command.checkCallback !== "function" || command.checkCallback(true) !== false;
    const ran = applies && app.commands.executeCommandById(id) !== false;
    for (let waited = 0; ran && !state.claimed && waited < 300; waited += 20) await new Promise((r) => setTimeout(r, 20));
    return { found: true, similar: [], ran, claimed: state.claimed };
  })()`);
}

export interface Outcome {
  ok: boolean;
  result: unknown;
  error: string | null;
}

/** Waits for a command that takes part in the run to say that it is done */
export async function whenDone(page: Page): Promise<Outcome> {
  const text = await page.evaluate<string>(`(async () => {
    const { state, done } = window.__obsidianCmdRunner;
    await done;
    try {
      return JSON.stringify({ ok: state.ok, result: state.result, error: state.error });
    } catch (error) {
      return JSON.stringify({ ok: false, result: null, error: "What the command gave back cannot be written as JSON: " + String(error) });
    }
  })()`);
  return JSON.parse(text) as Outcome;
}

/** Runs a piece of JavaScript in Obsidian. `runner` in it is `window.obsidianCmdRunner`. What it returns is the result. */
export async function runCode(page: Page, code: string): Promise<Outcome> {
  const text = await page.evaluate<string>(`(async () => {
    const runner = window.obsidianCmdRunner;
    try {
      const result = await (async () => {\n${code}\n})();
      return JSON.stringify({ ok: true, result: result === undefined ? null : result, error: null });
    } catch (error) {
      return JSON.stringify({ ok: false, result: null, error: String(error && error.stack || error) });
    }
  })()`);
  return JSON.parse(text) as Outcome;
}
