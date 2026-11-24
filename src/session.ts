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
      // Obsidian keeps to itself why a plugin did not load, and writes it to its console: that is listened to
      const said = [];
      const error = console.error;
      console.error = (...parts) => { said.push(parts.map((part) => (part instanceof Error ? part.message : String(part))).join(" ")); error.apply(console, parts); };
      try {
        await plugins.enablePlugin(id);
      } catch (thrown) {
        failed.push({ id, why: String(thrown && thrown.message || thrown) });
        continue;
      } finally {
        console.error = error;
      }
      if (!plugins.plugins[id]) {
        const running = (/obsidian\\/([0-9.]+)/i.exec(navigator.userAgent) || [])[1] || "";
        const older = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };
        const tooOld = manifest.minAppVersion && running && older(running, manifest.minAppVersion);
        failed.push({ id, why: "Obsidian did not load it." + (tooOld ? " It asks for Obsidian " + manifest.minAppVersion + " or later, and this is " + running + "." : "") + (said.length > 0 ? " Obsidian said: " + said[said.length - 1].slice(0, 400) : "") });
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

/**
 * Follows the work a command starts, so that the end of it can be told
 * without the command saying so. This is for a command of any plugin: one
 * that knows nothing of the run.
 *
 * Obsidian starts a command and is told nothing more of it: what the
 * command goes on to do, it does on its own. But Obsidian has Node.js in
 * its page, and Node.js knows of all that is started and by what: a promise,
 * the reading and writing of a file, a request to the web, another program.
 * What is started while the command runs is the command's, and so is what
 * that starts in its turn. The command has ended when none of it is left.
 *
 * Node.js does not know of what the browser part of the page does by a
 * timer or before it draws. Those are handed the command they belong to
 * here, and a timer that is still to go off is work that is left.
 *
 * Of the promises and the timers, those count that the code of a plugin
 * makes: a promise by calling a function that is `async`, by waiting in
 * one, by `new Promise` and by `then`. Every wait of a plugin is one of
 * these. What Obsidian makes inside its own functions does not count: some
 * of its promises stay open for as long as Obsidian runs, as the one that
 * waits to hear of a file it has written, and its timers put off what it
 * keeps for itself, as which notes were open. A command would end late, or
 * never. What Obsidian does for the command is followed by what it asks of
 * the system. Nor do the promises count that `Promise.race` and its like
 * make to do their work.
 *
 * What is not followed:
 * - A timer that repeats: that is something a command leaves running.
 * - A timer that is set for more than two seconds, by itself. Where the
 *   command waits for such a timer, the promise it waits with is followed,
 *   and that is enough. Where nothing waits for it, it is something the
 *   command leaves behind, as the timer that takes a notice away.
 * - Work that is started by a way that is none of these, as a message to a
 *   worker with nothing waiting for the answer.
 *
 * A promise that nothing can reach any more is taken away by the browser,
 * and the run asks it to do so (`collectGarbage`): it can never be kept.
 *
 * What Obsidian shows as a notice while the command runs is passed on to
 * the one who watches the run: for a command that knows nothing of the run,
 * that is all it says.
 *
 * This is JavaScript for the page, kept as text. `work` is what the page
 * holds of it: see `Work` below for what it answers.
 */
const followWork = (isTraced: boolean): string => `(() => {
  const isTraced = ${String(isTraced)};
  let hooks;
  try { hooks = require("async_hooks"); } catch (error) { return null; }
  if (!hooks || !hooks.AsyncLocalStorage || !hooks.AsyncResource) return null;
  const mine = new hooks.AsyncLocalStorage();
  const job = {};
  // What Node.js asks of the system and is answered once, and a program it has started. Not what stays
  // open for as long as Obsidian runs, as the watching of a folder.
  // Not what stays for as long as its owner keeps it, whatever is going on: a stream that packs data, a worker.
  const ASKED = /^(FSREQ|FILEHANDLECLOSEREQ|PROCESSWRAP|WRITEWRAP|SHUTDOWNWRAP|GETADDRINFOREQWRAP|GETNAMEINFOREQWRAP|TCPCONNECTWRAP|PIPECONNECTWRAP|HTTPCLIENTREQUEST|RANDOMBYTESREQUEST|PBKDF2REQUEST|SCRYPTREQUEST|SIGNREQUEST|Timeout|Immediate)/;
  // A timer set for longer than this is not waited for by itself: see above
  const LONGEST = 2000;
  const open = new Map();
  // Where each thing that is open was started, when that is asked for
  const where = new Map();
  /**
   * The code that is making a promise right now, from the nearest call
   * outward, without what Node.js runs to tell of it. Asked of the browser
   * as the calls themselves, not as text, which is quick.
   */
  const callers = (above) => {
    const limit = Error.stackTraceLimit;
    const prepare = Error.prepareStackTrace;
    Error.stackTraceLimit = 14;
    Error.prepareStackTrace = (_error, sites) => sites;
    const holder = {};
    Error.captureStackTrace(holder, above);
    const sites = holder.stack;
    Error.stackTraceLimit = limit;
    Error.prepareStackTrace = prepare;
    return Array.isArray(sites) ? sites.filter((site) => !String(site.getFileName() || "").startsWith("node:")) : [];
  };
  /** The file a call is in, by the name its code gives itself where it does: a plugin is \`plugin:\` and its id */
  const fileOf = (site) => (typeof site.getScriptNameOrSourceURL === "function" ? site.getScriptNameOrSourceURL() : null) || site.getFileName() || "";
  /** True for the code of Obsidian itself, which is served from \`app://\`. Its plugins are served from a folder of their own there. */
  const isObsidian = (file) => file.startsWith("app://") && !file.includes("/_plugin/");
  /** True for a promise that the code of a plugin makes: see above */
  const isOfPlugin = (sites) => {
    for (const site of sites) {
      const file = fileOf(site);
      if (file === "") {
        // \`new Promise\` and \`then\` are made by the one who calls them. What else is built in, as \`Promise.race\`, makes promises for itself.
        const name = site.getFunctionName();
        if (site.isConstructor() || name === "then" || name === "catch" || name === "finally") continue;
        return false;
      }
      return !isObsidian(file);
    }
    return false;
  };
  const note = (key, sites) => {
    if (!isTraced) return;
    where.set(key, (sites || callers(note)).slice(0, 3).map((site) => String(site.getFunctionName() || "(anonymous)") + " (" + (fileOf(site) || "built in") + ":" + String(site.getLineNumber() || 0) + ")").join(" < "));
  };
  /** Promises of the command, to know one that failed with nothing to catch it */
  const promises = new WeakSet();
  let moves = 0;
  // What Node.js asks of the system right now, for the command or for anything else in Obsidian: none of
  // it may be going on when a command is said to have ended
  const going = new Set();
  const work = { failed: null, on: false };
  const init = (id, type, trigger, resource) => {
    const isAsked = ASKED.test(type);
    const isTimer = type === "Timeout" || type === "Immediate";
    if (isAsked && !isTimer) going.add(id);
    if (mine.getStore() !== job) return;
    if (type === "PROMISE") {
      // One that fails with nothing to catch it is the command's failure, whoever made it
      if (resource && typeof resource === "object") promises.add(resource);
      const sites = callers(init);
      if (!isOfPlugin(sites)) return;
      open.set(id, "promise");
      note(id, sites);
      moves++;
    } else if (isTimer) {
      // The timers of Node.js, by the same rules as those of the browser: not one that repeats, not one
      // set for long, and only one that the code of a plugin sets. A server a plugin starts keeps a timer
      // that repeats for as long as it lives.
      if (resource && (resource._repeat != null || Number(resource._idleTimeout) > LONGEST)) return;
      const sites = callers(init);
      if (!isOfPlugin(sites)) return;
      open.set(id, "timer");
      note(id, sites);
      moves++;
    } else if (isAsked) {
      open.set(id, "system");
      note(id);
      moves++;
    }
  };
  const hook = hooks.createHook({
    init,
    promiseResolve(id) { if (open.delete(id)) { where.delete(id); moves++; } },
    destroy(id) { going.delete(id); if (open.delete(id)) { where.delete(id); moves++; } },
  });

  // The timers of the browser, and what it calls before it draws: the command they were set by goes with them
  const kept = { setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: window.cancelAnimationFrame, requestIdleCallback: window.requestIdleCallback, cancelIdleCallback: window.cancelIdleCallback };
  const once = (set, clear, kind, isCounted) => {
    const ids = new Map();
    const wrapped = function (callback, ...rest) {
      if (!work.on || mine.getStore() !== job || typeof callback !== "function") return set.call(window, callback, ...rest);
      const key = {};
      const sites = callers(wrapped);
      const counts = isCounted(rest[0]) && isOfPlugin(sites);
      const bound = hooks.AsyncResource.bind(function (...given) {
        ids.delete(id);
        try { return callback.apply(this, given); } finally { if (counts && open.delete(key)) moves++; }
      });
      const id = set.call(window, bound, ...rest);
      ids.set(id, key);
      if (counts) { open.set(key, kind); note(key, sites); moves++; }
      return id;
    };
    const cleared = function (id) {
      const key = ids.get(id);
      if (key !== undefined) { ids.delete(id); if (open.delete(key)) moves++; }
      return clear.call(window, id);
    };
    return [wrapped, cleared];
  };
  const patch = () => {
    [window.setTimeout, window.clearTimeout] = once(kept.setTimeout, kept.clearTimeout, "timer", (delay) => !(Number(delay) > LONGEST));
    [window.requestAnimationFrame, window.cancelAnimationFrame] = once(kept.requestAnimationFrame, kept.cancelAnimationFrame, "frame", () => true);
    if (kept.requestIdleCallback) [window.requestIdleCallback, window.cancelIdleCallback] = once(kept.requestIdleCallback, kept.cancelIdleCallback, "frame", () => true);
  };
  const unpatch = () => { Object.assign(window, kept); };

  // A promise of the command that fails with nothing to catch it: the command has failed, though nobody was told
  const onRejected = (event) => {
    if (work.failed === null && event.promise && promises.has(event.promise)) {
      const reason = event.reason;
      work.failed = reason instanceof Error ? reason.message : String(reason);
    }
  };

  /**
   * Tries, on something small, whether work can be followed in this
   * Obsidian: whether what is started goes on under the name it was started
   * under after a wait, and whether Node.js tells of the promises made
   * there. An Obsidian in which it cannot is not guessed at: the work of a
   * command is then not followed at all, and the run says so.
   */
  work.check = async () => {
    const trial = {};
    let told = 0;
    const listening = hooks.createHook({ init(id, type) { if (type === "PROMISE" && mine.getStore() === trial) told++; } });
    try {
      listening.enable();
      const kept = await mine.run(trial, async () => { await null; return mine.getStore() === trial; });
      return kept === true && told > 0 && mine.getStore() !== trial;
    } catch (error) {
      return false;
    } finally {
      listening.disable();
    }
  };
  /** The timer of the page as it was before: for waiting that is not work of the command */
  work.sleep = (callback, millis) => kept.setTimeout.call(window, callback, millis);
  // The notices of Obsidian, as they are shown and as their words change
  const told = new WeakMap();
  const tell = (notice) => {
    const text = (notice.textContent || "").trim().replace(/\\s*\\n\\s*/g, " / ");
    if (text !== "" && told.get(notice) !== text) {
      told.set(notice, text);
      console.log("[runner] Notice: " + text);
    }
  };
  const notices = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      const changed = target && target.closest ? target.closest(".notice") : null;
      if (changed) tell(changed);
      for (const added of record.addedNodes) {
        if (added.nodeType !== 1) continue;
        if (added.matches(".notice")) tell(added);
        else added.querySelectorAll(".notice").forEach(tell);
      }
    }
  });

  work.start = (run) => {
    work.on = true;
    patch();
    hook.enable();
    window.addEventListener("unhandledrejection", onRejected);
    notices.observe(document.body, { childList: true, subtree: true, characterData: true });
    return mine.run(job, run);
  };
  work.stop = () => {
    if (!work.on) return;
    work.on = false;
    hook.disable();
    unpatch();
    window.removeEventListener("unhandledrejection", onRejected);
    // What was shown last is still told
    for (const record of notices.takeRecords()) { const target = record.target.nodeType === 1 ? record.target : record.target.parentElement; const changed = target && target.closest ? target.closest(".notice") : null; if (changed) tell(changed); }
    notices.disconnect();
  };
  /**
   * Has Node.js say which promises the browser has taken away. It says so
   * when it next has something to do, and with nothing else going on that
   * can be a long time: so it is given something to do.
   */
  work.nudge = () => { try { require("timers").setImmediate(() => undefined); } catch (error) { /* then it is said later */ } };
  /** What is left of the work, by kind, and how often something of it began or ended since the start */
  work.left = () => {
    const kinds = { promise: 0, timer: 0, frame: 0, system: 0 };
    for (const kind of open.values()) kinds[kind]++;
    const started = [];
    if (isTraced) for (const key of open.keys()) { const at = where.get(key); if (at && !started.includes(at) && started.length < 6) started.push(at); }
    return { failed: work.failed, moves, going: going.size, started, ...kinds };
  };
  return work;
})()`;

/** What is left of the work of a command: see `FOLLOW_WORK` */
export interface Work {
  /** What a promise of the command failed with that nothing caught, or null */
  failed: string | null;
  /** How often something of the work began or ended since the command started: the same twice means that nothing went on between */
  moves: number;
  /** What Node.js is asking of the system right now, for the command or for anything else in Obsidian */
  going: number;
  /** Promises of the command that are neither kept nor broken */
  promise: number;
  /** Timers the command has set that are still to go off */
  timer: number;
  /** What the command has asked to be called before the page is drawn next, or when it is idle */
  frame: number;
  /** What the command has asked of the system and has no answer to yet, and programs it has started that still run */
  system: number;
  /** True when the command has said itself that it is done, after all: that is then what counts */
  said: boolean;
  /** Where in the code what is left was started, for a run that asked to be told (`--verbose`): some of the places, each once */
  started: string[];
}

/** Puts `window.obsidianCmdRunner` into the page, fresh for one command */
export async function offerRunner(page: Page, args: Record<string, unknown>, isTraced = false): Promise<void> {
  await page.evaluate(`(async () => {
    const state = { claimed: false, finished: false, ok: false, result: null, error: null };
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    window.__obsidianCmdRunner?.work?.stop();
    let work = ${followWork(isTraced)};
    if (work && !(await work.check())) work = null;
    window.__obsidianCmdRunner = { state, done, work };
    window.obsidianCmdRunner = {
      version: 1,
      args: ${asCode(args)},
      claim() { state.claimed = true; window.__obsidianCmdRunner.work?.stop(); },
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
  /** True when the work the command starts is followed, so that its end can be told without the command saying so */
  followed: boolean;
  /** What the command threw while it was started, or null */
  threw: string | null;
}

/** Starts a command. A command that takes part in the run has a moment to say so. */
export async function startCommand(page: Page, id: string): Promise<Started> {
  return page.evaluate(`(async () => {
    const id = ${asCode(id)};
    const state = window.__obsidianCmdRunner.state;
    const work = window.__obsidianCmdRunner.work;
    if (!app.commands.commands[id]) {
      const plugin = id.split(":")[0] + ":";
      return { found: false, similar: Object.keys(app.commands.commands).filter((known) => known.startsWith(plugin)).sort().slice(0, 30), ran: false, claimed: false, followed: false, threw: null };
    }
    // A command can say that it does not apply now. Obsidian does not pass that on, so it is asked first.
    const command = app.commands.commands[id];
    // As Obsidian takes the answer: a command that gives back nothing does not apply either
    const applies = typeof command.checkCallback !== "function" || Boolean(command.checkCallback(true));
    // The windows that are open before the command: one that is there after it and was not before is the command's
    window.__obsidianCmdRunner.windows = new Set(document.querySelectorAll(".modal-container"));
    let threw = null;
    // Obsidian keeps to itself what a command throws, and says only that the command did not run. So a
    // command that needs nothing of the editor is called here as Obsidian would call it, and what it
    // throws is known. One that works on the note that is open is left to Obsidian, which finds that note.
    const execute = () => {
      try {
        if (typeof command.callback === "function") { command.callback(); return true; }
        if (typeof command.checkCallback === "function") return command.checkCallback(false) !== false;
        return app.commands.executeCommandById(id) !== false;
      } catch (error) {
        threw = error instanceof Error ? error.message : String(error);
        return true;
      }
    };
    // Started as the work that is followed: what the command starts from here on is known to be its own
    const ran = applies && (work ? work.start(execute) : execute());
    // The timer of the page as it was: this wait is not work of the command
    const sleep = (ms) => new Promise((r) => (work ? work.sleep : setTimeout)(r, ms));
    // By the clock, not by how often it was looked: a command that keeps the page busy would make a long wait of it
    for (const until = performance.now() + 300; ran && threw === null && !state.claimed && performance.now() < until; ) await sleep(20);
    return { found: true, similar: [], ran, claimed: state.claimed, followed: Boolean(work), threw };
  })()`);
}

/** A command Obsidian knows, as the list of commands tells of it */
export interface Listed {
  /** What is given to `--command` */
  id: string;
  /** As Obsidian shows it in its list of commands */
  name: string;
  /** The id of the plugin it is of, or null for a command of Obsidian itself */
  plugin: string | null;
  /** True for a command that works on the note that is open: with no note open it does not apply */
  needsNote: boolean;
  /** False for a command that says that it does not apply now, as one that needs a note to be open */
  applies: boolean;
}

/**
 * JavaScript that gives back the commands Obsidian knows: for `--eval`, as
 * the list is asked for.
 *
 * @param all false for the commands of the plugins only, not those of Obsidian itself
 */
export function listCode(all: boolean): string {
  return `
    const plugins = Object.keys(app.plugins.plugins);
    const listed = Object.values(app.commands.commands).map((command) => {
      const owner = command.id.includes(":") ? command.id.slice(0, command.id.indexOf(":")) : "";
      let applies = true;
      // Asked as Obsidian asks before it shows a command: nothing is run by it
      try { applies = typeof command.checkCallback !== "function" || Boolean(command.checkCallback(true)); } catch (error) { applies = false; }
      const needsNote = typeof command.editorCallback === "function" || typeof command.editorCheckCallback === "function";
      return { id: command.id, name: String(command.name || ""), plugin: plugins.includes(owner) ? owner : null, needsNote, applies: applies && !needsNote };
    });
    return listed.filter((one) => ${String(all)} || one.plugin !== null).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  `;
}

/** What is left of the work of the command that runs. Null where the work cannot be followed. */
export async function workLeft(page: Page): Promise<Work | null> {
  return page.evaluate<Work | null>(`(() => { const { work, state } = window.__obsidianCmdRunner; return work ? { ...work.left(), said: state.finished } : null; })()`);
}

/**
 * Takes away the promises that nothing can keep any more, so that they are
 * not counted as work that is left: see `followWork`.
 */
export async function dropUnkept(page: Page): Promise<void> {
  await page.send("HeapProfiler.collectGarbage");
  await page.evaluate(`(() => { window.__obsidianCmdRunner?.work?.nudge(); })()`);
}

/**
 * The window a command has opened and left open, by what it says at its
 * top, or null. A command that asks something in a window and has no work
 * going on is waiting for an answer, and in a run nobody is there to give
 * one: its work was not done.
 */
export async function windowLeftOpen(page: Page): Promise<string | null> {
  return page.evaluate<string | null>(`(() => {
    const before = window.__obsidianCmdRunner.windows;
    if (!before) return null;
    const opened = Array.from(document.querySelectorAll(".modal-container")).find((one) => !before.has(one));
    if (!opened) return null;
    const title = opened.querySelector(".modal-title");
    // As it is read, with its lines apart, where the page says so: the words of a title and of a text do not run together
    const text = ((title && title.textContent) || opened.innerText || opened.textContent || "").trim().replace(/\\s+/g, " ");
    return text.slice(0, 120) || "a window with no words";
  })()`);
}

/** Stops following the work of a command: the page is as it was */
export async function stopFollowing(page: Page): Promise<void> {
  await page.evaluate(`(() => { window.__obsidianCmdRunner?.work?.stop(); })()`);
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
