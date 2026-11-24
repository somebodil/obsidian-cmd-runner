/** What the command line asks for. Nothing here touches a file or the network, so it is tested with plain Node.js. */

export interface Options {
  /** The folder of the vault */
  vault: string;
  /** A version of Obsidian as `1.15.1`, or `latest` */
  obsidianVersion: string;
  /** An Obsidian that is installed already: the app on macOS, the program elsewhere. Nothing is downloaded then. */
  obsidianApp: string | null;
  /** Plugins to put into the vault for the run: `owner/repo`, `owner/repo@tag`, or a folder */
  plugins: string[];
  /** Ids of commands, run one after the other */
  commands: string[];
  /** A file of JavaScript that is run inside Obsidian */
  evalFile: string | null;
  /** Settings for plugins for the time of the run: the id of a plugin, and the file that is its `data.json` then */
  settings: Record<string, string>;
  /** JavaScript that is run inside Obsidian, as text: for what the program asks of Obsidian itself, as the list of its commands */
  evalCode: string | null;
  /** What a command is given: `window.obsidianCmdRunner.args` */
  args: Record<string, unknown>;
  /** A file of settings for the plugin that builds a site, when no command is named */
  config: string | null;
  /**
   * When a command counts as done: `auto` (it says so itself, or else its
   * work is followed until none is left), `none` (it is not waited for), or
   * `file:<path>` (when that file is written)
   */
  wait: string;
  /** Seconds a command may take */
  timeout: number;
  /** False to leave the plugins the vault has turned on off */
  vaultPlugins: boolean;
  /** True to leave in the vault what the run put there */
  keep: boolean;
  cacheDir: string | null;
  /** A token for GitHub, for a plugin in a repository that is not public */
  githubToken: string | null;
  json: boolean;
  verbose: boolean;
  /** True to let the window be seen where it can be hidden */
  show: boolean;
}

export type Parsed =
  | { kind: "run"; options: Options }
  /** `all`: also the commands of Obsidian itself, not only those of plugins */
  | { kind: "commands"; options: Options; all: boolean }
  | { kind: "resolve-version"; version: string }
  | { kind: "install"; options: Options }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export const DEFAULTS: Options = {
  vault: ".",
  obsidianVersion: "latest",
  obsidianApp: null,
  plugins: [],
  commands: [],
  evalFile: null,
  evalCode: null,
  settings: {},
  args: {},
  config: null,
  wait: "auto",
  timeout: 600,
  vaultPlugins: true,
  keep: false,
  cacheDir: null,
  githubToken: null,
  json: false,
  verbose: false,
  show: false,
};

export const HELP = `obsidian-cmd-runner: runs a command of an Obsidian plugin without the window of Obsidian

Usage
  obsidian-cmd-runner [options]                 run commands in a vault
  obsidian-cmd-runner commands [options]        list the commands that can be run: the ids
                                                of the plugins in the vault and of --plugin;
                                                with --all, those of Obsidian itself as well
  obsidian-cmd-runner install [options]         only fetch Obsidian
  obsidian-cmd-runner resolve-version [version] print the version that would be used

With no --command and no --eval, a site is built with the plugin vault-to-site.

Options
  --vault <folder>             the vault (default: the folder you are in)
  --obsidian-version <v>       a version as 1.15.1, or latest (default: latest)
  --obsidian-app <path>        use an Obsidian that is installed, and fetch nothing
  --plugin <spec>              put a plugin into the vault for the run; may be given again
                               owner/repo, owner/repo@tag, or a folder with main.js and manifest.json
  --command <id>               the id of a command, as plugin-id:command-id; may be given again
  --eval <file.js>             run a file of JavaScript inside Obsidian, before the commands
  --settings <id=file.json>    the settings of a plugin for the run: its data.json; may be given again
  --arg <key=value>            what the command is given; may be given again
  --args-file <file.json>      the same, from a file
  --config <file.json>         settings for vault-to-site (default: vault-to-site.json in the vault)
  --wait <auto|none|file:PATH> when a command counts as done (default: auto:
                               it says so, or else when its work has ended)
  --timeout <seconds>          how long a command may take (default: 600)
  --no-vault-plugins           leave the plugins the vault has turned on off
  --keep                       leave in the vault what the run put there
  --cache-dir <folder>         where Obsidian is kept between runs (default: .obsidian-cmd in
                               your home folder, or what OBSIDIAN_CMD_RUNNER_CACHE names)
  --github-token <token>       for a plugin in a repository that is not public (or set GITHUB_TOKEN)
  --json                       print the result as JSON
  --verbose                    print what Obsidian writes to its console
  --show                       do not hide the window
  --help, --version
`;

/** The most seconds a command may be given. A timer of Node.js that is set for longer goes off at once. */
export const LONGEST_TIMEOUT = 2_147_483;

/** A value given as `key=value`: read as JSON when it is JSON, else kept as text */
function valueOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Reads the command line.
 *
 * @param readJson reads a file of JSON for `--args-file`; an error it throws is reported with the name of the file
 */
export function parseArgs(argv: readonly string[], readJson: (path: string) => unknown = () => ({})): Parsed {
  const options: Options = { ...DEFAULTS, plugins: [], commands: [], args: {}, settings: {} };
  const rest = [...argv];
  let kind: "run" | "install" | "commands" = "run";
  let all = false;
  if (rest[0] === "resolve-version") {
    return { kind: "resolve-version", version: rest[1] ?? "latest" };
  }
  if (rest[0] === "install" || rest[0] === "commands") {
    kind = rest[0];
    rest.shift();
  } else if (rest[0] === "run") {
    rest.shift();
  }
  while (rest.length > 0) {
    const flag = rest.shift() ?? "";
    // `--flag=value` and `--flag value` are the same
    const equals = flag.startsWith("--") ? flag.indexOf("=") : -1;
    const name = equals === -1 ? flag : flag.slice(0, equals);
    const value = (): string | null => (equals === -1 ? (rest.shift() ?? null) : flag.slice(equals + 1));
    const need = (): string => {
      const given = value();
      if (given === null) {
        throw new Error(`${name} needs a value.`);
      }
      return given;
    };
    try {
      switch (name) {
        case "--help":
        case "-h":
          return { kind: "help" };
        case "--version":
        case "-v":
          return { kind: "version" };
        case "--vault":
          options.vault = need();
          break;
        case "--obsidian-version":
          options.obsidianVersion = need();
          break;
        case "--obsidian-app":
          options.obsidianApp = need();
          break;
        case "--plugin":
          options.plugins.push(need());
          break;
        case "--command":
          options.commands.push(need());
          break;
        case "--eval":
          options.evalFile = need();
          break;
        case "--settings": {
          const pair = need();
          const at = pair.indexOf("=");
          if (at < 1 || at === pair.length - 1) {
            throw new Error(`--settings is written as plugin-id=file.json, not "${pair}".`);
          }
          options.settings[pair.slice(0, at)] = pair.slice(at + 1);
          break;
        }
        case "--arg": {
          const pair = need();
          const at = pair.indexOf("=");
          if (at < 1) {
            throw new Error(`--arg is written as key=value, not "${pair}".`);
          }
          options.args[pair.slice(0, at)] = valueOf(pair.slice(at + 1));
          break;
        }
        case "--args-file": {
          const file = need();
          let read: unknown;
          try {
            read = readJson(file);
          } catch (error) {
            throw new Error(`"${file}" could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (typeof read !== "object" || read === null || Array.isArray(read)) {
            throw new Error(`"${file}" has to hold an object, as {"key": "value"}.`);
          }
          Object.assign(options.args, read);
          break;
        }
        case "--config":
          options.config = need();
          break;
        case "--wait": {
          const wait = need();
          if (wait !== "auto" && wait !== "none" && !(wait.startsWith("file:") && wait.length > 5)) {
            throw new Error(`--wait is auto, none, or file:<path>, not "${wait}".`);
          }
          options.wait = wait;
          break;
        }
        case "--timeout": {
          const seconds = Number(need());
          if (!Number.isFinite(seconds) || seconds <= 0) {
            throw new Error("--timeout is a number of seconds above zero.");
          }
          if (seconds > LONGEST_TIMEOUT) {
            throw new Error(`--timeout can be ${String(LONGEST_TIMEOUT)} seconds (about 24 days) at most.`);
          }
          options.timeout = seconds;
          break;
        }
        case "--no-vault-plugins":
          options.vaultPlugins = false;
          break;
        case "--keep":
          options.keep = true;
          break;
        case "--cache-dir":
          options.cacheDir = need();
          break;
        case "--github-token":
          options.githubToken = need();
          break;
        case "--json":
          options.json = true;
          break;
        case "--verbose":
          options.verbose = true;
          break;
        case "--show":
          options.show = true;
          break;
        case "--all":
          if (kind !== "commands") {
            throw new Error("--all goes with commands: obsidian-cmd-runner commands --all.");
          }
          all = true;
          break;
        default:
          throw new Error(`"${flag}" is not an option. See --help.`);
      }
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }
  if (kind === "commands") {
    if (options.commands.length > 0 || options.evalFile !== null) {
      return { kind: "error", message: "commands lists what can be run, and runs nothing: leave --command and --eval out." };
    }
    return { kind, options, all };
  }
  return { kind, options };
}
