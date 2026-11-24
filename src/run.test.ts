import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULTS, type Options } from "./args.ts";
import { EXIT, fileState, isWritten, run, RunError, whenWritten, within, type Io } from "./run.ts";

const temp = (): Promise<string> => mkdtemp(join(tmpdir(), "ocr-test-"));
const sleep = (millis: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, millis));
/** True of the error a run ends with, when it ends with this number */
const exitIs = (exit: number) => (error: unknown): boolean => error instanceof RunError && error.exit === exit;

describe("within", () => {
  const never = new Promise<never>(() => undefined);
  const running = { ended: () => null };

  it("gives back what the work gives when it is done in time", async () => {
    assert.equal(await within(Promise.resolve(7), 1000, "The command", null, running), 7);
  });

  it("ends a command that takes too long as that, and a start that takes too long as an Obsidian that did not start", async () => {
    await assert.rejects(within(never, 5, 'The command "a:b"', null, running), exitIs(EXIT.timeout));
    await assert.rejects(within(never, 5, 'The command "a:b"', null, running), /The command "a:b" took longer than/);
    await assert.rejects(within(never, 5, "Opening the vault", null, running, EXIT.obsidian), exitIs(EXIT.obsidian));
  });
});

describe("isWritten and whenWritten", () => {
  it("counts a file that is new or was changed, and not one that is as it was or is gone", () => {
    const was = { mtime: 1000, size: 7 };
    assert.equal(isWritten(null, was), true);
    assert.equal(isWritten(was, { mtime: 2000, size: 7 }), true);
    assert.equal(isWritten(was, { mtime: 1000, size: 9 }), true);
    assert.equal(isWritten(was, { mtime: 1000, size: 7 }), false);
    assert.equal(isWritten(was, null), false);
    assert.equal(isWritten(null, null), false);
  });

  it("waits for a file that was there before to be written anew", async () => {
    const work = await temp();
    let waiting = true;
    try {
      const file = join(work, "report.json");
      await writeFile(file, "from an earlier run");
      let done = false;
      const written = whenWritten(file, await fileState(file), () => waiting).then(() => {
        done = true;
      });
      await sleep(250);
      assert.equal(done, false, "the file from before does not count");
      await writeFile(file, "new");
      await written;
    } finally {
      waiting = false;
      await rm(work, { recursive: true, force: true });
    }
  });

  it("waits for a file that was not there to appear", async () => {
    const work = await temp();
    let waiting = true;
    try {
      const file = join(work, "report.json");
      const written = whenWritten(file, await fileState(file), () => waiting);
      await writeFile(file, "new");
      await written;
    } finally {
      waiting = false;
      await rm(work, { recursive: true, force: true });
    }
  });

  it("looks no longer when nobody waits any more", async () => {
    let waiting = true;
    const written = whenWritten(join(tmpdir(), "ocr-test-never-written"), null, () => waiting);
    waiting = false;
    await written;
  });
});

describe("run, up to the start of Obsidian", () => {
  /** A vault with one note, a plugin in a folder, and in place of Obsidian a program that leaves a file when it is started and ends */
  const prepare = async (pluginId: string): Promise<{ work: string; vault: string; plugin: string; options: Options; started: () => boolean }> => {
    const work = await temp();
    const vault = join(work, "vault");
    const plugin = join(work, "plugin");
    await mkdir(vault);
    await writeFile(join(vault, "Note.md"), "x");
    await mkdir(plugin);
    await writeFile(join(plugin, "manifest.json"), JSON.stringify({ id: pluginId }));
    await writeFile(join(plugin, "main.js"), "module.exports = {}");
    const program = join(work, "obsidian");
    await writeFile(program, `#!/bin/sh\n: > "${join(work, "started")}"\n`);
    await chmod(program, 0o755);
    const options = { ...DEFAULTS, vault, obsidianApp: program, plugins: [plugin], commands: ["a:b"] };
    return { work, vault, plugin, options, started: () => existsSync(join(work, "started")) };
  };
  /** Answers with the files of a release, and notes what was asked for */
  const answering = (files: Record<string, string>, asked: string[]): typeof fetch =>
    ((url: string) => {
      asked.push(String(url));
      const body = files[String(url).split("/").pop() ?? ""];
      return Promise.resolve(body === undefined ? new Response("no", { status: 404 }) : new Response(body, { status: 200 }));
    }) as unknown as typeof fetch;
  const io = (fetcher: typeof fetch): Io => ({ say: () => undefined, console: () => undefined, fetch: fetcher, env: {} });
  const site = { "manifest.json": JSON.stringify({ id: "vault-to-site" }), "main.js": "x" };
  const siteManifest = "https://github.com/somebodil/vault-to-site/releases/latest/download/manifest.json";

  it("does not start Obsidian when the run was given up before, and leaves the vault as it was", async () => {
    const { work, vault, options, started } = await prepare("probe");
    try {
      await assert.rejects(run(options, io(answering({}, [])), Promise.resolve()), exitIs(EXIT.stopped));
      assert.equal(started(), false);
      assert.deepEqual(await readdir(vault), ["Note.md"]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("lets go of what it is fetching when the run is given up", async () => {
    const { work, vault, options, started } = await prepare("probe");
    try {
      let giveUp: () => void = () => undefined;
      const stop = new Promise<void>((resolve) => {
        giveUp = resolve;
      });
      // A fetch that does not end by itself: given up as soon as it is asked for
      const hanging = ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const letGo = (): void => reject(new Error("let go"));
          init?.signal?.addEventListener("abort", letGo);
          if (init?.signal?.aborted === true) {
            letGo();
          }
          giveUp();
        })) as unknown as typeof fetch;
      await assert.rejects(run({ ...options, plugins: ["owner/repo"] }, io(hanging), stop), exitIs(EXIT.stopped));
      assert.equal(started(), false);
      assert.deepEqual(await readdir(vault), ["Note.md"]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("fetches the plugin that builds a site when nothing else was asked, also when another plugin is named", async () => {
    const { work, vault, options, started } = await prepare("other");
    try {
      const asked: string[] = [];
      // The program in place of Obsidian ends at once: the run gets as far as starting it
      await assert.rejects(run({ ...options, commands: [] }, io(answering(site, asked))), exitIs(EXIT.obsidian));
      assert.equal(started(), true);
      assert.ok(asked.includes(siteManifest), `asked for: ${asked.join(", ")}`);
      assert.deepEqual(await readdir(vault), ["Note.md"], "both plugins are taken away again");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("does not fetch that plugin when a plugin that was named is it, when the vault has it, or when a command is named", async () => {
    const named = await prepare("vault-to-site");
    const has = await prepare("other");
    const told = await prepare("other");
    try {
      const asked: string[] = [];
      await assert.rejects(run({ ...named.options, commands: [] }, io(answering(site, asked))), exitIs(EXIT.obsidian));
      await mkdir(join(has.vault, ".obsidian", "plugins", "vault-to-site"), { recursive: true });
      await assert.rejects(run({ ...has.options, commands: [] }, io(answering(site, asked))), exitIs(EXIT.obsidian));
      await assert.rejects(run(told.options, io(answering(site, asked))), exitIs(EXIT.obsidian));
      assert.deepEqual(asked, []);
    } finally {
      await Promise.all([named, has, told].map((one) => rm(one.work, { recursive: true, force: true })));
    }
  });
});
