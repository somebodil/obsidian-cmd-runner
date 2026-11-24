import { readFileSync } from "node:fs";
import { HELP, parseArgs } from "./args.ts";
import { defaultCacheDir, installObsidian } from "./install.ts";
import { resolveVersion, type Fetch } from "./releases.ts";
import { EXIT, run, RunError, type Io } from "./run.ts";
import { listCode, type Listed } from "./session.ts";

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
    case "commands":
    case "run":
      break;
  }

  // The list of commands is asked of Obsidian in a run like any other: the plugins are put in and turned on first
  const options = parsed.kind === "commands" ? { ...parsed.options, evalCode: listCode(parsed.all) } : parsed.options;
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
  // Heard until the run is over, and not once: a second Ctrl+C would otherwise end the program while the vault is being put back
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const result = await run(options, io, stop);
    if (parsed.kind === "commands" && result.ok) {
      const listed = (result.commands[0]?.result ?? []) as Listed[];
      process.stdout.write(options.json ? JSON.stringify(listed, null, 2) + "\n" : listInWords(listed));
      return EXIT.ok;
    }
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

/**
 * The commands that can be run, for a person to read: by plugin, each with
 * its id, which is what `--command` takes, and its name in Obsidian.
 */
export function listInWords(listed: readonly Listed[]): string {
  if (listed.length === 0) {
    return "No plugin with a command is on in this vault. Name one with --plugin, or list the commands of Obsidian itself with --all.\n";
  }
  const widest = Math.max(...listed.map((one) => one.id.length));
  const lines: string[] = [];
  let group: string | null | undefined;
  for (const one of [...listed].sort((a, b) => (a.plugin ?? "").localeCompare(b.plugin ?? "") || a.id.localeCompare(b.id))) {
    if (one.plugin !== group) {
      group = one.plugin;
      lines.push(...(lines.length > 0 ? [""] : []), one.plugin ?? "Obsidian itself");
    }
    const note = one.needsNote ? "  (works on the note that is open)" : one.applies ? "" : "  (does not apply now)";
    lines.push(`  ${one.id.padEnd(widest)}  ${one.name}${note}`);
  }
  return lines.join("\n") + "\n";
}
