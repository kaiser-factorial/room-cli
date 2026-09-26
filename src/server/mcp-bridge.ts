/**
 * stdio → HTTP bridge to the room's MCP server, for harnesses that only
 * spawn stdio MCP servers. Usage: node mcp-bridge.js <url>. Each line on
 * stdin is a JSON-RPC message, POSTed as is; each reply goes to stdout as
 * one line.
 */
import { request } from "node:http";
import { createInterface } from "node:readline";

function post(url: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

export function runBridge(url: string): void {
  const rl = createInterface({ input: process.stdin });
  let pending = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    // In order: a reply must not overtake the one before it.
    pending = pending.then(async () => {
      let id: unknown = null;
      try {
        id = (JSON.parse(line) as { id?: unknown }).id ?? null;
      } catch {
        /* the server answers the parse error */
      }
      try {
        const { status, text } = await post(url, line);
        if (text.trim()) process.stdout.write(text.trim() + "\n");
        else if (status >= 400 && id !== null) throw new Error(`room answered ${status}`);
      } catch (err) {
        if (id !== null) {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: `room unreachable: ${(err as Error).message}` } }) + "\n");
        }
      }
    });
  });
  rl.on("close", () => void pending.then(() => process.exit(0)));
}

if (process.argv[1] && /mcp-bridge\.[jt]s$/.test(process.argv[1])) {
  const url = process.argv[2];
  if (!url) {
    process.stderr.write("usage: mcp-bridge <url>\n");
    process.exit(2);
  }
  runBridge(url);
}
