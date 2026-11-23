/**
 * Runs with a real Obsidian: `npm run e2e`.
 *
 * Which Obsidian is said by the environment:
 *   OBSIDIAN_APP      an Obsidian that is installed (nothing is fetched), or
 *   OBSIDIAN_VERSION  a version to fetch (default: latest)
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULTS, type Options } from "../src/args.ts";
import { EXIT, run, RunError, type Io, type RunResult } from "../src/run.ts";

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

  it("does not wait for a command that knows nothing of the run, unless told what to wait for", async () => {
    const quick = await newVault("plain");
    const result = await go(quick, { commands: ["runner-probe:plain"] });
    assert.equal(result.ok, true);
    assert.equal(result.commands[0]?.claimed, false);
    assert.equal(existsSync(join(quick, "probe-plain.txt")), false, "the run ended before the command wrote its file");

    const waited = await newVault("plain-file");
    await go(waited, { commands: ["runner-probe:plain"], wait: "file:probe-plain.txt" });
    assert.equal(await readFile(join(waited, "probe-plain.txt"), "utf8"), "written");
  });

  it("says what is wrong with a command that is not there or does not apply", async () => {
    const vault = await newVault("missing");
    const missing = await go(vault, { commands: ["runner-probe:reprot"] });
    assert.match(missing.commands[0]?.error ?? "", /has no command "runner-probe:reprot".*runner-probe:report/);
    const never = await go(vault, { commands: ["runner-probe:never"] });
    assert.match(never.commands[0]?.error ?? "", /cannot run now/);
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

  it("leaves what it brought when asked to", async () => {
    const vault = await newVault("keep");
    await go(vault, { commands: ["runner-probe:report"], keep: true });
    assert.deepEqual(await readdir(join(vault, ".obsidian", "plugins")), ["runner-probe"]);
  });

  it("refuses what cannot work before it starts Obsidian", async () => {
    await assert.rejects(go(join(work, "nowhere"), { commands: ["a:b"] }), (error: unknown) => error instanceof RunError && error.exit === EXIT.usage);
    await assert.rejects(go(await newVault("bad-plugin"), { plugins: [join(work, "nowhere")], commands: ["a:b"] }), /is not a plugin|has no manifest/);
  });
});
