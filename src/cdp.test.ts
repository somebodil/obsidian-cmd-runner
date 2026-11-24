import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { describe, it } from "node:test";
import { connect, PageClosed } from "./cdp.ts";

/**
 * Stands in for the port of Obsidian: lists one page, and speaks on its
 * socket as far as these tests need. What is asked is answered with `{}`,
 * but for a method that starts with `Never`: that one is left unanswered.
 */
async function obsidianPort(): Promise<{ port: number; drop(): void; close(): Promise<void> }> {
  const sockets: Duplex[] = [];
  const server = createServer((_request, reply) => {
    const { port } = server.address() as AddressInfo;
    reply.end(JSON.stringify([{ type: "page", url: "app://obsidian.md/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/page` }]));
  });
  server.on("upgrade", (request, socket: Duplex) => {
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"] ?? ""}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.push(socket);
    let got = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      got = Buffer.concat([got, chunk]);
      // A frame from a client: two bytes, a length of two more when it is 126, four bytes to unmask with, and the text
      for (;;) {
        if (got.length < 2) {
          return;
        }
        const short = got.readUInt8(1) & 0x7f;
        const head = short === 126 ? 4 : 2;
        if (got.length < head) {
          return;
        }
        const length = short === 126 ? got.readUInt16BE(2) : short;
        if (got.length < head + 4 + length) {
          return;
        }
        const mask = got.subarray(head, head + 4);
        const text = Buffer.from(got.subarray(head + 4, head + 4 + length).map((byte, at) => byte ^ mask.readUInt8(at % 4)));
        const isText = (got.readUInt8(0) & 0x0f) === 1;
        got = got.subarray(head + 4 + length);
        if (!isText) {
          // The client says goodbye
          socket.end();
          return;
        }
        const asked = JSON.parse(text.toString()) as { id: number; method: string };
        if (!asked.method.startsWith("Never")) {
          const answer = Buffer.from(JSON.stringify({ id: asked.id, result: {} }));
          socket.write(Buffer.concat([Buffer.from([0x81, answer.length]), answer]));
        }
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // A test that fails is not to keep the tests from ending
  server.unref();
  return {
    port: (server.address() as AddressInfo).port,
    // As when Obsidian crashes: the socket is gone without a word
    drop: () => sockets.forEach((socket) => socket.destroy()),
    close: () =>
      new Promise((resolve) => {
        sockets.forEach((socket) => socket.destroy());
        server.close(() => resolve());
      }),
  };
}

describe("a page", { timeout: 60_000 }, () => {
  it("answers what is asked of it", async () => {
    const obsidian = await obsidianPort();
    try {
      const page = await connect(obsidian.port, 5000, () => null);
      assert.deepEqual(await page.send("Any.method"), {});
      page.close();
      await page.closed;
    } finally {
      await obsidian.close();
    }
  });

  it("gives up what was asked and not answered when Obsidian is gone", async () => {
    const obsidian = await obsidianPort();
    try {
      const page = await connect(obsidian.port, 5000, () => null);
      const asked = page.send("Never.answered");
      obsidian.drop();
      await assert.rejects(asked, PageClosed);
    } finally {
      await obsidian.close();
    }
  });

  it("says at once that Obsidian was closed when something is asked of a page that is gone", async () => {
    const obsidian = await obsidianPort();
    try {
      const page = await connect(obsidian.port, 5000, () => null);
      obsidian.drop();
      await page.closed;
      await assert.rejects(page.send("Any.method"), PageClosed);
      await assert.rejects(page.evaluate("1 + 1"), PageClosed);
    } finally {
      await obsidian.close();
    }
  });
});
