import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assetNames, findAsset, normalVersion, resolveVersion, type Fetch } from "./releases.ts";

const answering = (answers: Record<string, { status: number; location?: string }>, asked: string[] = []): Fetch => {
  return (url) => {
    asked.push(url);
    const answer = answers[url] ?? { status: 404 };
    return Promise.resolve({ ok: answer.status >= 200 && answer.status < 300, status: answer.status, headers: { get: (name) => (name === "location" ? (answer.location ?? null) : null) } });
  };
};

describe("normalVersion", () => {
  it("reads a version with or without the letter before it", () => {
    assert.equal(normalVersion("1.15.1"), "1.15.1");
    assert.equal(normalVersion(" v1.4.16 "), "1.4.16");
  });

  it("is null for anything else", () => {
    for (const text of ["latest", "1.15", "1.15.1-beta", "", "v", "1.15.1.2"]) {
      assert.equal(normalVersion(text), null, text);
    }
  });
});

describe("resolveVersion", () => {
  it("takes the version that is asked for, and asks nobody", async () => {
    const asked: string[] = [];
    assert.equal(await resolveVersion("v1.14.5", answering({}, asked)), "1.14.5");
    assert.deepEqual(asked, []);
  });

  it("reads the newest version from where GitHub sends a request for the latest release", async () => {
    const fetcher = answering({ "https://github.com/obsidianmd/obsidian-releases/releases/latest": { status: 302, location: "https://github.com/obsidianmd/obsidian-releases/releases/tag/v1.15.1" } });
    assert.equal(await resolveVersion("latest", fetcher), "1.15.1");
    assert.equal(await resolveVersion(" Latest ", fetcher), "1.15.1");
  });

  it("says so when the newest version cannot be found, or what is asked for is no version", async () => {
    await assert.rejects(resolveVersion("latest", answering({})), /could not be found \(GitHub answered 404\)/);
    await assert.rejects(resolveVersion("newest", answering({})), /is not a version of Obsidian/);
  });
});

describe("assetNames and findAsset", () => {
  it("names the file for each kind of computer", () => {
    assert.deepEqual(assetNames("1.15.1", "linux", "x64"), ["obsidian-1.15.1.tar.gz"]);
    assert.deepEqual(assetNames("1.15.1", "linux", "arm64"), ["obsidian-1.15.1-arm64.tar.gz"]);
    assert.deepEqual(assetNames("1.15.1", "darwin", "arm64"), ["Obsidian-1.15.1.dmg", "Obsidian-1.15.1-universal.dmg"]);
    assert.throws(() => assetNames("1.15.1", "win32", "x64"), /cannot be fetched for this kind of computer yet/);
  });

  it("takes the first name that is published", async () => {
    const base = "https://github.com/obsidianmd/obsidian-releases/releases/download/v1.4.16/";
    const found = await findAsset("1.4.16", "darwin", "x64", answering({ [base + "Obsidian-1.4.16-universal.dmg"]: { status: 200 } }));
    assert.deepEqual(found, { name: "Obsidian-1.4.16-universal.dmg", url: base + "Obsidian-1.4.16-universal.dmg" });
  });

  it("says so when the version is not published", async () => {
    await assert.rejects(findAsset("9.9.9", "linux", "x64", answering({})), /Obsidian 9\.9\.9 is not published/);
  });
});
