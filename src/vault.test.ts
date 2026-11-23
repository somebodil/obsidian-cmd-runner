import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { keepSettings, restoreSettings, vaultId, vaultList } from "./vault.ts";

const temp = (): Promise<string> => mkdtemp(join(tmpdir(), "ocr-test-"));

describe("vaultId and vaultList", () => {
  it("gives the same folder the same id, and another folder another", () => {
    assert.equal(vaultId("/a/b"), vaultId("/a/b"));
    assert.notEqual(vaultId("/a/b"), vaultId("/a/c"));
    assert.match(vaultId("/a/b"), /^[0-9a-f]{16}$/);
  });

  it("lists one vault, to be opened, and asks for no look for updates", () => {
    assert.deepEqual(JSON.parse(vaultList("/my vault", 5)), { vaults: { [vaultId("/my vault")]: { path: "/my vault", ts: 5, open: true } }, updateDisabled: true });
  });
});

describe("keepSettings and restoreSettings", () => {
  it("puts back what was changed, removes what is new, and leaves the rest", async () => {
    const vault = await temp();
    try {
      const folder = join(vault, ".obsidian");
      await mkdir(join(folder, "plugins", "mine"), { recursive: true });
      await writeFile(join(folder, "workspace.json"), "before");
      await writeFile(join(folder, "app.json"), "same");
      await writeFile(join(folder, "plugins", "mine", "data.json"), "{}");
      const kept = await keepSettings(vault);

      await writeFile(join(folder, "workspace.json"), "after");
      await writeFile(join(folder, "graph.json"), "new");
      await mkdir(join(folder, "plugins", "run-only"));
      await rm(join(folder, "plugins", "run-only"), { recursive: true });
      assert.deepEqual(await restoreSettings(kept), ["graph.json", "workspace.json"]);

      assert.equal(await readFile(join(folder, "workspace.json"), "utf8"), "before");
      assert.equal(await readFile(join(folder, "app.json"), "utf8"), "same");
      assert.deepEqual((await readdir(folder)).sort(), ["app.json", "plugins", "workspace.json"]);
      assert.equal(await readFile(join(folder, "plugins", "mine", "data.json"), "utf8"), "{}");
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it("takes away a settings folder that was not there before, when the run has left nothing in it", async () => {
    const vault = await temp();
    try {
      await writeFile(join(vault, "Note.md"), "x");
      const kept = await keepSettings(vault);
      await mkdir(join(vault, ".obsidian", "plugins"), { recursive: true });
      await writeFile(join(vault, ".obsidian", "app.json"), "{}");
      await restoreSettings(kept);
      assert.deepEqual(await readdir(vault), ["Note.md"]);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it("keeps a folder that still holds something", async () => {
    const vault = await temp();
    try {
      const kept = await keepSettings(vault);
      await mkdir(join(vault, ".obsidian", "plugins", "left"), { recursive: true });
      await restoreSettings(kept);
      assert.deepEqual(await readdir(join(vault, ".obsidian", "plugins")), ["left"]);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});
