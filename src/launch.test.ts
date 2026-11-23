import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { freePort, startCommand } from "./launch.ts";

describe("startCommand", () => {
  const none = (): boolean => false;
  const xvfb = (command: string): boolean => command === "xvfb-run";

  it("starts the program with a profile of its own and a port to talk to", () => {
    const { command, args } = startCommand("/apps/Obsidian", "/tmp/p", 9001, false, "darwin", {}, none);
    assert.equal(command, "/apps/Obsidian");
    assert.ok(args.includes("--user-data-dir=/tmp/p"));
    assert.ok(args.includes("--remote-debugging-port=9001"));
    assert.ok(args.includes("--disable-background-timer-throttling"));
    assert.ok(!args.includes("--no-sandbox"));
  });

  it("gives Obsidian a screen that is not there on a server", () => {
    const { command, args } = startCommand("/opt/obsidian", "/tmp/p", 9001, false, "linux", {}, xvfb);
    assert.equal(command, "xvfb-run");
    assert.ok(args.includes("/opt/obsidian"));
    assert.ok(args.includes("--no-sandbox"));
  });

  it("hides the window on a computer with a screen, unless it is to be shown", () => {
    assert.equal(startCommand("/opt/obsidian", "/tmp/p", 9001, false, "linux", { DISPLAY: ":0" }, xvfb).command, "xvfb-run");
    assert.equal(startCommand("/opt/obsidian", "/tmp/p", 9001, true, "linux", { DISPLAY: ":0" }, xvfb).command, "/opt/obsidian");
  });

  it("asks the browser inside Obsidian to do without a screen when nothing else gives one", () => {
    const { command, args } = startCommand("/opt/obsidian", "/tmp/p", 9001, false, "linux", {}, none);
    assert.equal(command, "/opt/obsidian");
    assert.ok(args.includes("--ozone-platform=headless"));
  });
});

describe("freePort", () => {
  it("gives a port", async () => {
    const port = await freePort();
    assert.ok(port > 1024 && port < 65536);
  });
});
