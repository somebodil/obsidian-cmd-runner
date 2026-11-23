#!/usr/bin/env node
// As a package from npm, the program is the JavaScript in `dist`. In a copy of the repository there is
// no `dist`: there Node.js (from 22.18 on) runs the TypeScript as it is, so that nothing has to be built.
const { main } = await import("../dist/cli.js").catch(() => import("../src/cli.ts"));

process.exitCode = await main(process.argv.slice(2));
