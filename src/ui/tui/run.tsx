/**
 * Runs a room in the TUI: room events into the store, the human's lines
 * into the room, one at a time in the order typed (the input stays open
 * while seats work). Ctrl+C cancels the running round; a second one quits.
 */
import { render } from "ink";
import { runCommand } from "../../commands.js";
import type { HumanChoice } from "../../permissions.js";
import type { Room, RoomUI } from "../../room.js";
import type { PermissionRequestView, SeatEvent } from "../../seat/types.js";
import { seatColour } from "../colours.js";
import { HELP } from "../repl.js";
import { App, Interrupts } from "./app.js";
import type { ThoughtMode, TuiStore } from "./store.js";

export class TuiUI implements RoomUI {
  constructor(private readonly store: TuiStore) {}
  seatEvent(seat: string, ev: SeatEvent): void {
    this.store.seatEvent(seat, ev);
  }
  sideEvent(seat: string, ev: SeatEvent): void {
    this.store.seatEvent(seat, ev);
  }
  backgroundEvent(seat: string, ev: SeatEvent): void {
    this.store.seatEvent(seat, ev, true);
  }
  askHuman(req: PermissionRequestView): Promise<HumanChoice> {
    return this.store.ask(req);
  }
  status(line: string): void {
    this.store.status(line);
  }
}

/** Run until the human quits. `ready` is the room starting its seats; input waits for it. */
export async function runTui(room: Room, store: TuiStore, ready: Promise<void>): Promise<void> {
  const human = room.opts.human;
  let chain: Promise<unknown> = ready.catch((err) => store.status(`could not start: ${(err as Error).message}`));
  let lastInterrupt = 0;

  const handle = async (raw: string): Promise<void> => {
    const text = raw.trim();
    const [cmd, arg] = text.split(/\s+/);
    if (text === "" || cmd === "/next") {
      void room.continueRound().catch((err) => store.status(`error: ${(err as Error).message}`));
    } else if (cmd === "/quit" || cmd === "/q") {
      app.unmount();
    } else if (cmd === "/help") {
      store.info(HELP.split("\n"));
    } else if (cmd === "/thoughts") {
      const modes: Record<string, ThoughtMode> = { on: "full", full: "full", brief: "brief", off: "off" };
      store.thoughts = modes[arg ?? ""] ?? (store.thoughts === "brief" ? "full" : "brief");
      store.status(`thinking: ${{ brief: "one short line per stretch", full: "in full", off: "hidden" }[store.thoughts]}`);
    } else if (cmd === "/verbose") {
      store.tools.detail = arg === "off" ? "compact" : arg === "on" ? "full" : store.tools.detail === "full" ? "compact" : "full";
      store.status(`tool calls: ${store.tools.detail === "full" ? "in full as they stream" : "one line each; /show <n> for one in full"}`);
    } else if (cmd === "/show") {
      store.show(arg);
    } else if (text.startsWith("/")) {
      const lines: string[] = [];
      await runCommand(room, text, (l) => lines.push(l));
      store.info(lines);
    } else {
      // Seats answer while the input stays open: a message never waits for the last one's replies.
      void room.say(text).catch((err) => store.status(`error: ${(err as Error).message}`));
    }
  };

  const onSubmit = (text: string) => {
    // Echo now, even when a round is still running and this waits its turn.
    if (text.trim() && !text.trim().startsWith("/")) store.human(human, text.trim());
    chain = chain.then(() => handle(text)).catch((err) => store.status(`error: ${(err as Error).message}`));
  };

  const onInterrupt = () => {
    const now = Date.now();
    if (room.roundRunning && now - lastInterrupt > 1500) {
      lastInterrupt = now;
      store.status("cancelling the round (Ctrl+C again to quit)");
      void room.cancel();
      return;
    }
    app.unmount();
  };

  const app = render(
    <>
      <Interrupts onInterrupt={onInterrupt} />
      <App
        store={store}
        human={human}
        room={`room ${room.opts.name}`}
        seats={() =>
          room.opts.seats.map((s) => ({
            name: s.name,
            colour: seatColour(s),
            benched: room.benched.has(s.name),
            background: room.background.has(s.name),
          }))
        }
        flags={() =>
          [
            room.queued.length ? `next: ${room.queued.join(" → ")}` : "",
            room.mode === "parallel" ? "parallel" : "",
            room.auto ? "auto" : "",
            store.tools.detail === "full" ? "verbose" : "",
          ].filter(Boolean)
        }
        onSubmit={onSubmit}
      />
    </>,
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();
}
