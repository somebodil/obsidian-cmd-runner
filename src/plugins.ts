import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** Where a plugin for a run comes from */
export type PluginSource = { kind: "folder"; path: string } | { kind: "release"; owner: string; repo: string; tag: string | null };

/** The files Obsidian takes of a plugin. The style sheet is not always there. */
const FILES = ["manifest.json", "main.js", "styles.css"] as const;

/**
 * Reads how a plugin was named on the command line: a folder, or a
 * repository on GitHub as `owner/repo`, with `@tag` for one release.
 * What starts with a dot or a slash, or is a folder that exists, is a folder.
 */
export function parsePlugin(spec: string, isFolder: (path: string) => boolean): PluginSource {
  const text = spec.trim();
  if (text === "") {
    throw new Error("A plugin needs a name: owner/repo, owner/repo@tag, or a folder.");
  }
  if (text.startsWith(".") || isAbsolute(text) || isFolder(text)) {
    return { kind: "folder", path: text };
  }
  const found = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:@(.+))?$/.exec(text);
  if (found === null) {
    throw new Error(`"${spec}" is not a plugin: write owner/repo, owner/repo@tag, or a folder.`);
  }
  return { kind: "release", owner: found[1] ?? "", repo: found[2] ?? "", tag: found[3] ?? null };
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
