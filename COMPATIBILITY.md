# Which versions of Obsidian it works with, and how that is kept

obsidian-cmd-runner drives Obsidian in ways Obsidian does not promise to keep. So the promise is made here, and kept by tests:

**A version of obsidian-cmd-runner works with every Obsidian from the oldest one below to the newest one there is. A change to the runner does not take a version away.**

## The versions

| | Oldest that is tried | Also tried | Newest |
| --- | --- | --- | --- |
| Linux, x64 (a build server of GitHub) | 1.6.7 | 1.8.10 | the latest, every week |
| Linux, arm64 | 1.6.7 | 1.7.7, 1.8.10, 1.11.7 | 1.15.1 |
| macOS | 1.5.12 | 1.13.7 | 1.15.1 |

- **Below the oldest.** Obsidian 1.5.12 and 1.4.16 do not start on Linux on arm64 with no screen: Obsidian itself ends with a fault before a vault is opened, and the run says so and ends with 3. Whether they start on Linux on x64 was not tried.
- **Above the newest.** A new Obsidian is tried by the tests every week, before anybody is told that it works.

## How it is kept

1. **The tests run in a real Obsidian** (`npm run e2e`), on GitHub for every push and once a week, with the oldest version, one between, and the latest: with a screen made for the run and with none.
2. **A week in which the latest Obsidian fails is a week in which the runner is repaired,** so that the old versions and the new one both pass. A version is not taken out of the tests to make them pass.
3. **The oldest version is raised only on purpose:** with a line in this file that says which version went and why, and a new number for the runner that says so.

## Rules for the code

- **Ask whether a thing is there, not which version runs.** `typeof command.checkCallback === "function"`, not `version >= 1.8`. A thing that came or went in some version is then right in all of them, also in the ones that were never tried.
- **Everything that Obsidian does not promise has an answer for when it is missing:** another way to the same end, or a plain sentence for the one who runs it and the right number to end with. Never a wait without end, and never a run that says it went well when it cannot know.
- **A new use of something Obsidian does not promise is written into the table below,** with what happens without it, and is tried with the oldest version before it is kept.

## What is used that Obsidian does not promise

| What | Where | Without it |
| --- | --- | --- |
| Starting Obsidian with `--user-data-dir` and `--remote-debugging-port`, and on Linux `--ozone-platform=headless` | `launch.ts` | Obsidian does not start, or no page is found: the run ends with 3 and what Obsidian wrote |
| The list of vaults in `obsidian.json` of the profile | `vault.ts` | Obsidian shows its list of vaults in place of the vault: the run ends with 3 |
| `app.workspace.onLayoutReady`, `app.vault`, `app.metadataCache.getFileCache` | `session.ts` (`whenReady`, `whenIndexed`) | Public API of plugins. `app.metadataCache.inProgressTaskCount` is not: where it is missing, the notes are asked one by one. |
| `app.plugins`: `setEnable`, `loadManifests`, `enablePlugin`, `manifests`, `plugins` | `session.ts` (`turnOn`) | The run ends with 1 and the name of the plugin that could not be turned on |
| `app.commands.commands`, `executeCommandById`, and of a command `callback`, `checkCallback`, `editorCallback`, `editorCheckCallback` | `session.ts` (`startCommand`, `listCode`) | A command with none of `callback` and `checkCallback` is left to `executeCommandById` |
| Node.js in the page of Obsidian: `async_hooks` (`AsyncLocalStorage`, `createHook`, `AsyncResource.bind`) telling of promises | `session.ts` (`followWork`) | Tried on something small before each command (`work.check`). Where it does not hold, the work is not followed: the run says so and goes on as with `--wait none`. |
| The calls that make a promise, as the browser tells of them, and the addresses of code: `app://` for Obsidian, `plugin:` or a folder `_plugin` for a plugin | `session.ts` (`isOfPlugin`) | The promises of a plugin would not be told from those of Obsidian. The tests with commands that work in each way would fail: this is what they are for. |
| `HeapProfiler.collectGarbage` of the developer tools, and `setImmediate` of Node.js to hear of what was taken away | `session.ts` (`dropUnkept`) | A command that left a promise nobody keeps would end late, when its time is over |
| The class `notice` on what Obsidian shows as a notice | `session.ts` (`followWork`) | Notices are not printed |
| The names of the files Obsidian publishes: `obsidian-<version>.tar.gz`, `obsidian-<version>-arm64.tar.gz`, `Obsidian-<version>.dmg` | `releases.ts` | The run ends with 3 and says that the version is not published for this kind of computer. `--obsidian-app` uses one that is installed. |
| The settings folder of a vault, and `community-plugins.json` in it | `vault.ts`, `run.ts` | Kept before a run and put back after it, whatever it holds |
