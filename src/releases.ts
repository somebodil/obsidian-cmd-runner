/**
 * The versions of Obsidian and the files they come as. Obsidian publishes
 * every version on GitHub, with a file for each kind of computer. Nothing of
 * Obsidian is part of this package: what is run is fetched from there.
 */

export const RELEASES = "https://github.com/obsidianmd/obsidian-releases/releases";

export type Fetch = (url: string, init?: { method?: string; redirect?: "manual" | "follow"; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
}>;

/** `1.15.1` from `1.15.1` or `v1.15.1`. Null for what is not a version. */
export function normalVersion(text: string): string | null {
  const found = /^v?(\d+\.\d+\.\d+)$/.exec(text.trim());
  return found?.[1] ?? null;
}

/**
 * The version to use: the one asked for, or the newest one that is published.
 * The newest is read from where GitHub sends a request for the latest
 * release, which takes one small request and no account.
 */
export async function resolveVersion(wanted: string, fetcher: Fetch): Promise<string> {
  if (wanted.trim().toLowerCase() !== "latest") {
    const version = normalVersion(wanted);
    if (version === null) {
      throw new Error(`"${wanted}" is not a version of Obsidian. Write it as 1.15.1, or latest.`);
    }
    return version;
  }
  const reply = await fetcher(`${RELEASES}/latest`, { method: "HEAD", redirect: "manual" });
  const version = normalVersion((reply.headers.get("location") ?? "").split("/").pop() ?? "");
  if (version === null) {
    throw new Error(`The newest version of Obsidian could not be found (GitHub answered ${String(reply.status)}). Name a version with --obsidian-version.`);
  }
  return version;
}

/**
 * The names the file of a version can have, most likely first. The name for
 * macOS has changed over the years, so more than one is tried.
 */
export function assetNames(version: string, platform: string, arch: string): string[] {
  if (platform === "linux") {
    if (arch === "arm64") {
      return [`obsidian-${version}-arm64.tar.gz`];
    }
    if (arch === "x64") {
      return [`obsidian-${version}.tar.gz`];
    }
  }
  if (platform === "darwin") {
    return [`Obsidian-${version}.dmg`, `Obsidian-${version}-universal.dmg`];
  }
  throw new Error(`Obsidian cannot be fetched for this kind of computer yet (${platform}, ${arch}). Use --obsidian-app with an Obsidian that is installed.`);
}

export function assetUrl(version: string, name: string): string {
  return `${RELEASES}/download/v${version}/${name}`;
}

/** The file of a version that is there: the first of its possible names that GitHub has */
export async function findAsset(version: string, platform: string, arch: string, fetcher: Fetch): Promise<{ name: string; url: string }> {
  for (const name of assetNames(version, platform, arch)) {
    const url = assetUrl(version, name);
    const reply = await fetcher(url, { method: "HEAD", redirect: "follow" });
    if (reply.ok) {
      return { name, url };
    }
  }
  throw new Error(`Obsidian ${version} is not published for this kind of computer (${platform}, ${arch}), or there is no such version. See ${RELEASES}.`);
}
