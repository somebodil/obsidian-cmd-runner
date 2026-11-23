import { readFileSync } from "node:fs";
import { HELP, parseArgs } from "./args.ts";
import { defaultCacheDir, installObsidian } from "./install.ts";
import { resolveVersion, type Fetch } from "./releases.ts";
import { EXIT, run, RunError, type Io } from "./run.ts";

const VERSION = "0.1.0";

/** The program: reads the command line, does the run, and answers with the number to end with */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, (path) => JSON.parse(readFileSync(path, "utf8")) as unknown);
  const say = (text: string): void => {
    process.stderr.write(text + "\n");
  };
  switch (parsed.kind) {
    case "help":
      process.stdout.write(HELP);
      return EXIT.ok;
    case "version":
      process.stdout.write(VERSION + "\n");
      return EXIT.ok;
    case "error":
      say(parsed.message);
      return EXIT.usage;
    case "resolve-version":
      try {
        process.stdout.write((await resolveVersion(parsed.version, fetch as unknown as Fetch)) + "\n");
        return EXIT.ok;
      } catch (error) {
        say(error instanceof Error ? error.message : String(error));
        return EXIT.usage;
      }
    case "install":
      try {
        const version = await resolveVersion(parsed.options.obsidianVersion, fetch as unknown as Fetch);
        const installed = await installObsidian(version, parsed.options.cacheDir ?? defaultCacheDir(), fetch, say);
        process.stdout.write(installed.program + "\n");
        return EXIT.ok;
      } catch (error) {
        say(error instanceof Error ? error.message : String(error));
        return EXIT.obsidian;
      }
    case "run":
      break;
  }

  const { options } = parsed;
  const io: Io = {
    say,
    fetch,
    env: process.env,
    console: (kind, text) => {
      if (options.verbose) {
        say(`[${kind}] ${text}`);
      }
    },
  };
  let giveUp: () => void = () => undefined;
  const stop = new Promise<void>((resolve) => {
    giveUp = resolve;
  });
  const onSignal = (): void => giveUp();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const result = await run(options, io, stop);
    if (options.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      for (const one of result.commands) {
        say(one.ok ? `Done: ${one.command} (${(one.millis / 1000).toFixed(1)} s)` : `Failed: ${one.command}. ${one.error ?? ""}`);
        if (one.ok && one.result !== null) {
          process.stdout.write((typeof one.result === "string" ? one.result : JSON.stringify(one.result, null, 2)) + "\n");
        }
      }
    }
    if (options.verbose) {
      say("Milliseconds: " + Object.entries(result.timings).map(([name, millis]) => `${name} ${String(millis)}`).join(", "));
    }
    return result.ok ? EXIT.ok : EXIT.failed;
  } catch (error) {
    say(error instanceof Error ? error.message : String(error));
    return error instanceof RunError ? error.exit : EXIT.failed;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
