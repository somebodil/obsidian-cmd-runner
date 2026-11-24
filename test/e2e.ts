/**
 * Runs with a real Obsidian: `npm run e2e`.
 *
 * Which Obsidian is said by the environment:
 *   OBSIDIAN_APP      an Obsidian that is installed (nothing is fetched), or
 *   OBSIDIAN_VERSION  a version to fetch (default: latest)
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULTS, type Options } from "../src/args.ts";
import { EXIT, run, RunError, type Io, type RunResult } from "../src/run.ts";
import { listCode, type Listed } from "../src/session.ts";

const here = dirname(fileURLToPath(import.meta.url));
const probe = join(here, "fixtures", "plugins", "runner-probe");
const wantedVersion = process.env.OBSIDIAN_VERSION ?? "latest";
const said: string[] = [];
const io: Io = { say: (text) => said.push(text), console: (_kind, text) => said.push(text), fetch, env: process.env };

let work = "";
const newVault = async (name: string): Promise<string> => {
  const vault = join(work, name);
  await mkdir(join(vault, "Sub"), { recursive: true });
  await writeFile(join(vault, "Home.md"), "# Home\n\nA link to [[Other]] and [[Sub/Deep]].\n");
  await writeFile(join(vault, "Other.md"), "# Other\n\nBack to [[Home]].\n");
  await writeFile(join(vault, "Sub", "Deep.md"), "# Deep\n\n[[Home]]\n");
  return vault;
};
const options = (vault: string, more: Partial<Options>): Options => ({
  ...DEFAULTS,
  vault,
  plugins: [probe],
  obsidianApp: process.env.OBSIDIAN_APP ?? null,
  obsidianVersion: wantedVersion,
  ...more,
});
const go = (vault: string, more: Partial<Options>): Promise<RunResult> => run(options(vault, more), io);

describe("a run in a real Obsidian", { concurrency: false }, () => {
  before(async () => {
    work = await mkdtemp(join(tmpdir(), "ocr-e2e-"));
  });
  after(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("runs a command that says when it is done, gives it what it was given, and leaves the vault as it was", async () => {
    const vault = await newVault("report");
    const result = await go(vault, { commands: ["runner-probe:report"], args: { greeting: "hello", n: 3 } });
    assert.equal(result.ok, true);
    // For the one who reads the log of a run: where the time of a run goes on this computer
    console.log(`Obsidian ${result.obsidian}, milliseconds: ${Object.entries(result.timings).map(([name, millis]) => `${name} ${String(millis)}`).join(", ")}`);
    assert.equal(result.vault, "report");
    assert.match(result.obsidian, /^\d+\.\d+\.\d+$/);
    if (process.env.OBSIDIAN_APP === undefined && wantedVersion !== "latest") {
      assert.equal(result.obsidian, wantedVersion);
    }
    const [command] = result.commands;
    assert.equal(command?.claimed, true);
    assert.deepEqual(command?.result, { notes: ["Home.md", "Other.md", "Sub/Deep.md"], links: 4, args: { greeting: "hello", n: 3 }, plugins: ["runner-probe"] });
    // What the command wrote stays; what the run brought does not
    assert.deepEqual((await readdir(vault)).sort(), ["Home.md", "Other.md", "Sub", "probe-report.json"]);
    assert.ok(said.includes("3 notes"), "a line of the command reaches the one who watches");
  });

  it("puts the settings of a vault back, and does not touch the plugins the vault has", async () => {
    const vault = await newVault("settings");
    const settings = join(vault, ".obsidian");
    await mkdir(join(settings, "plugins", "vault-own"), { recursive: true });
    await writeFile(join(settings, "workspace.json"), '{"mine": true}');
    await writeFile(join(settings, "app.json"), '{"readableLineLength": false}');
    await writeFile(join(settings, "community-plugins.json"), '["vault-own"]');
    await cp(probe, join(settings, "plugins", "vault-own"), { recursive: true });
    await writeFile(join(settings, "plugins", "vault-own", "manifest.json"), JSON.stringify({ id: "vault-own", name: "Vault own", version: "1.0.0", minAppVersion: "1.0.0", description: "x", author: "x" }));

    const result = await go(vault, { commands: ["runner-probe:report"] });
    assert.deepEqual((result.commands[0]?.result as { plugins: string[] }).plugins, ["runner-probe", "vault-own"]);
    assert.equal(await readFile(join(settings, "workspace.json"), "utf8"), '{"mine": true}');
    assert.equal(await readFile(join(settings, "app.json"), "utf8"), '{"readableLineLength": false}');
    assert.deepEqual((await readdir(settings)).sort(), ["app.json", "community-plugins.json", "plugins", "workspace.json"]);
    assert.deepEqual(await readdir(join(settings, "plugins")), ["vault-own"]);

    const without = await go(vault, { commands: ["runner-probe:report"], vaultPlugins: false });
    assert.deepEqual((without.commands[0]?.result as { plugins: string[] }).plugins, ["runner-probe"]);
  });

  it("says that a command failed, with what the command said", async () => {
    const result = await go(await newVault("fail"), { commands: ["runner-probe:fail", "runner-probe:report"] });
    assert.equal(result.ok, false);
    assert.equal(result.commands.length, 1, "what comes after a failure is not run");
    assert.equal(result.commands[0]?.error, "The probe was asked to fail.");
  });

  it("gives up a command that does not end in time, and still tidies up", async () => {
    const vault = await newVault("hang");
    await assert.rejects(go(vault, { commands: ["runner-probe:hang"], timeout: 2 }), (error: unknown) => error instanceof RunError && error.exit === EXIT.timeout && /took longer than 2 seconds/.test(error.message));
    assert.equal(existsSync(join(vault, ".obsidian")), false);
  });

  it("ends a run that is given up, before Obsidian is started and while a command runs, and still tidies up", async () => {
    const isStopped = (error: unknown): boolean => error instanceof RunError && error.exit === EXIT.stopped;
    const early = await newVault("stop-early");
    await assert.rejects(run(options(early, { commands: ["runner-probe:report"] }), io, Promise.resolve()), isStopped);
    assert.deepEqual((await readdir(early)).sort(), ["Home.md", "Other.md", "Sub"], "the command did not run, and nothing is left");

    const vault = await newVault("stop");
    let giveUp: () => void = () => undefined;
    const stop = new Promise<void>((resolve) => {
      giveUp = resolve;
    });
    // Given up at the moment the command says that it runs
    const watching: Io = { ...io, say: (text) => (text === "hanging" ? giveUp() : io.say(text)) };
    await assert.rejects(run(options(vault, { commands: ["runner-probe:hang"] }), watching, stop), isStopped);
    assert.equal(existsSync(join(vault, ".obsidian")), false);
  });

  it("waits for a command that knows nothing of the run, by its work or by a file, and not when told not to", async () => {
    const quick = await newVault("plain");
    const result = await go(quick, { commands: ["runner-probe:plain"], wait: "none" });
    assert.equal(result.ok, true);
    assert.equal(result.commands[0]?.claimed, false);
    assert.equal(result.commands[0]?.ended, "none");
    assert.equal(existsSync(join(quick, "probe-plain.txt")), false, "the run ended before the command wrote its file");

    // Told nothing, the run follows the work of the command, and ends when the file is written
    const followed = await newVault("plain-work");
    const byWork = await go(followed, { commands: ["runner-probe:plain"] });
    assert.equal(byWork.commands[0]?.ended, "work");
    assert.equal(await readFile(join(followed, "probe-plain.txt"), "utf8"), "written");

    const waited = await newVault("plain-file");
    await go(waited, { commands: ["runner-probe:plain"], wait: "file:probe-plain.txt" });
    assert.equal(await readFile(join(waited, "probe-plain.txt"), "utf8"), "written");

    // In the next run the file is there from before: that does not count, and the run waits until it is written anew
    const before = (await stat(join(waited, "probe-plain.txt"))).mtimeMs;
    await go(waited, { commands: ["runner-probe:plain"], wait: "file:probe-plain.txt" });
    assert.notEqual((await stat(join(waited, "probe-plain.txt"))).mtimeMs, before, "the run ended only after the command wrote its file again");
  });

  it("knows when the work of a command has ended, in whatever way the command does it", async () => {
    const vault = await newVault("quiet");
    // What each command writes last, and the least time its work takes
    const ways: [string, string, number][] = [
      ["quiet-async", "done", 500],
      ["quiet-dropped", "done", 400],
      ["quiet-callbacks", "done", 500],
      ["quiet-program", "done 0 by the program", 600],
      ["quiet-page", "done fetched", 100],
    ];
    const result = await go(vault, { commands: ways.map(([id]) => "runner-probe:" + id) });
    assert.equal(result.ok, true);
    for (const [at, [id, last, least]] of ways.entries()) {
      const one = result.commands[at];
      assert.equal(one?.ended, "work", id);
      assert.equal(one?.claimed, false, id);
      // Each command ran to its end before the next was started, and before Obsidian was ended
      assert.equal(await readFile(join(vault, id + ".txt"), "utf8"), last, id);
      assert.ok((one?.millis ?? 0) >= least, `${id} was waited for: ${String(one?.millis)} ms`);
      assert.ok((one?.millis ?? 0) < least + 2500, `${id} was not waited for much longer than it took: ${String(one?.millis)} ms`);
    }
    console.log(`By their work: ${ways.map(([id], at) => `${id} ${String(result.commands[at]?.millis)} ms`).join(", ")}`);
  });

  it("says that such a command failed, when it throws at once or later with nothing to catch it", async () => {
    const later = await go(await newVault("quiet-rejects"), { commands: ["runner-probe:quiet-rejects", "runner-probe:report"] });
    assert.equal(later.ok, false);
    assert.equal(later.commands.length, 1, "the command after it was not run");
    assert.equal(later.commands[0]?.ended, "work");
    assert.match(later.commands[0]?.error ?? "", /broke after it had started/);

    const atOnce = await go(await newVault("quiet-throws"), { commands: ["runner-probe:quiet-throws"] });
    assert.equal(atOnce.ok, false);
    assert.match(atOnce.commands[0]?.error ?? "", /broke at once/);
  });

  it("is not held back by what a command leaves behind, and passes on what Obsidian shows", async () => {
    const vault = await newVault("quiet-leaves");
    said.length = 0;
    const result = await go(vault, { commands: ["runner-probe:quiet-leaves"] });
    assert.equal(result.ok, true);
    assert.equal(result.commands[0]?.ended, "work");
    assert.equal(await readFile(join(vault, "quiet-leaves.txt"), "utf8"), "done");
    // Not the timer that repeats, not the one set for five minutes, not the notice of eight seconds, not the promise nothing keeps
    assert.ok((result.commands[0]?.millis ?? 0) < 4000, `ended soon: ${String(result.commands[0]?.millis)} ms`);
    assert.ok(said.includes("Notice: The probe leaves things behind."), said.join(" | "));
  });

  it("gives up a command that waits for somebody, and says what was left of its work", async () => {
    const vault = await newVault("quiet-asks");
    await assert.rejects(go(vault, { commands: ["runner-probe:quiet-asks"], timeout: 3 }), (error: unknown) => {
      assert.ok(error instanceof RunError);
      assert.equal(error.exit, EXIT.timeout);
      assert.match(error.message, /took longer than 3 seconds\. Of its work there was left: \d+ promises?\./);
      return true;
    });
    assert.equal(existsSync(join(vault, "quiet-asks.txt")), false);
  });

  it("says that a command was not done when it opens a window and leaves it open", async () => {
    const result = await go(await newVault("quiet-window"), { commands: ["runner-probe:quiet-window", "runner-probe:report"] });
    assert.equal(result.ok, false);
    assert.equal(result.commands.length, 1, "the command after it was not run");
    assert.match(result.commands[0]?.error ?? "", /opened a window and left it open \("Are you sure\?"\)/);
  });

  it("gives a plugin its settings for the run, and puts the settings of the vault's own plugin back", async () => {
    // A plugin that is brought for the run
    const brought = await newVault("settings-brought");
    const given = join(work, "given.json");
    await writeFile(given, JSON.stringify({ greeting: "hello" }));
    assert.equal((await go(brought, { commands: ["runner-probe:settings"], settings: { "runner-probe": given } })).ok, true);
    assert.deepEqual(JSON.parse(await readFile(join(brought, "probe-settings.json"), "utf8")), { greeting: "hello" });

    // A plugin the vault has, with settings of its own
    const own = await newVault("settings-own");
    const folder = join(own, ".obsidian", "plugins", "runner-probe");
    await mkdir(folder, { recursive: true });
    await cp(probe, folder, { recursive: true });
    await writeFile(join(folder, "data.json"), '{"own":true}');
    assert.equal((await go(own, { plugins: [], commands: ["runner-probe:settings"], settings: { "runner-probe": given } })).ok, true);
    assert.deepEqual(JSON.parse(await readFile(join(own, "probe-settings.json"), "utf8")), { greeting: "hello" });
    assert.equal(await readFile(join(folder, "data.json"), "utf8"), '{"own":true}', "the settings of the vault's plugin are as they were");

    // A plugin that is nowhere, and a file that is no JSON, are refused before Obsidian is started
    const usage = (error: unknown): boolean => error instanceof RunError && error.exit === EXIT.usage;
    await assert.rejects(go(brought, { commands: ["runner-probe:settings"], settings: { "no-such-plugin": given } }), usage);
    await writeFile(join(work, "broken.json"), "{");
    await assert.rejects(go(brought, { commands: ["runner-probe:settings"], settings: { "runner-probe": join(work, "broken.json") } }), usage);
  });

  it("runs a file of code before the commands, in one run", async () => {
    const vault = await newVault("code-first");
    const code = join(work, "first.js");
    await writeFile(code, 'await app.vault.adapter.write("first.txt", "by the code"); return "ran";');
    const result = await go(vault, { evalFile: code, commands: ["runner-probe:report"] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.commands.map((one) => one.command), ["eval", "runner-probe:report"]);
    assert.equal(await readFile(join(vault, "first.txt"), "utf8"), "by the code");
  });

  it("says what is wrong with a command that is not there or does not apply", async () => {
    const vault = await newVault("missing");
    const missing = await go(vault, { commands: ["runner-probe:reprot"] });
    assert.match(missing.commands[0]?.error ?? "", /has no command "runner-probe:reprot".*runner-probe:report/);
    const never = await go(vault, { commands: ["runner-probe:never"] });
    assert.match(never.commands[0]?.error ?? "", /cannot run now/);
    // One that gives back nothing when asked does not apply either: Obsidian takes it so
    const silent = await go(vault, { commands: ["runner-probe:silent"] });
    assert.match(silent.commands[0]?.error ?? "", /cannot run now/);
    const noPlugin = await go(vault, { plugins: [], commands: ["nobody:nothing"] });
    assert.match(noPlugin.commands[0]?.error ?? "", /Is its plugin in the vault/);
  });

  it("runs commands in the order given, and a file of code", async () => {
    const vault = await newVault("order");
    const result = await go(vault, { commands: ["runner-probe:report", "runner-probe:report"] });
    assert.deepEqual(result.commands.map((one) => one.ok), [true, true]);

    const code = join(work, "code.js");
    await writeFile(code, 'runner.log("from the code"); return { files: app.vault.getFiles().length, given: runner.args.x };');
    const evaluated = await go(vault, { plugins: [], evalFile: code, args: { x: 7 } });
    assert.deepEqual(evaluated.commands[0]?.result, { files: 4, given: 7 });
    assert.ok(said.includes("from the code"));

    await writeFile(code, 'throw new Error("no good");');
    const thrown = await go(vault, { plugins: [], evalFile: code });
    assert.equal(thrown.ok, false);
    assert.match(thrown.commands[0]?.error ?? "", /no good/);
  });

  it("lists the commands that can be run, with what stands against running one now", async () => {
    const vault = await newVault("list");
    const result = await go(vault, { evalCode: listCode(false) });
    const listed = result.commands[0]?.result as Listed[];
    const probes = listed.filter((one) => one.plugin === "runner-probe");
    assert.ok(probes.length >= 5, JSON.stringify(listed));
    assert.equal(listed.length, probes.length, "only the commands of plugins, when not asked for all");
    assert.deepEqual(probes.find((one) => one.id === "runner-probe:report"), { id: "runner-probe:report", name: "Runner probe: Report", plugin: "runner-probe", needsNote: false, applies: true });
    assert.equal(probes.find((one) => one.id === "runner-probe:never")?.applies, false);
    // Asked for all, the commands of Obsidian itself are there as well
    const all = (await go(vault, { evalCode: listCode(true) })).commands[0]?.result as Listed[];
    assert.ok(all.some((one) => one.plugin === null && one.id.startsWith("app:")), "the commands of Obsidian itself");
    assert.ok(all.length > listed.length);
  });

  it("leaves what it brought when asked to", async () => {
    const vault = await newVault("keep");
    await go(vault, { commands: ["runner-probe:report"], keep: true });
    assert.deepEqual(await readdir(join(vault, ".obsidian", "plugins")), ["runner-probe"]);
  });

  // With the plugin that builds a site, when a built copy of it is at hand: VAULT_TO_SITE=<folder with main.js and manifest.json>
  it("builds a site of the marked notes with the settings it is given, and of the whole vault with none", { skip: process.env.VAULT_TO_SITE === undefined }, async () => {
    const vault = await newVault("site");
    await writeFile(join(vault, "Home.md"), "---\npublish: true\n---\n# Home\n\n[[Other]]\n\n```mermaid\nflowchart LR\n  A --> B\n```\n");
    await writeFile(join(vault, "Other.md"), "# Other\n\nZZNOTMARKED\n");
    const site: Partial<Options> = { plugins: [process.env.VAULT_TO_SITE ?? ""], commands: ["vault-to-site:build"] };
    const result = await go(vault, { ...site, args: { settings: { ticks: { on: [""] }, only: "publish: true", format: "folder", folder: "_site" } } });
    assert.equal(result.ok, true, JSON.stringify(result.commands));
    const built = result.commands[0]?.result as { notes: string[]; keptOut: { notMarked: number }; unfinished: string[] };
    assert.deepEqual(built.notes, ["Home.md"]);
    assert.equal(built.keptOut.notMarked, 2);
    assert.deepEqual(built.unfinished, []);
    assert.ok(existsSync(join(vault, "_site", "index.html")));
    const pages = await readdir(join(vault, "_site", "data", "n"));
    assert.equal(pages.length, 1);
    const page = await readFile(join(vault, "_site", "data", "n", pages[0] ?? ""), "utf8");
    assert.match(page, /class=\\"mermaid[^"]*\\"><svg/, "the diagram is drawn");
    assert.doesNotMatch(page, /ZZNOTMARKED/);
    assert.deepEqual((await readdir(vault)).sort(), ["Home.md", "Other.md", "Sub", "_site"]);

    // Without a word on what goes in, the whole vault does, as the plugin is to begin with: into an archive
    const bare = await newVault("site-bare");
    const whole = await go(bare, site);
    assert.equal(whole.ok, true, JSON.stringify(whole.commands));
    const all = whole.commands[0]?.result as { place: string; notes: string[] };
    assert.equal(all.place, "vault-to-site.zip");
    assert.ok(all.notes.includes("Home.md"), all.notes.join(", "));
    assert.ok(existsSync(join(bare, "vault-to-site.zip")));
  });

  it("refuses what cannot work before it starts Obsidian", async () => {
    await assert.rejects(go(await newVault("nothing"), {}), (error: unknown) => error instanceof RunError && error.exit === EXIT.usage && /Nothing to run/.test(error.message));
    await assert.rejects(go(join(work, "nowhere"), { commands: ["a:b"] }), (error: unknown) => error instanceof RunError && error.exit === EXIT.usage);
    await assert.rejects(go(await newVault("bad-plugin"), { plugins: [join(work, "nowhere")], commands: ["a:b"] }), /is not a plugin|has no manifest/);
  });
});
