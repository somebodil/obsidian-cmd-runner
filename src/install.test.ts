import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { defaultCacheDir, programIn, programOfApp, resolveVersionKept } from "./install.ts";
import type { Fetch } from "./releases.ts";

describe("where things are", () => {
  it("keeps Obsidian in one folder of the home folder, or where it is told", () => {
    assert.equal(defaultCacheDir({ HOME: "/home/me" }), join("/home/me", ".obsidian-cmd"));
    // The same on every kind of computer: where the system keeps its caches does not count
    assert.equal(defaultCacheDir({ HOME: "/home/me", XDG_CACHE_HOME: "/x" }), join("/home/me", ".obsidian-cmd"));
    // With no HOME, as on Windows: the home folder the system names
    assert.equal(defaultCacheDir({}), join(homedir(), ".obsidian-cmd"));
    assert.equal(defaultCacheDir({ HOME: "" }), join(homedir(), ".obsidian-cmd"));
    assert.equal(defaultCacheDir({ OBSIDIAN_CMD_RUNNER_CACHE: "/mine", HOME: "/home/me" }), "/mine");
    assert.equal(defaultCacheDir({ OBSIDIAN_CMD_RUNNER_CACHE: "", HOME: "/home/me" }), join("/home/me", ".obsidian-cmd"));
  });

  it("finds the program in what was unpacked, and in an app that is installed", () => {
    assert.equal(programIn("/c/o", "linux"), "/c/o/obsidian");
    assert.equal(programIn("/c/o", "darwin"), "/c/o/Obsidian.app/Contents/MacOS/Obsidian");
    assert.equal(programOfApp("/Applications/Obsidian.app/", "darwin"), "/Applications/Obsidian.app/Contents/MacOS/Obsidian");
    assert.equal(programOfApp("/opt/obsidian/obsidian", "linux"), "/opt/obsidian/obsidian");
  });
});

describe("resolveVersionKept", () => {
  const latestIs = (version: string, asked: { times: number }): Fetch => () => {
    asked.times++;
    return Promise.resolve({ ok: false, status: 302, headers: { get: () => `https://github.com/obsidianmd/obsidian-releases/releases/tag/v${version}` } });
  };

  it("asks which version is the newest once, and takes that for ten minutes", async () => {
    const cache = await mkdtemp(join(tmpdir(), "ocr-test-"));
    try {
      const asked = { times: 0 };
      assert.equal(await resolveVersionKept("latest", cache, latestIs("1.15.1", asked), 1_000_000), "1.15.1");
      assert.equal(await resolveVersionKept("latest", cache, latestIs("1.16.0", asked), 1_000_000 + 9 * 60 * 1000), "1.15.1");
      assert.equal(asked.times, 1);
      assert.equal(await resolveVersionKept("latest", cache, latestIs("1.16.0", asked), 1_000_000 + 11 * 60 * 1000), "1.16.0");
      assert.equal(asked.times, 2);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });

  it("takes a version that is named as it is, whatever was found before", async () => {
    const cache = await mkdtemp(join(tmpdir(), "ocr-test-"));
    try {
      const asked = { times: 0 };
      await resolveVersionKept("latest", cache, latestIs("1.15.1", asked), 5);
      assert.equal(await resolveVersionKept("1.14.5", cache, latestIs("1.15.1", asked), 6), "1.14.5");
      assert.equal(asked.times, 1);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
});
