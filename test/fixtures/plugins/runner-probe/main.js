// A plugin for the tests of obsidian-cmd-runner: commands that end in each way a command can.
const { Notice, Plugin } = require("obsidian");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const sleep = (millis) => new Promise((resolve) => setTimeout(resolve, millis));

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

    // ---- Commands that know nothing of the run, each doing its work in another way. Each writes
    // "started" at once and what it was to write at its end, so that a run that did not wait is seen. ----
    const write = (name, text) => this.app.vault.adapter.write(name, text);
    const file = (name) => path.join(this.app.vault.adapter.getBasePath(), name);

    // An async callback: Obsidian drops the promise it gives back
    this.addCommand({
      id: "quiet-async",
      name: "Quiet: async",
      callback: async () => {
        await write("quiet-async.txt", "started");
        await sleep(300);
        await write("quiet-async.txt", "half");
        await sleep(200);
        await write("quiet-async.txt", "done");
      },
    });
    // The work is started and let go: nothing is given back at all
    this.addCommand({
      id: "quiet-dropped",
      name: "Quiet: dropped",
      callback: () => {
        const work = async () => {
          await write("quiet-dropped.txt", "started");
          await Promise.all([sleep(250), sleep(400)]);
          await write("quiet-dropped.txt", "done");
        };
        void work();
      },
    });
    // No promise anywhere: timers and the callbacks of Node.js
    this.addCommand({
      id: "quiet-callbacks",
      name: "Quiet: callbacks",
      callback: () => {
        fs.writeFile(file("quiet-callbacks.txt"), "started", () => {
          setTimeout(() => {
            fs.writeFile(file("quiet-callbacks.txt"), "half", () => {
              setTimeout(() => fs.writeFile(file("quiet-callbacks.txt"), "done", () => undefined), 250);
            });
          }, 250);
        });
      },
    });
    // Another program does the work, and what it says is written when it has ended
    this.addCommand({
      id: "quiet-program",
      name: "Quiet: program",
      callback: () => {
        fs.writeFileSync(file("quiet-program.txt"), "started");
        const program = spawn("sh", ["-c", "sleep 0.6; echo by the program"]);
        let said = "";
        program.stdout.on("data", (chunk) => (said += String(chunk)));
        program.on("close", (code) => fs.writeFileSync(file("quiet-program.txt"), `done ${String(code)} ${said.trim()}`));
      },
    });
    // Waits for the page to be drawn, and for something fetched
    this.addCommand({
      id: "quiet-page",
      name: "Quiet: page",
      callback: async () => {
        await write("quiet-page.txt", "started");
        for (let turn = 0; turn < 3; turn++) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        const fetched = await (await fetch("data:text/plain,fetched")).text();
        await sleep(100);
        await write("quiet-page.txt", "done " + fetched);
      },
    });
    // Fails after it has started, with nothing to catch it
    this.addCommand({
      id: "quiet-rejects",
      name: "Quiet: rejects",
      callback: async () => {
        await sleep(150);
        throw new Error("The probe broke after it had started.");
      },
    });
    // Fails at once
    this.addCommand({
      id: "quiet-throws",
      name: "Quiet: throws",
      callback: () => {
        throw new Error("The probe broke at once.");
      },
    });
    // Leaves things behind that never end, and is done all the same
    this.addCommand({
      id: "quiet-leaves",
      name: "Quiet: leaves",
      callback: async () => {
        this.registerInterval(window.setInterval(() => void sleep(1), 50));
        setTimeout(() => undefined, 5 * 60 * 1000);
        // A promise that is never kept, and that nothing holds
        void new Promise(() => undefined).then(() => write("quiet-leaves.txt", "never"));
        new Notice("The probe leaves things behind.", 8000);
        await sleep(200);
        await write("quiet-leaves.txt", "done");
      },
    });
    // Waits for a click that nobody is there to make
    this.addCommand({
      id: "quiet-asks",
      name: "Quiet: asks",
      callback: async () => {
        const button = document.body.createEl("button", { text: "Go on" });
        await new Promise((resolve) => button.addEventListener("click", resolve));
        await write("quiet-asks.txt", "done");
      },
    });
  }
};
