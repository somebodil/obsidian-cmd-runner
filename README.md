# obsidian-cmd-runner

Runs a command of an [Obsidian](https://obsidian.md) plugin without the window of Obsidian: on a build server after every push, or from a script.

It starts a real Obsidian, opens your vault in it, turns the plugins on, runs the commands you name, and ends Obsidian again. What a plugin does there is what it does when you press its command yourself, because it is the same program.

Not made by Obsidian, and not one of its tools. Obsidian is not part of this package: the version you ask for is fetched from where Obsidian publishes it.

## Requirements

- Node.js 22.18 or later
- Linux (x64 or arm64) or macOS
- On Linux nothing else: the window is drawn on a screen that is made for the run when `Xvfb` is installed, as it is on the build servers of GitHub, and Obsidian runs with no screen at all when it is not. `OBSIDIAN_CMD_RUNNER_SCREEN` chooses by hand: `made`, `none`, or `shown` for the screen of the computer.

## What it does when told nothing else

It builds a website of your notes with the plugin [vault-to-site](https://github.com/somebodil/vault-to-site):

```sh
npx obsidian-cmd-runner --vault path/to/vault
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

## Running any command

```sh
obsidian-cmd-runner --vault notes --plugin owner/repo --command plugin-id:command-id
```

| Option | What it does |
| --- | --- |
| `--vault <folder>` | The vault. To begin with, the folder you are in. |
| `--obsidian-version <v>` | A version as `1.15.1`, or `latest`. To begin with, `latest`. |
| `--obsidian-app <path>` | Use an Obsidian that is installed, and fetch nothing. |
| `--plugin <spec>` | Put a plugin into the vault for the run: `owner/repo` (its latest release), `owner/repo@tag`, or a folder with `main.js` and `manifest.json`. May be given again. |
| `--command <id>` | The id of a command, as `plugin-id:command-id`. May be given again: they run in that order, and a failure ends the run. |
| `--eval <file.js>` | Run a file of JavaScript inside Obsidian. What it returns is the result. |
| `--arg <key=value>` | What the command is given. A value that is JSON is read as JSON. May be given again. |
| `--args-file <file.json>` | The same, from a file. |
| `--config <file.json>` | Settings for vault-to-site. To begin with, `vault-to-site.json` in the vault. |
| `--wait <auto\|none\|file:PATH>` | When a command counts as done. See below. |
| `--timeout <seconds>` | How long a command may take. To begin with, 600. |
| `--no-vault-plugins` | Leave the plugins the vault has turned on off. |
| `--keep` | Leave in the vault what the run put there. |
| `--cache-dir <folder>` | Where Obsidian is kept between runs. |
| `--github-token <token>` | For a plugin in a repository that is not public. `GITHUB_TOKEN` in the environment does the same. |
| `--json` | Print the result as JSON. |
| `--verbose` | Print what Obsidian writes to its console, and how long each part took. |
| `--show` | Do not hide the window. |

Other things it can do:

```sh
obsidian-cmd-runner install --obsidian-version 1.14.5   # only fetch Obsidian
obsidian-cmd-runner resolve-version                     # print the version that would be used
```

The program ends with 0 when every command was done, 1 when a command failed, 2 when what was asked cannot work, 3 when Obsidian could not be started or did not open the vault, and 124 when a command took too long.

## Which Obsidian

`--obsidian-version` takes any version Obsidian has published with a program for your kind of computer: see [its releases](https://github.com/obsidianmd/obsidian-releases/releases). The first run with a version fetches it (about 130 MB on Linux, 230 MB on macOS) into a cache, and later runs take it from there. A run is as far as it can be from your own Obsidian: it has a profile of its own, which is thrown away after the run, and it does not check for updates.

## How long a run takes

Measured with a command that takes a fifth of a second, with Obsidian in the cache:

| | Start Obsidian and open the vault | The whole run |
| --- | --- | --- |
| macOS (a laptop) | 0.6 s | 1.5 s |
| Linux (a build server of GitHub) | 2 to 3 s | 3 to 4 s |

A site of 302 notes with 304 diagrams is built on such a server in 3 seconds, and the whole job, from the checkout to the site, takes under 20. The first run with a version fetches Obsidian, which takes as long as 130 MB take to arrive.

Which version is the newest is asked of GitHub at most every ten minutes.

## What happens to the vault

A run is not meant to change a vault. Obsidian writes into the settings folder of a vault when it opens one: which notes are open, and settings where there are none. After a run, a file there that was changed has its old content again, a file that is new is gone, and so are the plugins the run brought. What the commands themselves write stays: that is what they were run for.

A plugin the vault has already is used as it is, also when the same plugin is named with `--plugin`: what is installed in a vault is the choice of its owner.

The plugins the vault has turned on are on during a run, as they are when you open the vault: a note may need them to be drawn right. `--no-vault-plugins` leaves them off.

Do not run it on a vault that is open in your own Obsidian at the same time: two Obsidians writing the settings of one vault get in each other's way.

## When a command counts as done

Obsidian starts a command and does not say when its work is over. So there are three ways:

- **The command says so.** A command that knows of the runner tells it when it is done, and what came of it. This is what `auto` waits for, when the command takes part.
- **A file appears.** `--wait file:out/report.json` waits until that file is in the vault.
- **Not at all.** `--wait none`, and `auto` for a command that does not take part: the command is started, and the run goes on.

### For authors of plugins

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
          obsidian-version: latest
      # The site is in the folder the settings name: put it where your pages are served from
```

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

## What it rests on

- Obsidian is started with a profile of its own and with the port that a browser's developer tools talk through, and is driven through that port. This is how the plugins are turned on without a hand on the window, and it is not something Obsidian promises to keep.
- The licence of Obsidian lets you install and run it "on machines operated by or for you". A run on your own vault, on your computer or on a build server working for you, is that. It does not let you run Obsidian as a service for others, or pass Obsidian on: which is why it is fetched on each computer and is in no package or image of this project.

## What was tried, and what was not

- **On macOS** with Obsidian 1.15.1, 1.13.7 and 1.5.12, and **on Linux** on the build servers of GitHub with 1.15.1 and 1.8.10, with a screen made for the run and with none: commands that end in each way a command can, a vault with settings and plugins of its own, a command that takes too long, a file of code.
- **A site** was built through vault-to-site on both: on Linux from a vault of 304 notes, of which the 302 that were marked went in, with every diagram and formula drawn. The site was the same, file for file, with a screen made for the run and with none.
- **Not tried:** Windows, which it does not fetch Obsidian for yet, and Linux on arm64.

## Development

```sh
npm install
npm run check   # types and the tests that need no Obsidian
npm run e2e     # the tests in a real Obsidian: OBSIDIAN_VERSION=1.14.5 or OBSIDIAN_APP=/Applications/Obsidian.app
```

The program is TypeScript that Node.js runs as it is, so there is nothing to build while working on it. `npm pack` builds the JavaScript that the package holds.

## License

MIT
