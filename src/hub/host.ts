/**
 * `room host <name>`: the human's side of a hosted room. Prints what members
 * post, as markdown, and posts what the human types. Members are sessions
 * that joined through `room mcp`; nothing here starts or stops them.
 */
import { createInterface } from "node:readline";
import { HARNESS_COLOURS } from "../ui/colours.js";
import { MarkdownLines } from "../ui/markdown.js";
import { Hub, type HubMessage } from "./hub.js";

export async function runHost(name: string, human: string, o: { colour?: boolean; history?: number } = {}): Promise<void> {
  const hub = new Hub(name, human);
  const info = await hub.start();
  const colour = o.colour ?? (process.stdout.isTTY && !process.env.NO_COLOR);
  const paint = (who: string, t: string) => {
    if (!colour) return t;
    const c = who === human ? 15 : who === "room" ? 244 : (HARNESS_COLOURS[who.replace(/\d+$/, "").toLowerCase()] ?? 180);
    return `\u001b[38;5;${c}m${t}\u001b[39m`;
  };
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: colour ? "\u001b[2m›\u001b[22m " : "> " });
  const show = (m: HubMessage) => {
    if (m.from === human) return;
    const md = new MarkdownLines({ enabled: !!colour });
    const body = m.text.split("\n").map((l) => md.line(l));
    const head = m.from === "room" ? paint("room", `· ${m.text}`) : `${paint(m.from, `${m.from}>`)} ${body[0]}`;
    // On a terminal, clear the half-typed prompt line first; piped output gets plain lines.
    process.stdout.write(`${process.stdout.isTTY ? "\r\u001b[K" : ""}${head}\n${m.from === "room" ? "" : body.slice(1).map((l) => `  ${l}\n`).join("")}`);
    if (process.stdout.isTTY) rl.prompt(true);
  };
  const earlier = hub.messages.slice(-(o.history ?? 10));
  console.log(`room ${name} is hosted (127.0.0.1:${info.port}). Ask a session to join it: "join the room ${name}".`);
  console.log("Tag with @name; /who to see members; /quit to close.");
  if (earlier.length) {
    console.log(paint("room", `· the last ${earlier.length} messages:`));
    for (const m of earlier) (m.from === human ? console.log(`${paint(human, `${human}>`)} ${m.text}`) : show(m));
  }
  hub.onMessage(show);
  if (process.stdout.isTTY) rl.prompt();
  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      const t = line.trim();
      if (t === "/quit" || t === "/exit") return rl.close();
      if (t === "/who") {
        const w = hub.who();
        console.log(w.length ? w.map((m) => `- ${m.name}${m.harness ? ` (${m.harness})` : ""}: ${m.unread} unread`).join("\n") : "nobody has joined yet");
      } else if (t) hub.post(human, t);
      if (process.stdout.isTTY) rl.prompt();
    });
    rl.on("close", resolve);
    process.once("SIGTERM", () => rl.close());
  });
  hub.post("room", `${human} closed the room.`);
  await hub.stop();
}
