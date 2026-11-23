import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

/** A port nothing listens on. Asked of the system, which gives one that is free now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * How Obsidian is started so that nothing of it is seen and it works at full
 * speed all the same.
 *
 * - On Linux without a screen, as on a server, it is given a screen that is
 *   not there: `xvfb-run` when that is installed, else the mode of the
 *   browser inside Obsidian that needs none.
 * - A window that is not looked at is slowed down by the browser: its timers
 *   run once a second. A run would take many times as long, so that is
 *   turned off.
 * - On a server Obsidian often runs as the administrator or in a container,
 *   where the browser's own sandbox cannot be set up. It is turned off on
 *   Linux: what runs is the user's own vault and plugins.
 */
export function startCommand(
  program: string,
  profile: string,
  port: number,
  show: boolean,
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  has: (command: string) => boolean = hasCommand,
): { command: string; args: string[] } {
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${String(port)}`,
    "--remote-allow-origins=*",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--no-first-run",
  ];
  if (platform !== "linux") {
    return { command: program, args };
  }
  args.push("--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage");
  const hasScreen = (env.DISPLAY ?? "") !== "" || (env.WAYLAND_DISPLAY ?? "") !== "";
  if (hasScreen && show) {
    return { command: program, args };
  }
  if (has("xvfb-run")) {
    return { command: "xvfb-run", args: ["--auto-servernum", "--server-args=-screen 0 1440x900x24", program, ...args] };
  }
  if (hasScreen) {
    return { command: program, args };
  }
  return { command: program, args: [...args, "--ozone-platform=headless"] };
}

export function hasCommand(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

export interface Running {
  child: ChildProcess;
  /** What Obsidian wrote while it ran: shown when it ends without being asked to */
  output(): string;
  /** Why it has ended, or null while it runs */
  ended(): string | null;
  stop(): Promise<void>;
}

export function start(command: string, args: string[]): Running {
  // A group of its own, so that the screen that is not there and the helpers of the browser end with it
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
  let said = "";
  let ended: string | null = null;
  const take = (chunk: Buffer): void => {
    said = (said + chunk.toString()).slice(-8000);
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  child.on("error", (error) => {
    ended = `It could not be started: ${error.message}`;
  });
  child.on("exit", (code, signal) => {
    ended = `It ended with ${signal ?? String(code)}.${said.trim() === "" ? "" : " It wrote: " + said.trim().slice(-1500)}`;
  });
  const signal = (name: NodeJS.Signals): void => {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, name);
      } catch {
        // Gone already
      }
    }
  };
  return {
    child,
    output: () => said,
    ended: () => ended,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const hard = setTimeout(() => signal("SIGKILL"), 4000);
        child.once("exit", () => {
          clearTimeout(hard);
          resolve();
        });
        signal("SIGTERM");
      }),
  };
}
