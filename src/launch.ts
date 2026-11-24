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

/** How Obsidian gets a screen to draw on */
export type Screen =
  /** The screen of the computer: the window is seen */
  | "shown"
  /** A screen that is not there, made for the run (Xvfb) */
  | "made"
  /** No screen at all: the browser inside Obsidian draws into nothing */
  | "none";

/**
 * Which screen a run uses. Outside Linux there is only the screen of the
 * computer. On Linux the window is hidden unless it is to be shown: on a
 * screen made for the run when the program for that is installed, as it is
 * on the build servers of GitHub, and else with no screen at all.
 *
 * @param forced `OBSIDIAN_CMD_RUNNER_SCREEN`, to choose one of them by hand
 */
export function chooseScreen(platform: string, env: NodeJS.ProcessEnv, show: boolean, has: (command: string) => boolean = hasCommand): Screen {
  if (platform !== "linux") {
    return "shown";
  }
  const forced = env.OBSIDIAN_CMD_RUNNER_SCREEN;
  if (forced === "shown" || forced === "made" || forced === "none") {
    return forced;
  }
  const hasScreen = (env.DISPLAY ?? "") !== "" || (env.WAYLAND_DISPLAY ?? "") !== "";
  if (show && hasScreen) {
    return "shown";
  }
  return has("Xvfb") ? "made" : hasScreen ? "shown" : "none";
}

/**
 * The words Obsidian is started with, so that it works at full speed without
 * being looked at.
 *
 * - A window that is not looked at is slowed down by the browser: its timers
 *   run once a second. A run would take many times as long, so that is
 *   turned off.
 * - On a server Obsidian often runs as the administrator or in a container,
 *   where the browser's own sandbox cannot be set up. It is turned off on
 *   Linux: what runs is the user's own vault and plugins.
 */
export function startArgs(profile: string, port: number, screen: Screen, platform: string = process.platform): string[] {
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${String(port)}`,
    "--remote-allow-origins=*",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--no-first-run",
  ];
  if (platform === "linux") {
    args.push("--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage");
    if (screen === "none") {
      args.push("--ozone-platform=headless");
    }
  }
  return args;
}

export function hasCommand(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

/**
 * Makes a screen that is not there, and says its name as soon as it is
 * ready. Started here and not through `xvfb-run`, which waits three seconds
 * every time whether the screen is ready or not.
 */
export function makeScreen(within = 10_000): Promise<{ display: string; stop(): void }> {
  return new Promise((resolve, reject) => {
    // The screen writes its number to the fourth channel when it listens: any number that is free
    const child = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1440x900x24", "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    let said = "";
    const late = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("The screen for the run (Xvfb) did not start."));
    }, within);
    child.on("error", (error) => {
      clearTimeout(late);
      reject(new Error(`The screen for the run (Xvfb) could not be started: ${error.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(late);
      reject(new Error(`The screen for the run (Xvfb) ended with ${String(code)}.`));
    });
    (child.stdio[3] as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      said += chunk.toString();
      if (said.includes("\n")) {
        clearTimeout(late);
        resolve({ display: `:${said.trim()}`, stop: () => void child.kill("SIGTERM") });
      }
    });
  });
}

export interface Running {
  child: ChildProcess;
  /** What Obsidian wrote while it ran: shown when it ends without being asked to */
  output(): string;
  /** Why it has ended, or null while it runs */
  ended(): string | null;
  /** @param ask a way to ask it to end that is tried before the program is told to */
  stop(ask?: () => void): Promise<void>;
}

export function start(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Running {
  // A group of its own, so that the helpers of the browser end with it
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, env });
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
    stop: (ask) =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        // First the way it is asked to, then the way every program is asked to, then without asking. On
        // Linux, Obsidian does not end soon when it is only told to: the profile of a run is thrown away
        // anyway, and what a command has written is written.
        const timers = [setTimeout(() => signal("SIGTERM"), ask === undefined ? 0 : 1000), setTimeout(() => signal("SIGKILL"), ask === undefined ? 1500 : 2500)];
        child.once("exit", () => {
          timers.forEach(clearTimeout);
          resolve();
        });
        ask?.();
      }),
  };
}
