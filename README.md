# obsidian-cmd-runner

Run a command of an [Obsidian](https://obsidian.md) plugin from the command line.

```sh
obsidian-cmd-runner --vault notes --plugin owner/repo --command plugin-id:command-id
```

It starts a real Obsidian with no window, opens your vault, turns the plugin on, runs the command, waits until the work is done, and ends. What the plugin does there is what it does when you press its command yourself, because it is the same program.

- **For any plugin.** A plugin does not have to know of this tool. The run follows the work a command starts, and ends when none of it is left.
- **For a build server.** Nothing to click, no screen needed on Linux, and the program ends with a number that says how it went.
- **Your vault is left as it was.** The plugin is put in for the run and taken out after it, and the settings Obsidian writes are put back.

Not made by Obsidian, and not one of its tools. Obsidian is not part of this package: the version you ask for is fetched from where Obsidian publishes it.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Which commands are there](#which-commands-are-there)
- [Plugins that were tried](#plugins-that-were-tried)
- [Options](#options)
- [When a command counts as done](#when-a-command-counts-as-done)
- [What happens to the vault](#what-happens-to-the-vault)
- [Which Obsidian, and how long a run takes](#which-obsidian-and-how-long-a-run-takes)
- [On GitHub Actions](#on-github-actions)
- [From code](#from-code)
- [For authors of plugins](#for-authors-of-plugins)
- [What it rests on](#what-it-rests-on)
- [What was tried, and what was not](#what-was-tried-and-what-was-not)
- [Development](#development)

## Install

You need [Node.js](https://nodejs.org) 22.18 or later, on Linux (x64 or arm64) or macOS. On Linux nothing else: Obsidian runs with no screen at all.

```sh
npm install -g github:somebodil/obsidian-cmd-runner
```

The first run fetches Obsidian (about 130 MB on Linux, 230 MB on macOS) and keeps it for later runs.

## Quick start

**See which commands a plugin has:**

```sh
obsidian-cmd-runner commands --vault notes --plugin owner/repo
```

**Run one:**

```sh
obsidian-cmd-runner --vault notes --plugin owner/repo --command plugin-id:command-id
```

**Run several, in order.** A command that fails ends the run:

```sh
obsidian-cmd-runner --vault notes \
  --plugin owner/first --plugin owner/second \
  --command first:prepare --command second:export
```

**Build a website of your notes.** This is what it does when told nothing else, with the plugin [vault-to-site](https://github.com/somebodil/vault-to-site):

```sh
obsidian-cmd-runner --vault notes
```

What goes into the site is said in a file `vault-to-site.json` in the vault:

```json
{
  "ticks": { "on": [""] },
  "only": "publish: true",
  "format": "folder",
  "folder": "_site"
}
```

That is: of the whole vault, the notes that have the property `publish: true`, written as a folder `_site`. On a server nobody looks the list of notes over before a build, so let a mark on each note say what goes in: a note then does not go in by being new.

**How it ended** is the number the program ends with:

| Number | The run |
| --- | --- |
| 0 | Every command was done |
| 1 | A command failed |
| 2 | What was asked cannot work, as an option that is not one |
| 3 | Obsidian could not be started, or did not open the vault |
| 124 | A command took too long |
| 130 | The run was stopped, as with Ctrl+C. The vault is still put back. |

## Which commands are there

A command is named by its id, `plugin-id:command-id`. Obsidian does not show ids, and a plugin was not written to be run this way, so its README will not tell you. Ask:

```sh
obsidian-cmd-runner commands --vault notes --plugin owner/repo
```

```
vault-to-site
  vault-to-site:build        vault-to-site: Build a site
  vault-to-site:build-again  vault-to-site: Build again without the dialog
```

- The list holds the commands of the plugins you name with `--plugin` and of the plugins the vault has turned on.
- `--all` lists the commands of Obsidian itself as well, as `daily-notes`.
- `--json` gives the list as JSON.
- A command marked **works on the note that is open** needs a note in the editor, and a run has none. One marked **does not apply now** says itself that it cannot run as things are.

A command that is on the list can be started. Whether it is of use with nobody there is another matter: one that opens a window and asks something has nobody to answer it. The next part names plugins that were tried.

## Plugins that were tried

Each of these was run this way before it was put on the list: with Obsidian 1.15.1 on Linux, with no screen, in a small vault made for it. The version is the one that was tried. A plugin that is not here may work as well: ask for its commands and try.

**They work as they are:**

| Plugin | Command | What it does |
| --- | --- | --- |
| Obsidian itself | `daily-notes` | Makes the daily note of today, from the folder and template its settings name |
| [vault-to-site](https://github.com/somebodil/vault-to-site) 0.1.0 | `vault-to-site:build-again` | Builds a website of the notes that `vault-to-site.json` names. This is what runs when no command is named. |
| [Find orphaned files and broken links](https://github.com/vinzent03/find-unlinked-files) 1.11.0 | `find-unlinked-files:find-unlinked-files`<br>`find-unlinked-files:find-unresolved-link`<br>`find-unlinked-files:find-files-without-tags`<br>`find-unlinked-files:find-empty-files` | Each writes a note with what it found: notes nothing links to, links that lead nowhere, notes without tags, empty notes |
| [Vault Changelog](https://github.com/philoserf/obsidian-vault-changelog) 2.0.0 | `obsidian-vault-changelog:update-changelog` | Writes `Changelog.md`, the notes that were changed last |
| [Periodic Notes](https://github.com/liamcain/obsidian-periodic-notes) 0.0.17 | `periodic-notes:open-daily-note` | Makes the note of today. The notes of the week and the month need its settings. |
| [Local Backup](https://github.com/velviagris/obsidian-local-backup) 0.2.5 | `local-backup:run-local-backup` | Writes a zip archive of the vault. Told nothing, into the folder above the vault: name another with its settings. |
| [Clear Unused Images](https://github.com/ozntel/oz-clear-unused-images-obsidian) 1.1.1 | `oz-clear-unused-images:clear-images-obsidian` | **Changes the vault:** moves the pictures no note uses to the trash |
| [Janitor](https://github.com/Canna71/obsidian-janitor) 1.2.0 | `janitor:scan-files-noprompt` | **Changes the vault:** moves what it finds unused to the trash, without asking |

**They work with settings.** A plugin reads its settings from its file `data.json`. `--settings plugin-id=file.json` gives it that file for the run, also a plugin that is brought with `--plugin`:

```sh
obsidian-cmd-runner --vault notes --plugin platers/obsidian-linter \
  --settings obsidian-linter=linter.json --command obsidian-linter:lint-all-files
```

| Plugin | Command | What it does | What its settings have to say |
| --- | --- | --- | --- |
| [Linter](https://github.com/platers/obsidian-linter) 1.35.0 | `obsidian-linter:lint-all-files` | **Changes the vault:** writes every note anew by its rules | `"suppressLintAllFilesConfirmationModal": true`, and the rules under `ruleConfigs`. Without the first it asks in a window. |
| [Webpage HTML Export](https://github.com/KosmosisDire/obsidian-webpage-export) 1.9.2 | `webpage-html-export:export-html-vault` | Writes the notes as web pages | Under `exportOptions`: `exportPath`, a folder that is there, by its whole path, and `filesToExport`, the notes and folders. `"openAfterExport": false`. |
| [Templater](https://github.com/SilentVoid13/Templater) 2.27.0 | `templater-obsidian:create-<path of a template>` | Makes a note from that template | `templates_folder`, and the template among `enabled_templates_hotkeys`: a template has a command only then |
| [Metadata Extractor](https://github.com/kometenstaub/metadata-extractor) 1.1.0 | `metadata-extractor:write-metadata-json`<br>`metadata-extractor:write-tags-json` | Writes the notes with their links, and the tags, as JSON | `metadataPath`, `tagPath`: files by their whole path. Told nothing, it writes into its own folder, which is gone after the run. |
| [File Cleaner Redux](https://github.com/husjon/obsidian-file-cleaner-redux) 1.17.0 | `file-cleaner-redux:clean-files` | **Changes the vault:** moves empty notes and unused files to the trash | `"deletionConfirmation": false`. And in the vault's `.obsidian/app.json`, `"trashOption": "local"`: with no screen there is no trash of the system. |
| [Dataview Serializer](https://github.com/dsebastien/obsidian-dataview-serializer) 3.8.0 | `dataview-serializer:serialize-all-dataview-queries` | Writes what the queries of Dataview find into the notes | Nothing, but it needs [Dataview](https://github.com/blacksmithgu/obsidian-dataview) as a second `--plugin`, and Dataview has to have read the notes first: see below |

**They work on the note that is open,** and a run has none. A file of code can open one before the command, in the same run:

```js
// open.js
const note = app.vault.getAbstractFileByPath(runner.args.note);
await app.workspace.getLeaf(false).openFile(note);
```

```sh
obsidian-cmd-runner --vault notes --plugin platers/obsidian-linter --settings obsidian-linter=linter.json \
  --eval open.js --arg note=Projects/Plan.md --command obsidian-linter:lint-file
```

| Plugin | Command | What it does | What else it needs |
| --- | --- | --- | --- |
| Linter 1.35.0 | `obsidian-linter:lint-file` | Writes the open note anew by its rules | Its rules, as above |
| Templater 2.27.0 | `templater-obsidian:replace-in-file-templater` | Runs the template code in the open note | |
| [Pandoc Plugin](https://github.com/OliverBalfour/obsidian-pandoc) 0.4.1 | `obsidian-pandoc:pandoc-export-html`<br>`obsidian-pandoc:pandoc-export-docx` | Writes the open note as HTML or for Word, beside the note | For Word, `pandoc` on the computer |
| [Enhancing Export](https://github.com/mokeyish/obsidian-enhancing-export) 1.11.4 | `obsidian-enhancing-export:obsidian-enhancing-export:export-with-previous` | Writes the open note as it was written last | `pandoc`, and settings: `lastExportType`, `lastExportDirectory`, `"openExportedFile": false` |

**A plugin that another plugin has to be ready for.** A run waits until Obsidian has read the notes, not until every plugin has. Dataview reads them once more for itself, and a command that asks Dataview at once finds nothing. A file of code before the command waits for it:

```js
const dataview = app.plugins.plugins.dataview;
if (!dataview.index?.initialized) await new Promise((ready) => app.metadataCache.on("dataview:index-ready", ready));
```

**They need somebody,** so they are not for a run. Each opens a window and waits for an answer; the run ends with 1 and says which window was left open.

| Plugin | Command |
| --- | --- |
| Obsidian itself | `workspace:export-pdf` |
| [Better Export PDF](https://github.com/l1xnan/obsidian-better-export-pdf) 2.0.4 | `better-export-pdf:export-current-file-to-pdf` |
| [Link Converter](https://github.com/ozntel/obsidian-link-converter) 0.1.6 | `obsidian-link-converter:convert-wikis-to-md-in-vault` and the other way |
| [Nuke Orphans](https://github.com/sandorex/nuke-orphans-plugin) 1.2.5 | `nuke-orphans:nuke-orphaned` |
| Find orphaned files and broken links | `find-unlinked-files:delete-empty-files`, `find-unlinked-files:delete-empty-folders` |
| Templater | `templater-obsidian:create-new-note-from-template` |
| Webpage HTML Export | `webpage-html-export:export-html-setting` |

**Not tried, because they send notes somewhere:** plugins that publish or sync need an account, and were only looked at. [Git](https://github.com/Vinzent03/obsidian-git) commits with `obsidian-git:commit` when it is installed in the vault, but it takes in the settings files Obsidian writes when it opens a vault: look at what it commits before you let it run by itself.

What to know of all of them:

- **A command that fails may still end with 0.** Most plugins show what went wrong as a notice and go on. The notice is printed, but the run cannot know that it was bad news.
- **What a plugin writes into its own folder is gone after the run** when the plugin was brought with `--plugin`. Have it write into the vault.
- **Settings Obsidian keeps for the vault,** as those of the daily note, are files in `.obsidian` of the vault, and are read as they are.

## Options

| Option | What it does |
| --- | --- |
| `--vault <folder>` | The vault. To begin with, the folder you are in. |
| `--plugin <spec>` | Put a plugin into the vault for the run. May be given again. See below. |
| `--command <id>` | The id of a command, as `plugin-id:command-id`. May be given again: they run in that order. |
| `--eval <file.js>` | Run a file of JavaScript inside Obsidian, before the commands. What it returns is the result. In it, `runner.args` is what was given with `--arg`. |
| `--settings <id=file.json>` | Give a plugin its settings for the run: the file is its `data.json` then. May be given again. The settings a plugin of the vault had are put back. |
| `--arg <key=value>` | What the command is given. A value that is JSON is read as JSON. May be given again. |
| `--args-file <file.json>` | The same, from a file. |
| `--wait <auto\|none\|file:PATH>` | When a command counts as done. See [below](#when-a-command-counts-as-done). |
| `--timeout <seconds>` | How long a command may take. To begin with, 600. |
| `--obsidian-version <v>` | A version as `1.15.1`, or `latest`. To begin with, `latest`. |
| `--obsidian-app <path>` | Use an Obsidian that is installed, and fetch nothing. |
| `--no-vault-plugins` | Leave the plugins the vault has turned on off. |
| `--keep` | Leave in the vault what the run put there. |
| `--config <file.json>` | Settings for vault-to-site. To begin with, `vault-to-site.json` in the vault, whenever its command is among those that run. |
| `--cache-dir <folder>` | Where Obsidian is kept between runs. |
| `--github-token <token>` | For a plugin in a repository that is not public. `GITHUB_TOKEN` in the environment does the same. |
| `--json` | Print the result as JSON. |
| `--verbose` | Print what Obsidian writes to its console, how long each part took, and for a command that took too long, where in the code its work was started. |
| `--show` | Do not hide the window. |

Other things it can do:

```sh
obsidian-cmd-runner commands [options]                  # list the commands that can be run
obsidian-cmd-runner install --obsidian-version 1.14.5   # only fetch Obsidian
obsidian-cmd-runner resolve-version                     # print the version that would be used
```

### Naming a plugin

| Written as | What is used |
| --- | --- |
| `owner/repo` | The latest release of that repository on GitHub |
| `owner/repo@tag` | That release |
| A folder | A folder with `main.js` and `manifest.json`, as the one you build your own plugin in |

A plugin the vault has already is used as it is, also when the same plugin is named with `--plugin`: what is installed in a vault is the choice of its owner.

## When a command counts as done

Obsidian starts a command and does not say when its work is over: the command goes on by itself, and Obsidian stays open. A run has to end, so it has to know. Told nothing (`--wait auto`), it knows in one of two ways:

- **The run follows the work of the command.** This is for a command of any plugin: one that knows nothing of the runner. What the command starts is followed, and what that starts in its turn: what it waits for, the reading and writing of files, requests to the web, other programs, timers. The command has ended when nothing of it is left. A command that throws, or that fails later with nothing to catch it, makes the run fail, with what it said.
- **The command says so.** A command that knows of the runner tells it when it is done, and what came of it: see [For authors of plugins](#for-authors-of-plugins). That is exact, and it gives the run a result. When a command does this, its work is not followed.

Or you say:

- **A file is written.** `--wait file:out/report.json` waits until that file is in the vault. A file that is there before the command starts, as from an earlier run, does not count: the run waits until it is written anew.
- **Not at all.** `--wait none`: the command is started, and the run goes on.

What Obsidian shows as a notice while a command runs is printed for the one who watches the run. For a command that knows nothing of the runner, that is what it has to say.

### What following the work can and cannot tell

A command is taken to have ended when nothing it started is going on, and nothing has been for a moment. This is right for the ways a plugin usually works. But it is worked out from what goes on in Obsidian, not said by the command, so know its edges:

| The command | What the run does |
| --- | --- |
| Opens a window that asks something, and leaves it open | The run ends with 1 and says what the window asks: the work was not done |
| Waits for somebody in another way, as for a click on something in the page | Does not end. The run ends when its time is over (`--timeout`), with 124, and says what was left. With `--verbose` it also says where in the code that was started. |
| Leaves something running: a timer that repeats, or a timer of more than two seconds that nothing waits for | Does not wait for it |
| Starts work in a way the run cannot see: a message to a worker or to another window, with nothing in the plugin waiting for the answer | Ends too early. Name a file to wait for. A plugin that waits for the answer is followed. |
| Is of Obsidian itself, not of a plugin | Is followed only by what it asks of the system. What Obsidian waits for inside its own code is not counted: some of it stays open for as long as Obsidian runs. |

It needs an Obsidian that has Node.js in its page in the form that can follow work. Every version from 1.6.7 on that was tried has it. Before each command the run tries it on something small, and where it does not hold, the run says so and goes on after it has started the command, as with `--wait none`.

## What happens to the vault

A run is not meant to change a vault.

- **The settings folder is put back.** Obsidian writes into it when it opens a vault: which notes are open, and settings where there are none. After a run, a file there that was changed has its old content again, and a file that is new is gone.
- **The plugins the run brought are taken out.** `--keep` leaves them.
- **What the commands write stays.** That is what they were run for.
- **The plugins the vault has turned on are on during a run,** as they are when you open the vault: a note may need them to be drawn right. `--no-vault-plugins` leaves them off.

Do not run it on a vault that is open in your own Obsidian at the same time: two Obsidians writing the settings of one vault get in each other's way.

## Which Obsidian, and how long a run takes

**It works with Obsidian from 1.6.7 on, and is kept working with the newest.** The tests run in a real Obsidian with the oldest version and the latest, on every change and once a week, so that a new Obsidian is tried before you find out that it does not work. A version is not dropped to make a change easier. Which versions were tried on which kind of computer, and what the runner uses of Obsidian that Obsidian does not promise, is in [COMPATIBILITY.md](COMPATIBILITY.md).

`--obsidian-version` takes any version Obsidian has published with a program for your kind of computer: see [its releases](https://github.com/obsidianmd/obsidian-releases/releases). The first run with a version fetches it into a cache, and later runs take it from there. Which version is the newest is asked of GitHub at most every ten minutes.

A run is as far as it can be from your own Obsidian: it has a profile of its own, which is thrown away after the run, and it does not check for updates.

Measured with a command that takes a fifth of a second, with Obsidian in the cache:

| | Start Obsidian and open the vault | The whole run |
| --- | --- | --- |
| macOS (a laptop) | 0.6 s | 1.5 s |
| Linux (a build server of GitHub) | 2 to 3 s | 3 to 4 s |

A site of 302 notes with 304 diagrams is built on such a server in 3 seconds, and the whole job, from the checkout to the site, takes under 20.

**The window.** On Linux there is no window, and nothing has to be installed for one. On macOS the window of Obsidian opens for the time of the run: there is no way there to start it without one. A plugin that goes by the size of the window finds a small one where there is no screen. For such a plugin, `OBSIDIAN_CMD_RUNNER_SCREEN=made` gives Obsidian a screen of 1440 by 900 that is made for the run, which needs `Xvfb` to be installed. `--show`, on a computer with a screen, shows the window as it is.

## On GitHub Actions

```yaml
jobs:
  site:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: somebodil/obsidian-cmd-runner@main
        with:
          vault: .
          plugins: owner/repo
          commands: plugin-id:command-id
```

With no `plugins` and no `commands`, the site is built, into the folder its settings name: put that where your pages are served from.

| Input | |
| --- | --- |
| `vault` | The folder of the vault. To begin with, the repository. |
| `obsidian-version` | A version, or `latest` |
| `plugins` | Plugins for the run, one a line |
| `commands` | Ids of commands, one a line |
| `args` | What the commands are given, as JSON |
| `config` | A file of settings for vault-to-site |
| `timeout` | Seconds a command may take |
| `vault-plugins` | `false` to leave the plugins of the vault off |
| `github-token` | For a plugin in a repository that is not public |

The outputs are `result`, what the run gave back as JSON, and `obsidian-version`, the version that ran. Obsidian is kept in the cache of the workflow, by version.

## From code

```ts
import { DEFAULTS, run } from "obsidian-cmd-runner";

const result = await run(
  { ...DEFAULTS, vault: "notes", plugins: ["./my-plugin"], commands: ["my-plugin:export"] },
  { say: console.error, console: () => {}, fetch, env: process.env },
);
console.log(result.ok, result.commands[0]?.result);
```

For each command the result says whether it was done (`ok`), what told the run that it had ended (`ended`: `said`, `work`, `file` or `none`), what the command gave back (`result`), and how long it took.

## For authors of plugins

A command needs nothing to be run by this tool. But a command that takes part can say exactly when it is done, give back a result, and be told what the run was given.

While a command runs in the runner, there is `window.obsidianCmdRunner`. When a person runs the command, it is not there.

```js
this.addCommand({
  id: "export",
  name: "Export",
  callback: async () => {
    const runner = window.obsidianCmdRunner;
    runner?.claim(); // before the first await: "I will say when I am done"
    try {
      const out = await this.export(runner?.args ?? {});
      runner?.log("exported"); // a line for the one who watches the run
      runner?.done({ files: out.length }); // the result of the run
    } catch (error) {
      runner?.fail(error); // the run ends with 1
    }
  },
});
```

| | |
| --- | --- |
| `args` | What the run was given with `--arg` and `--args-file` |
| `claim()` | The command will say when it is done. To be called before the command first waits for anything. |
| `done(result?)` | The command is done. The result has to be something that can be written as JSON. |
| `fail(error)` | The command could not do its work |
| `log(message)` | A line for the one who watches |

What makes a command good to run with nobody there:

- **It asks nothing.** No window to confirm in. What a person would choose there is read from settings, or from `runner.args`.
- **It fails out loud.** An error that is thrown, or given to `fail`, ends the run with 1. An error that is only shown as a notice is printed, but the run counts as done.
- **It waits for what it starts.** Work that is awaited is followed to its end. Work that is started and forgotten is followed too, but a command that awaits it is the one that can also say how it went.

## What it rests on

- Obsidian is started with a profile of its own and with the port that a browser's developer tools talk through, and is driven through that port. This is how the plugins are turned on without a hand on the window, and it is not something Obsidian promises to keep.
- The work of a command is followed with what Node.js, which Obsidian has in its page, knows of what is started and by what. That too is not something Obsidian promises to keep.
- The licence of Obsidian lets you install and run it "on machines operated by or for you". A run on your own vault, on your computer or on a build server working for you, is that. It does not let you run Obsidian as a service for others, or pass Obsidian on: which is why it is fetched on each computer and is in no package or image of this project.

## What was tried, and what was not

- **On macOS** with Obsidian 1.15.1, 1.13.7 and 1.5.12, and **on Linux** on the build servers of GitHub with 1.15.1 and 1.8.10, with a screen made for the run and with none: commands that end in each way a command can, a vault with settings and plugins of its own, a command that takes too long, a file of code.
- **On Linux on arm64** with Obsidian 1.15.1 and 1.8.10 and no screen: the same commands, and with 1.15.1 a site of 142 real notes.
- **A site** was built through vault-to-site on all three: on a build server from a vault of 304 notes, of which the 302 that were marked went in, with every diagram and formula drawn. The site was the same, file for file, with a screen made for the run and with none.
- **Following the work of a command** was tried on Linux (x64 and arm64) and on macOS with commands that know nothing of the runner and work each in another way: an `async` function, work that is started and let go, timers and callbacks with no promise at all, another program, waiting for the page to be drawn and for something fetched. Also one that fails at once and one that fails later, one that leaves a repeating timer, a long timer, a notice and a promise nobody keeps behind, and one that waits for a click. And with vault-to-site building a site of 142 notes while what it says of itself was left out: three runs ended 0.8 to 0.9 seconds after the build was done, none before.
- **Older versions of Obsidian** on Linux on arm64: 1.6.7, 1.7.7 and 1.11.7 pass all of the above. 1.5.12 and 1.4.16 do not start there with no screen.
- **Not tried:** Windows, which it does not fetch Obsidian for yet.

## Development

```sh
npm install
npm run check   # types and the tests that need no Obsidian
npm run e2e     # the tests in a real Obsidian: OBSIDIAN_VERSION=1.14.5 or OBSIDIAN_APP=/Applications/Obsidian.app
```

The program is TypeScript that Node.js runs as it is, so there is nothing to build while working on it. The JavaScript that the package holds is built when it is packed or installed.

## License

MIT
