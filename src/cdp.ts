/**
 * Talks to the page of Obsidian the way a browser's developer tools do (the
 * Chrome DevTools Protocol). Only what a run needs: find the page, run
 * JavaScript in it, and hear what it writes to its console.
 */

/**
 * Thrown when the page was loaded anew while code ran in it. Obsidian does
 * that at times while it starts. What was asked has to be asked again.
 */
export class PageReloaded extends Error {}

export interface Page {
  /** Runs JavaScript in the page and gives back what it returns. A promise it returns is waited for. */
  evaluate<T>(expression: string): Promise<T>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Called for every line the page writes to its console, and for every error that nothing caught */
  onConsole(listener: (kind: string, text: string) => void): void;
  /** Resolves when the page is gone: Obsidian was closed or has crashed */
  closed: Promise<void>;
  close(): void;
}

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const sleep = (millis: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, millis));

/**
 * Waits for the page of a vault to be there, and connects to it. The page
 * of the list of vaults is not it: Obsidian shows that one when the vault
 * could not be opened.
 */
export async function connect(port: number, within: number, hasEnded: () => string | null): Promise<Page> {
  const until = Date.now() + within;
  let seenStarter = 0;
  for (;;) {
    const ended = hasEnded();
    if (ended !== null) {
      throw new Error(`Obsidian ended before it was ready. ${ended}`);
    }
    let targets: Target[] = [];
    try {
      targets = (await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()) as Target[];
    } catch {
      // Not listening yet
    }
    const page = targets.find((target) => target.type === "page" && target.url.startsWith("app://obsidian.md/index.html"));
    if (page?.webSocketDebuggerUrl !== undefined) {
      return open(page.webSocketDebuggerUrl);
    }
    if (targets.some((target) => target.type === "page" && target.url.includes("starter"))) {
      // The list of vaults shows for a moment while a vault opens: only when it stays, the vault did not open
      if (++seenStarter > 40) {
        throw new Error("Obsidian shows its list of vaults: the vault could not be opened.");
      }
    }
    if (Date.now() > until) {
      throw new Error(`Obsidian did not show a vault within ${String(Math.round(within / 1000))} seconds.`);
    }
    await sleep(100);
  }
}

function open(address: string): Promise<Page> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(address);
    let next = 1;
    const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const listeners: ((kind: string, text: string) => void)[] = [];
    let gone: () => void = () => undefined;
    const closed = new Promise<void>((done) => {
      gone = done;
    });

    const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
      new Promise((done, fail) => {
        const id = next++;
        waiting.set(id, { resolve: done, reject: fail });
        socket.send(JSON.stringify({ id, method, params }));
      });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: { type?: string; args?: { value?: unknown; description?: string }[]; exceptionDetails?: { text?: string; exception?: { description?: string } } };
      };
      if (message.id !== undefined) {
        const asked = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.error !== undefined) {
          asked?.reject(new Error(message.error.message));
        } else {
          asked?.resolve(message.result);
        }
      } else if (message.method === "Runtime.consoleAPICalled") {
        const text = (message.params?.args ?? []).map((arg) => (typeof arg.value === "string" ? arg.value : (arg.description ?? JSON.stringify(arg.value)))).join(" ");
        listeners.forEach((listener) => listener(message.params?.type ?? "log", text));
      } else if (message.method === "Runtime.exceptionThrown") {
        const details = message.params?.exceptionDetails;
        listeners.forEach((listener) => listener("error", details?.exception?.description ?? details?.text ?? "An error"));
      }
    });
    socket.addEventListener("close", () => {
      for (const asked of waiting.values()) {
        asked.reject(new Error("Obsidian was closed."));
      }
      waiting.clear();
      gone();
    });
    socket.addEventListener("error", () => reject(new Error("The page of Obsidian could not be reached.")));
    socket.addEventListener("open", () => {
      const page: Page = {
        send,
        closed,
        onConsole: (listener) => listeners.push(listener),
        close: () => socket.close(),
        async evaluate<T>(expression: string): Promise<T> {
          let reply: { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
          try {
            reply = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as typeof reply;
          } catch (error) {
            // The answer to code that ran while the page was loaded anew is an error of the protocol, not of the code
            if (error instanceof Error && /Execution context was destroyed|Cannot find context|Inspected target navigated/i.test(error.message)) {
              throw new PageReloaded(error.message);
            }
            throw error;
          }
          if (reply.exceptionDetails !== undefined) {
            throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? "The code threw an error.");
          }
          return reply.result?.value as T;
        },
      };
      void send("Runtime.enable").then(() => resolve(page), reject);
    });
  });
}
