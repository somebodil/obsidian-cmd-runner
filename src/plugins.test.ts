import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { COMMUNITY_LIST, findCommunityPlugin, parsePlugin, placePlugin, releaseFileUrl, removePlaced } from "./plugins.ts";

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

  it("takes a name with no slash that is no folder for the id of a community plugin, with or without a release", () => {
    assert.deepEqual(parsePlugin("dataview", noFolder), { kind: "community", id: "dataview", tag: null });
    assert.deepEqual(parsePlugin("obsidian-vault-changelog@2.0.0", noFolder), { kind: "community", id: "obsidian-vault-changelog", tag: "2.0.0" });
    assert.deepEqual(parsePlugin("dataview", (path) => path === "dataview"), { kind: "folder", path: "dataview" });
  });

  it("refuses what is none of them", () => {
    assert.throws(() => parsePlugin("a/b/c", noFolder), /is not a plugin/);
    assert.throws(() => parsePlugin("two words", noFolder), /is not a plugin/);
    assert.throws(() => parsePlugin(" ", noFolder), /needs a name/);
  });
});

describe("findCommunityPlugin", () => {
  const list = JSON.stringify([
    { id: "dataview", name: "Dataview", repo: "blacksmithgu/obsidian-dataview" },
    { id: "QuickAdd", name: "QuickAdd", repo: "chhoumann/quickadd" },
    { id: "broken", name: "Broken", repo: "not a repository" },
    { name: "no id" },
  ]);
  const answering = (body: string, status = 200, asked: string[] = []): typeof fetch =>
    ((url: string) => {
      asked.push(String(url));
      return Promise.resolve(new Response(body, { status }));
    }) as unknown as typeof fetch;

  it("finds the repository of an id in the list Obsidian reads", async () => {
    const asked: string[] = [];
    assert.deepEqual(await findCommunityPlugin("dataview", answering(list, 200, asked)), { owner: "blacksmithgu", repo: "obsidian-dataview" });
    assert.deepEqual(asked, [COMMUNITY_LIST]);
  });

  it("finds an id that was written in another case", async () => {
    assert.deepEqual(await findCommunityPlugin("quickadd", answering(list)), { owner: "chhoumann", repo: "quickadd" });
  });

  it("says what to do when the id is not in the list, or the list cannot be read", async () => {
    await assert.rejects(findCommunityPlugin("nowhere", answering(list)), /is not the id of a community plugin.*owner\/repo/);
    await assert.rejects(findCommunityPlugin("broken", answering(list)), /which is not one/);
    await assert.rejects(findCommunityPlugin("dataview", answering("no", 503)), /could not be read \(GitHub answered 503\).*owner\/repo/);
    await assert.rejects(findCommunityPlugin("dataview", answering("{}")), /is not a list/);
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

  it("asks for the files of a release at the same time", async () => {
    const work = await mkdtemp(join(tmpdir(), "ocr-test-"));
    try {
      const files: Record<string, string> = { "manifest.json": JSON.stringify({ id: "from-web" }), "main.js": "x", "styles.css": "a{}" };
      let open = 0;
      let most = 0;
      const slow = (async (url: string) => {
        most = Math.max(most, ++open);
        await new Promise((resolve) => setTimeout(resolve, 20));
        open--;
        return new Response(files[String(url).split("/").pop() ?? ""], { status: 200 });
      }) as unknown as typeof fetch;
      await placePlugin({ kind: "release", owner: "o", repo: "r", tag: null }, join(work, "plugins"), work, slow, null);
      assert.equal(most, 3);
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

  it("fetches a community plugin from the repository the list names, and the release that was asked for", async () => {
    const work = await mkdtemp(join(tmpdir(), "ocr-test-"));
    try {
      const asked: string[] = [];
      const files: Record<string, string> = {
        "community-plugins.json": JSON.stringify([{ id: "from-list", repo: "o/r" }]),
        "manifest.json": JSON.stringify({ id: "from-list" }),
        "main.js": "x",
      };
      const noting = ((url: string) => {
        asked.push(String(url));
        const body = files[String(url).split("/").pop() ?? ""];
        return Promise.resolve(body === undefined ? new Response("no", { status: 404 }) : new Response(body, { status: 200 }));
      }) as unknown as typeof fetch;
      const placed = await placePlugin({ kind: "community", id: "from-list", tag: "1.2.0" }, join(work, "plugins"), work, noting, null);
      assert.equal(placed.id, "from-list");
      assert.equal(placed.placed, true);
      assert.ok(asked.includes("https://github.com/o/r/releases/download/1.2.0/main.js"), asked.join(", "));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("does not ask for the list when the vault has the community plugin already", async () => {
    const work = await mkdtemp(join(tmpdir(), "ocr-test-"));
    try {
      await mkdir(join(work, "plugins", "from-list"), { recursive: true });
      const asked: string[] = [];
      const noting = ((url: string) => {
        asked.push(String(url));
        return Promise.resolve(new Response("no", { status: 404 }));
      }) as unknown as typeof fetch;
      const placed = await placePlugin({ kind: "community", id: "from-list", tag: null }, join(work, "plugins"), work, noting, null);
      assert.equal(placed.placed, false);
      assert.deepEqual(asked, []);
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
