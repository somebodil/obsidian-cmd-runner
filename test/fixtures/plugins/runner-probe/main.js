// A plugin for the tests of obsidian-cmd-runner: commands that end in each way a command can.
const { Plugin } = require("obsidian");

module.exports = class RunnerProbe extends Plugin {
  onload() {
    // Takes part in the run: says what it found, after waiting as real work does
    this.addCommand({
      id: "report",
      name: "Report",
      callback: async () => {
        const runner = window.obsidianCmdRunner;
        runner?.claim();
        try {
          await new Promise((resolve) => setTimeout(resolve, 200));
          const notes = this.app.vault.getMarkdownFiles();
          const links = notes.reduce((sum, note) => sum + (this.app.metadataCache.getFileCache(note)?.links?.length ?? 0), 0);
          runner?.log(`${notes.length} notes`);
          await this.app.vault.adapter.write("probe-report.json", JSON.stringify({ notes: notes.length }));
          runner?.done({ notes: notes.map((note) => note.path).sort(), links, args: runner.args, plugins: Object.keys(this.app.plugins.plugins).sort() });
        } catch (error) {
          runner?.fail(error);
        }
      },
    });
    // Takes part, and fails
    this.addCommand({
      id: "fail",
      name: "Fail",
      callback: () => {
        const runner = window.obsidianCmdRunner;
        runner?.claim();
        setTimeout(() => runner?.fail(new Error("The probe was asked to fail.")), 50);
      },
    });
    // Takes part, and never says that it is done
    this.addCommand({
      id: "hang",
      name: "Hang",
      callback: () => {
        const runner = window.obsidianCmdRunner;
        runner?.claim();
        runner?.log("hanging");
      },
    });
    // Knows nothing of the run: writes a file a little later
    this.addCommand({
      id: "plain",
      name: "Plain",
      callback: () => {
        setTimeout(() => void this.app.vault.adapter.write("probe-plain.txt", "written"), 400);
      },
    });
    // Says that it does not apply
    this.addCommand({ id: "never", name: "Never", checkCallback: () => false });
  }
};
