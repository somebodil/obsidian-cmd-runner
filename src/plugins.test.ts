import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parsePlugin, placePlugin, releaseFileUrl, removePlaced } from "./plugins.ts";

const noFolder = (): boolean => false;

describe("parsePlugin", () => {
  it("reads a repository, with or without a release", () => {
    assert.deepEqual(parsePlugin("somebodil/vault-to-site", noFolder), { kind: "release", owner: "somebodil", repo: "vault-to-site", tag: null });
    assert.deepEqual(parsePlugin("a-b/c.d_e@1.2.3", noFolder), { kind: "release", owner: "a-b", repo: "c.d_e", tag: "1.2.3" });
  });

  it("takes what starts with a dot or a slash, or is a folder that exists, for a folder", () => {
    assert.deepEqual(parsePlugin("./plugins/mine", noFolder), { kind: "folder", path: "./plugins/mine" });
    assert.deepEqual(parsePlugin("/abs/mine", noFolder), { kind: "folder", path: "/abs/mine" });
    assert.deepEqual(parsePlugin("build/plugin", (path) => path === "build/plugin"), { kind: "folder", path: "build/plugin" });
  });

  it("refuses what is neither", () => {
    assert.throws(() => parsePlugin("just-a-name", noFolder), /is not a plugin/);
    assert.throws(() => parsePlugin("a/b/c", noFolder), /is not a plugin/);
    assert.throws(() => parsePlugin(" ", noFolder), /needs a name/);
  });
});

describe("releaseFileUrl", () => {
  it("points at the latest release, or at the one that is named", () => {
    assert.equal(releaseFileUrl({ owner: "o", repo: "r", tag: null }, "main.js"), "https://github.com/o/r/releases/latest/download/main.js");
    assert.equal(releaseFileUrl({ owner: "o", repo: "r", tag: "1.0.0" }, "main.js"), "https://github.com/o/r/releases/download/1.0.0/main.js");
  });
});

describe("placePlugin", () => {
  const answering = (files: Record<string, string>): typeof fetch =>
    ((url: string) => {
      const name = String(url).split("/").pop() ?? "";
      const body = files[name];
      return Promise.resolve(body === undefined ? new Response("no", { status: 404 }) : new Response(body, { status: 200 }));
    }) as unknown as typeof fetch;

  it("puts a plugin from a folder under its id, and takes it away again", async () => {
    const work = await mkdtemp(join(tmpdir(), "ocr-test-"));
    try {
      await mkdir(join(work, "src"));
      await writeFile(join(work, "src", "manifest.json"), JSON.stringify({ id: "my-plugin" }));
      await writeFile(join(work, "src", "main.js"), "module.exports = {}");
      const placed = await placePlugin({ kind: "folder", path: "src" }, join(work, "plugins"), work, answering({}), null);
      assert.equal(placed.id, "my-plugin");
      assert.equal(placed.placed, true);
      assert.deepEqual((await readdir(join(work, "plugins", "my-plugin"))).sort(), ["main.js", "manifest.json"]);
      await removePlaced([placed]);
      assert.deepEqual(await readdir(join(work, "plugins")), []);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("fetches a plugin from its release, with the style sheet when there is one", async () => {
    const work = await mkdtemp(join(tmpdir(), "ocr-test-"));
    try {
      const files = { "manifest.json": JSON.stringify({ id: "from-web" }), "main.js": "x", "styles.css": "a{}" };
      const placed = await placePlugin({ kind: "release", owner: "o", repo: "r", tag: null }, join(work, "plugins"), work, answering(files), null);
      assert.equal(placed.id, "from-web");
      assert.equal(await readFile(join(placed.folder, "styles.css"), "utf8"), "a{}");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("uses the plugin the vault has already, and does not take that one away", async () => {
    const work = await mkdtemp(join(tmpdir(), "ocr-test-"));
    try {
      await mkdir(join(work, "plugins", "from-web"), { recursive: true });
      await writeFile(join(work, "plugins", "from-web", "main.js"), "the user's");
      const files = { "manifest.json": JSON.stringify({ id: "from-web" }), "main.js": "new" };
      const placed = await placePlugin({ kind: "release", owner: "o", repo: "r", tag: null }, join(work, "plugins"), work, answering(files), null);
      assert.equal(placed.placed, false);
      await removePlaced([placed]);
      assert.equal(await readFile(join(work, "plugins", "from-web", "main.js"), "utf8"), "the user's");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("says what is missing", async () => {
    const work = await mkdtemp(join(tmpdir(), "ocr-test-"));
    try {
      await mkdir(join(work, "empty"));
      await assert.rejects(placePlugin({ kind: "folder", path: "empty" }, join(work, "plugins"), work, answering({}), null), /has no manifest\.json/);
      await assert.rejects(placePlugin({ kind: "release", owner: "o", repo: "r", tag: "1.0.0" }, join(work, "plugins"), work, answering({}), null), /has no manifest\.json in its release.*not public/);
      await assert.rejects(
        placePlugin({ kind: "release", owner: "o", repo: "r", tag: null }, join(work, "plugins"), work, answering({ "manifest.json": "{}", "main.js": "x" }), null),
        /has no id/,
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
