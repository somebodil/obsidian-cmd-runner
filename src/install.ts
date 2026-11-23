import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { findAsset, type Fetch } from "./releases.ts";

/** Where Obsidian is kept between runs */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (env.OBSIDIAN_CMD_RUNNER_CACHE !== undefined && env.OBSIDIAN_CMD_RUNNER_CACHE !== "") {
    return env.OBSIDIAN_CMD_RUNNER_CACHE;
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Caches", "obsidian-cmd-runner");
  }
  return join(env.XDG_CACHE_HOME !== undefined && env.XDG_CACHE_HOME !== "" ? env.XDG_CACHE_HOME : join(homedir(), ".cache"), "obsidian-cmd-runner");
}

/** The program inside a folder that holds an unpacked Obsidian */
export function programIn(folder: string, platform: string = process.platform): string {
  return platform === "darwin" ? join(folder, "Obsidian.app", "Contents", "MacOS", "Obsidian") : join(folder, "obsidian");
}

/** The program of an Obsidian that is installed: on macOS the app is a folder, and the program is inside it */
export function programOfApp(path: string, platform: string = process.platform): string {
  return platform === "darwin" && path.replace(/\/+$/, "").endsWith(".app") ? join(path, "Contents", "MacOS", "Obsidian") : path;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let said = "";
    child.stderr.on("data", (chunk: Buffer) => {
      said += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ended with ${String(code)}: ${said.trim().slice(-400)}`));
      }
    });
  });
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

export interface Installed {
  version: string;
  /** The program to start */
  program: string;
  /** True when it was there already and nothing was fetched */
  fromCache: boolean;
}

/**
 * Makes sure a version of Obsidian is on this computer, and says where its
 * program is. A version that was fetched before is used again.
 *
 * It is unpacked next to its place and moved there when it is whole: a run
 * that is broken off leaves nothing that looks ready, and two runs at the
 * same time do not write into the same folder.
 */
export async function installObsidian(
  version: string,
  cacheDir: string,
  fetcher: typeof fetch,
  say: (text: string) => void,
  platform: string = process.platform,
  arch: string = process.arch,
): Promise<Installed> {
  const folder = join(cacheDir, `obsidian-${version}-${platform}-${arch}`);
  const program = programIn(folder, platform);
  if (await exists(program)) {
    return { version, program, fromCache: true };
  }
  const asset = await findAsset(version, platform, arch, fetcher as unknown as Fetch);
  await mkdir(cacheDir, { recursive: true });
  const work = await mkdtemp(join(cacheDir, `.fetch-${version}-`));
  try {
    const file = join(work, asset.name);
    say(`Fetching Obsidian ${version} (${asset.name})`);
    const reply = await fetcher(asset.url, { redirect: "follow" });
    if (!reply.ok || reply.body === null) {
      throw new Error(`Obsidian ${version} could not be fetched: ${asset.url} answered ${String(reply.status)}.`);
    }
    await pipeline(Readable.fromWeb(reply.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(file));
    const expected = Number(reply.headers.get("content-length") ?? "0");
    const got = (await stat(file)).size;
    if (expected > 0 && got !== expected) {
      throw new Error(`Obsidian ${version} was not fetched whole: ${String(got)} of ${String(expected)} bytes.`);
    }

    const unpacked = join(work, "unpacked");
    await mkdir(unpacked);
    if (asset.name.endsWith(".tar.gz")) {
      // The archive holds one folder with the program in it
      await run("tar", ["-xzf", file, "-C", unpacked, "--strip-components=1"]);
    } else {
      const mount = join(work, "mount");
      await mkdir(mount);
      await run("hdiutil", ["attach", file, "-nobrowse", "-readonly", "-noverify", "-noautoopen", "-mountpoint", mount]);
      try {
        const app = (await readdir(mount)).find((name) => name.endsWith(".app"));
        if (app === undefined) {
          throw new Error(`"${asset.name}" holds no app.`);
        }
        await run("ditto", [join(mount, app), join(unpacked, "Obsidian.app")]);
      } finally {
        await run("hdiutil", ["detach", mount, "-force"]).catch(() => undefined);
      }
    }
    if (!(await exists(programIn(unpacked, platform)))) {
      throw new Error(`"${asset.name}" was unpacked, but the program of Obsidian is not in it.`);
    }
    await writeFile(join(unpacked, ".obsidian-cmd-runner"), JSON.stringify({ version, from: asset.url }) + "\n");
    try {
      await rename(unpacked, folder);
    } catch (error) {
      // Another run has put it there in the meantime: that one is as good
      if (!(await exists(program))) {
        throw error;
      }
    }
    return { version, program, fromCache: false };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** A folder of its own for the things of one run, removed by the caller */
export function workDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "obsidian-cmd-runner-"));
}
