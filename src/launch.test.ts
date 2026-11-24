import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseScreen, freePort, startArgs } from "./launch.ts";

describe("chooseScreen", () => {
  const none = (): boolean => false;
  const xvfb = (command: string): boolean => command === "Xvfb";

  it("has only the screen of the computer outside Linux", () => {
    assert.equal(chooseScreen("darwin", {}, false, xvfb), "shown");
  });

  it("makes a screen for the run on a server", () => {
    assert.equal(chooseScreen("linux", {}, false, xvfb), "made");
  });

  it("hides the window on a computer with a screen, unless it is to be shown", () => {
    assert.equal(chooseScreen("linux", { DISPLAY: ":0" }, false, xvfb), "made");
    assert.equal(chooseScreen("linux", { DISPLAY: ":0" }, true, xvfb), "shown");
    assert.equal(chooseScreen("linux", { WAYLAND_DISPLAY: "wayland-0" }, false, none), "shown");
  });

  it("does without a screen when none can be made and there is none", () => {
    assert.equal(chooseScreen("linux", {}, false, none), "none");
    assert.equal(chooseScreen("linux", {}, true, none), "none");
  });

  it("takes the one that is chosen by hand", () => {
    assert.equal(chooseScreen("linux", { OBSIDIAN_CMD_RUNNER_SCREEN: "none" }, false, xvfb), "none");
    assert.equal(chooseScreen("linux", { OBSIDIAN_CMD_RUNNER_SCREEN: "sideways" }, false, xvfb), "made");
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
