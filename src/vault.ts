import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The id Obsidian knows a vault by in its list. Any 16 signs will do; the same folder gets the same. */
export function vaultId(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

/** The list of vaults that makes Obsidian open one vault when it starts */
export function vaultList(path: string, now: number): string {
  return JSON.stringify({ vaults: { [vaultId(path)]: { path, ts: now, open: true } } });
}

const isThere = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * What Obsidian keeps of a vault in its settings folder, as it was before a
 * run. Obsidian writes there when it opens a vault: which notes are open,
 * and its settings where none are. A run is not meant to change a vault, so
 * what a run has changed there is put back.
 */
export interface Kept {
  /** The settings folder of the vault */
  folder: string;
  hadFolder: boolean;
  hadPlugins: boolean;
  /** The files that lie directly in the folder, with what they held */
  files: Map<string, Buffer>;
}

export async function keepSettings(vault: string, configDir = ".obsidian"): Promise<Kept> {
  const folder = join(vault, configDir);
  const kept: Kept = { folder, hadFolder: await isThere(folder), hadPlugins: await isThere(join(folder, "plugins")), files: new Map() };
  if (!kept.hadFolder) {
    return kept;
  }
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isFile()) {
      kept.files.set(entry.name, await readFile(join(folder, entry.name)));
    }
  }
  return kept;
}

/**
 * Puts the settings folder back as it was kept: a file that was changed gets
 * its old content, a file that is new is removed, and a folder that was not
 * there is removed when nothing is left in it.
 *
 * @returns the names of the files that were put back or removed
 */
export async function restoreSettings(kept: Kept): Promise<string[]> {
  const touched: string[] = [];
  if (!(await isThere(kept.folder))) {
    return touched;
  }
  for (const entry of await readdir(kept.folder, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const path = join(kept.folder, entry.name);
    const before = kept.files.get(entry.name);
    if (before === undefined) {
      await rm(path, { force: true });
      touched.push(entry.name);
    } else if (!before.equals(await readFile(path))) {
      await writeFile(path, before);
      touched.push(entry.name);
    }
  }
  // Only what is empty goes: a folder that holds something of the user's stays
  if (!kept.hadPlugins) {
    await rmdir(join(kept.folder, "plugins")).catch(() => undefined);
  }
  if (!kept.hadFolder) {
    await rmdir(kept.folder).catch(() => undefined);
  }
  return touched.sort();
}

/** Makes the folder of a run for what Obsidian keeps about itself, with the vault to open in it */
export async function prepareProfile(profile: string, vault: string, now: number): Promise<void> {
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, "obsidian.json"), vaultList(vault, now));
}
