import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULTS, parseArgs } from "./args.ts";

const run = (argv: string[], readJson?: (path: string) => unknown) => {
  const parsed = parseArgs(argv, readJson);
  assert.equal(parsed.kind, "run", JSON.stringify(parsed));
  return parsed.kind === "run" ? parsed.options : DEFAULTS;
};

describe("parseArgs", () => {
  it("takes the latest Obsidian and the folder you are in when nothing is said", () => {
    assert.deepEqual(run([]), DEFAULTS);
  });

  it("reads a value after a flag and after an equals sign", () => {
    const options = run(["--vault", "notes", "--obsidian-version=1.14.5", "--timeout", "30"]);
    assert.equal(options.vault, "notes");
    assert.equal(options.obsidianVersion, "1.14.5");
    assert.equal(options.timeout, 30);
  });

  it("takes the longest time a timer can be set for", () => {
    assert.equal(run(["--timeout", "2147483"]).timeout, 2_147_483);
  });

  it("collects plugins and commands in the order given", () => {
    const options = run(["--plugin", "a/b@1.0.0", "--plugin=./local", "--command", "x:one", "--command", "x:two"]);
    assert.deepEqual(options.plugins, ["a/b@1.0.0", "./local"]);
    assert.deepEqual(options.commands, ["x:one", "x:two"]);
  });

  it("reads what a command is given as JSON where it is JSON, and as text where it is not", () => {
    const options = run(["--arg", "n=3", "--arg", "on=true", "--arg", "name=My site", "--arg", 'list=["a","b"]', "--arg", "url=a=b"]);
    assert.deepEqual(options.args, { n: 3, on: true, name: "My site", list: ["a", "b"], url: "a=b" });
  });

  it("takes what a command is given from a file, and lets a later --arg win", () => {
    const options = run(["--args-file", "args.json", "--arg", "b=2"], () => ({ a: 1, b: 1 }));
    assert.deepEqual(options.args, { a: 1, b: 2 });
  });

  it("knows the other things it can do", () => {
    assert.deepEqual(parseArgs(["resolve-version"]), { kind: "resolve-version", version: "latest" });
    assert.deepEqual(parseArgs(["resolve-version", "1.14.5"]), { kind: "resolve-version", version: "1.14.5" });
    assert.equal(parseArgs(["install", "--obsidian-version", "1.14.5"]).kind, "install");
    assert.equal(parseArgs(["--help"]).kind, "help");
    assert.equal(parseArgs(["--version"]).kind, "version");
  });

  it("says what is wrong instead of guessing", () => {
    const message = (argv: string[], readJson?: (path: string) => unknown): string => {
      const parsed = parseArgs(argv, readJson);
      return parsed.kind === "error" ? parsed.message : "no error";
    };
    assert.match(message(["--vault"]), /needs a value/);
    assert.match(message(["--nope"]), /is not an option/);
    assert.match(message(["--arg", "novalue"]), /key=value/);
    assert.match(message(["--timeout", "soon"]), /number of seconds/);
    assert.match(message(["--timeout", "2147484"]), /2147483 seconds \(about 24 days\) at most/);
    assert.match(message(["--wait", "maybe"]), /auto, none, or file/);
    assert.match(message(["--command", "a:b", "--eval", "x.js"]), /not both/);
    assert.match(message(["--args-file", "x.json"], () => [1, 2]), /has to hold an object/);
    assert.match(
      message(["--args-file", "x.json"], () => {
        throw new Error("no such file");
      }),
      /could not be read as JSON: no such file/,
    );
  });
});
