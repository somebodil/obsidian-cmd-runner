import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** Where a plugin for a run comes from */
export type PluginSource =
  | { kind: "folder"; path: string }
  | { kind: "release"; owner: string; repo: string; tag: string | null }
  /** A plugin of the list Obsidian shows as its community plugins, by the id it has there */
  | { kind: "community"; id: string; tag: string | null };

/** The list Obsidian itself reads to show its community plugins: each with its id and the repository it is fetched from */
export const COMMUNITY_LIST = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-plugins.json";

const REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)$/;

/** The files Obsidian takes of a plugin. The style sheet is not always there. */
const FILES = ["manifest.json", "main.js", "styles.css"] as const;

/**
 * Reads how a plugin was named on the command line: a folder, a
 * repository on GitHub as `owner/repo`, or the id of a community plugin,
 * the last two with `@tag` for one release.
 * What starts with a dot or a slash, or is a folder that exists, is a folder.
 */
export function parsePlugin(spec: string, isFolder: (path: string) => boolean): PluginSource {
  const text = spec.trim();
  if (text === "") {
    throw new Error("A plugin needs a name: owner/repo, the id of a community plugin, or a folder.");
  }
  if (text.startsWith(".") || isAbsolute(text) || isFolder(text)) {
    return { kind: "folder", path: text };
  }
  const found = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:@(.+))?$/.exec(text);
  if (found !== null) {
    return { kind: "release", owner: found[1] ?? "", repo: found[2] ?? "", tag: found[3] ?? null };
  }
  // A name with no slash that is no folder: the id a plugin has in the list of community plugins
  const byId = /^([A-Za-z0-9][A-Za-z0-9_-]*)(?:@(.+))?$/.exec(text);
  if (byId === null) {
    throw new Error(`"${spec}" is not a plugin: write owner/repo, the id of a community plugin, or a folder. A release is named with @tag after it.`);
  }
  return { kind: "community", id: byId[1] ?? "", tag: byId[2] ?? null };
}

/**
 * Finds the repository of a community plugin in the list of Obsidian.
 * The id is the one Obsidian shows in the address of the plugin, and the
 * one its commands start with.
 */
export async function findCommunityPlugin(id: string, fetcher: typeof fetch): Promise<{ owner: string; repo: string }> {
  const reply = await fetcher(COMMUNITY_LIST, { redirect: "follow" });
  if (!reply.ok) {
    throw new Error(`The list of community plugins could not be read (GitHub answered ${String(reply.status)}). Name the plugin "${id}" by its repository, as owner/repo.`);
  }
  let list: unknown;
  try {
    list = JSON.parse(await reply.text()) as unknown;
  } catch {
    list = null;
  }
  if (!Array.isArray(list)) {
    throw new Error(`The list of community plugins could not be read: it is not a list. Name the plugin "${id}" by its repository, as owner/repo.`);
  }
  const entries = list.filter((one): one is { id: string; repo: string } => {
    const entry = one as { id?: unknown; repo?: unknown } | null;
    return typeof entry === "object" && entry !== null && typeof entry.id === "string" && typeof entry.repo === "string";
  });
  // As it is written first. Ids are told apart by upper and lower case in the list, but nobody remembers which a plugin took.
  const entry = entries.find((one) => one.id === id) ?? entries.find((one) => one.id.toLowerCase() === id.toLowerCase());
  if (entry === undefined) {
    throw new Error(`"${id}" is not the id of a community plugin of Obsidian. A plugin that is not in that list is named by its repository, as owner/repo, or by a folder.`);
  }
  const found = REPO.exec(entry.repo.trim());
  if (found === null) {
    throw new Error(`The list of community plugins names "${entry.repo}" as the repository of "${id}", which is not one.`);
  }
  return { owner: found[1] ?? "", repo: found[2] ?? "" };
}

/** Where the file of a release is fetched from, without an account */
export function releaseFileUrl(source: { owner: string; repo: string; tag: string | null }, file: string): string {
  const base = `https://github.com/${source.owner}/${source.repo}/releases`;
  return source.tag === null ? `${base}/latest/download/${file}` : `${base}/download/${encodeURIComponent(source.tag)}/${file}`;
}

const isThere = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The id of a plugin, from its manifest */
function idOf(manifest: string, from: string): string {
  let id: unknown;
  try {
    id = (JSON.parse(manifest) as { id?: unknown }).id;
  } catch {
    throw new Error(`The manifest of the plugin ${from} is not JSON.`);
  }
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-_]*$/i.test(id)) {
    throw new Error(`The manifest of the plugin ${from} has no id.`);
  }
  return id;
}

/** Fetches the files of a release. With a token, also from a repository that is not public. */
async function fetchRelease(source: { owner: string; repo: string; tag: string | null }, fetcher: typeof fetch, token: string | null): Promise<Map<string, Buffer>> {
  const name = `${source.owner}/${source.repo}${source.tag === null ? "" : "@" + source.tag}`;
  const files = new Map<string, Buffer>();
  if (token === null) {
    // Asked for at the same time: one after the other, a run would wait three times as long for them
    const replies = await Promise.all(
      FILES.map(async (file) => {
        const reply = await fetcher(releaseFileUrl(source, file), { redirect: "follow" });
        return { file, status: reply.status, content: reply.ok ? Buffer.from(await reply.arrayBuffer()) : null };
      }),
    );
    for (const { file, status, content } of replies) {
      if (content !== null) {
        files.set(file, content);
      } else if (file !== "styles.css") {
        throw new Error(
          `The plugin ${name} has no ${file} in its release (GitHub answered ${String(status)}). ` +
            "For a repository that is not public, give a token with --github-token or GITHUB_TOKEN.",
        );
      }
    }
    return files;
  }
  // A repository that is not public gives its files only through the API, to the one who has the token
  const api = `https://api.github.com/repos/${source.owner}/${source.repo}/releases/${source.tag === null ? "latest" : "tags/" + encodeURIComponent(source.tag)}`;
  const headers = { authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": "obsidian-cmd-runner" };
  const reply = await fetcher(api, { headers: { ...headers, accept: "application/vnd.github+json" } });
  if (!reply.ok) {
    throw new Error(`The release of the plugin ${name} could not be read (GitHub answered ${String(reply.status)}).`);
  }
  const release = (await reply.json()) as { assets?: { name: string; url: string }[] };
  for (const file of FILES) {
    const asset = release.assets?.find((one) => one.name === file);
    if (asset === undefined) {
      if (file === "styles.css") {
        continue;
      }
      throw new Error(`The plugin ${name} has no ${file} in its release.`);
    }
    const got = await fetcher(asset.url, { headers: { ...headers, accept: "application/octet-stream" }, redirect: "follow" });
    if (!got.ok) {
      throw new Error(`${file} of the plugin ${name} could not be fetched (GitHub answered ${String(got.status)}).`);
    }
    files.set(file, Buffer.from(await got.arrayBuffer()));
  }
  return files;
}

export interface Placed {
  id: string;
  /** False when the vault had the plugin already, and that one is used */
  placed: boolean;
  folder: string;
}

/**
 * Puts a plugin into the vault for the run. A plugin the vault has already
 * is left as it is and used: what is installed there is the user's choice.
 */
export async function placePlugin(source: PluginSource, pluginsDir: string, base: string, fetcher: typeof fetch, token: string | null): Promise<Placed> {
  let files: Map<string, Buffer>;
  let from: string;
  if (source.kind === "folder") {
    const folder = resolve(base, source.path);
    from = `in "${source.path}"`;
    files = new Map();
    for (const file of FILES) {
      if (await isThere(join(folder, file))) {
        files.set(file, await readFile(join(folder, file)));
      } else if (file !== "styles.css") {
        throw new Error(`The folder "${source.path}" is not a plugin: it has no ${file}.`);
      }
    }
  } else if (source.kind === "community") {
    // The id is known before anything is fetched: the plugin the vault has is used, and the list is not asked for
    const has = join(pluginsDir, source.id);
    if (await isThere(has)) {
      return { id: source.id, placed: false, folder: has };
    }
    const repository = await findCommunityPlugin(source.id, fetcher);
    from = `${source.id} (${repository.owner}/${repository.repo})`;
    files = await fetchRelease({ ...repository, tag: source.tag }, fetcher, token);
  } else {
    from = `${source.owner}/${source.repo}`;
    files = await fetchRelease(source, fetcher, token);
  }
  const id = idOf((files.get("manifest.json") ?? Buffer.alloc(0)).toString("utf8"), from);
  const folder = join(pluginsDir, id);
  if (await isThere(folder)) {
    return { id, placed: false, folder };
  }
  await mkdir(folder, { recursive: true });
  for (const [file, content] of files) {
    await writeFile(join(folder, file), content);
  }
  return { id, placed: true, folder };
}

/** Takes away the plugins a run has put into the vault */
export async function removePlaced(placed: readonly Placed[]): Promise<void> {
  for (const plugin of placed) {
    if (plugin.placed) {
      await rm(plugin.folder, { recursive: true, force: true });
    }
  }
}

/** Copies a plugin folder as it is: for tests */
export async function copyPlugin(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true });
}
