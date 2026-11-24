import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseScreen, freePort, startArgs } from "./launch.ts";

describe("chooseScreen", () => {
  it("has only the screen of the computer outside Linux", () => {
    assert.equal(chooseScreen("darwin", {}, false), "shown");
  });

  it("uses no screen on Linux, on a server and on a computer with a screen alike", () => {
    assert.equal(chooseScreen("linux", {}, false), "none");
    assert.equal(chooseScreen("linux", { DISPLAY: ":0" }, false), "none");
    assert.equal(chooseScreen("linux", {}, true), "none");
  });

  it("shows the window on a computer with a screen when asked to", () => {
    assert.equal(chooseScreen("linux", { DISPLAY: ":0" }, true), "shown");
    assert.equal(chooseScreen("linux", { WAYLAND_DISPLAY: "wayland-0" }, true), "shown");
  });

  it("takes the one that is chosen by hand", () => {
    assert.equal(chooseScreen("linux", { OBSIDIAN_CMD_RUNNER_SCREEN: "made" }, false), "made");
    assert.equal(chooseScreen("linux", { OBSIDIAN_CMD_RUNNER_SCREEN: "sideways" }, false), "none");
  });
});

describe("startArgs", () => {
  it("gives Obsidian a profile of its own and a port to talk to, and keeps it at full speed", () => {
    const args = startArgs("/tmp/p", 9001, "shown", "darwin");
    assert.ok(args.includes("--user-data-dir=/tmp/p"));
    assert.ok(args.includes("--remote-debugging-port=9001"));
    assert.ok(args.includes("--disable-background-timer-throttling"));
    assert.ok(!args.includes("--no-sandbox"));
  });

  it("turns the sandbox of the browser off on Linux, and asks for no screen only when there is to be none", () => {
    assert.ok(startArgs("/tmp/p", 9001, "made", "linux").includes("--no-sandbox"));
    assert.ok(!startArgs("/tmp/p", 9001, "made", "linux").includes("--ozone-platform=headless"));
    assert.ok(startArgs("/tmp/p", 9001, "none", "linux").includes("--ozone-platform=headless"));
  });
});

describe("freePort", () => {
  it("gives a port", async () => {
    const port = await freePort();
    assert.ok(port > 1024 && port < 65536);
  });
});
