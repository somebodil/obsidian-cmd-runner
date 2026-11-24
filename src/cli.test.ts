import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listInWords } from "./cli.ts";
import { EXIT } from "./run.ts";

const sleep = (millis: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, millis));

describe("main", () => {
  it("puts the vault back when it is told to stop a second time while it tidies up", { timeout: 120_000 }, async () => {
    const work = await mkdtemp(join(tmpdir(), "ocr-test-"));
    try {
      const vault = join(work, "vault");
      const plugin = join(work, "plugin");
      await mkdir(vault);
      await writeFile(join(vault, "Note.md"), "x");
      await mkdir(plugin);
      await writeFile(join(plugin, "manifest.json"), JSON.stringify({ id: "probe" }));
      await writeFile(join(plugin, "main.js"), "module.exports = {}");
      // In place of Obsidian: a program that says when it is started, and does not end when it is told to.
      // Ending it takes the run a second and a half, in which the second signal arrives.
      const started = join(work, "started");
      const program = join(work, "obsidian");
      await writeFile(program, `#!/bin/sh\ntrap '' TERM\n: > "${started}"\nsleep 20\n`);
      await chmod(program, 0o755);

      // The program as `bin` runs it, from the TypeScript
      const code = `const { main } = await import(${JSON.stringify(new URL("./cli.ts", import.meta.url).href)}); process.exitCode = await main(process.argv.slice(1));`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", code, "--", "--vault", vault, "--obsidian-app", program, "--plugin", plugin, "--command", "probe:any"], { stdio: ["ignore", "ignore", "pipe"] });
      let said = "";
      child.stderr.on("data", (chunk: Buffer) => {
        said += chunk.toString();
      });
      const ended = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.on("exit", (exit, signal) => resolve({ code: exit, signal })));

      while (!existsSync(started) && child.exitCode === null) {
        await sleep(20);
      }
      assert.deepEqual(await readdir(join(vault, ".obsidian", "plugins")), ["probe"], "the plugin is in the vault while the run goes on");
      child.kill("SIGINT");
      await sleep(300);
      child.kill("SIGINT");

      assert.deepEqual(await ended, { code: EXIT.stopped, signal: null }, said);
      assert.match(said, /The run was stopped\./);
      assert.deepEqual(await readdir(vault), ["Note.md"]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("listInWords", () => {
  it("lists the commands by plugin, each with the id that --command takes", () => {
    const text = listInWords([
      { id: "site:build-again", name: "Site: Build again", plugin: "site", needsNote: false, applies: true },
      { id: "app:reload", name: "Reload app without saving", plugin: null, needsNote: false, applies: true },
      { id: "site:build", name: "Site: Build", plugin: "site", needsNote: false, applies: true },
      { id: "lint:lint-file", name: "Lint: Lint the current file", plugin: "lint", needsNote: true, applies: false },
      { id: "lint:undo", name: "Lint: Undo", plugin: "lint", needsNote: false, applies: false },
    ]);
    assert.equal(
      text,
      [
        "Obsidian itself",
        "  app:reload        Reload app without saving",
        "",
        "lint",
        "  lint:lint-file    Lint: Lint the current file  (works on the note that is open)",
        "  lint:undo         Lint: Undo  (does not apply now)",
        "",
        "site",
        "  site:build        Site: Build",
        "  site:build-again  Site: Build again",
        "",
      ].join("\n"),
    );
  });

  it("says what to do when there is nothing to list", () => {
    assert.match(listInWords([]), /Name one with --plugin/);
  });
});
