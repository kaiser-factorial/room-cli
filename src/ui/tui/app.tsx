/**
 * The room in Ink. Finished blocks go to <Static>, so they land in the
 * terminal's own scrollback (scroll, search, and copy work as usual); what
 * is still happening is redrawn below them: each seat mid-turn, a status
 * bar with what every seat is doing, and the input, or a seat's question.
 */
import { Box, Static, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useState } from "react";
import type { Block, Part, TuiStore } from "./store.js";
import { renderMarkdown } from "../markdown.js";

export interface SeatChip {
  name: string;
  /** 256-colour index, when the seat has one. */
  colour?: number;
  benched: boolean;
  background: boolean;
}

export interface AppProps {
  store: TuiStore;
  human: string;
  room: string;
  /** Seats and flags, read on every redraw. */
  seats: () => SeatChip[];
  flags: () => string[];
  onSubmit: (text: string) => void;
  /** Lines a live block keeps on screen; the rest scrolls into view when it finishes. */
  liveLines?: number;
}

const colourOf = (chip?: SeatChip) => (chip?.colour !== undefined ? `ansi256(${chip.colour})` : "cyan");

function PartView({ part }: { part: Part }) {
  if (part.type === "tool") return <Text dimColor>{part.line}</Text>;
  if (part.type === "thought") return <Text dimColor italic>{`thinking: ${part.text.replace(/\s+/g, " ").trim()}`}</Text>;
  return <Text>{renderMarkdown(part.text.replace(/\n+$/, ""))}</Text>;
}

/** Only the last `max` lines of a growing block, so a long reply does not push the input off screen. */
function tail(parts: Part[], max: number): { parts: Part[]; hidden: number } {
  const lines = parts.map((p) => (p.type === "text" ? p.text.split("\n").length : 1));
  let total = 0;
  let from = parts.length;
  while (from > 0 && total + lines[from - 1] <= max) total += lines[--from];
  if (from === parts.length && parts.length) {
    // One part longer than the window: show its end.
    const last = parts.at(-1)!;
    if (last.type === "text") {
      const all = last.text.split("\n");
      return { parts: [{ type: "text", text: all.slice(-max).join("\n") }], hidden: all.length - max + parts.length - 1 };
    }
  }
  const hidden = lines.slice(0, from).reduce((a, b) => a + b, 0);
  return { parts: parts.slice(from), hidden };
}

export function BlockView({ block, chip, human, live, maxLines }: { block: Block; chip?: SeatChip; human: string; live?: boolean; maxLines?: number }) {
  if (block.kind === "status") return <Text dimColor>{`  [room] ${(block.parts[0] as { text: string }).text}`}</Text>;
  if (block.kind === "info") {
    return (
      <Box flexDirection="column" marginTop={1}>
        {block.parts.map((p, i) => (
          <PartView key={i} part={p} />
        ))}
      </Box>
    );
  }
  if (block.kind === "human") {
    return (
      <Box marginTop={1}>
        <Text bold>{`${human}> `}</Text>
        <Text>{(block.parts[0] as { text: string }).text}</Text>
      </Box>
    );
  }
  const shown = live && maxLines ? tail(block.parts, maxLines) : { parts: block.parts, hidden: 0 };
  const colour = colourOf(chip);
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle={block.bg ? "bold" : undefined}
      borderLeft={block.bg}
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      borderColor={colour}
      paddingLeft={block.bg ? 1 : 0}
    >
      <Text>
        <Text bold color={colour}>
          {block.seat}
        </Text>
        {block.bg ? <Text dimColor> (background)</Text> : null}
        {live ? <Text dimColor> …</Text> : null}
      </Text>
      {shown.hidden > 0 ? <Text dimColor>{`  ⋮ ${shown.hidden} more lines above`}</Text> : null}
      {shown.parts.map((p, i) => (
        <PartView key={i} part={p} />
      ))}
    </Box>
  );
}

function StatusBar({ chips, doing, flags, room }: { chips: SeatChip[]; doing: Map<string, string>; flags: string[]; room: string }) {
  return (
    <Box marginTop={1} flexWrap="wrap" columnGap={2}>
      <Text dimColor>{room}</Text>
      {chips.map((c) => {
        const now = c.benched ? "benched" : doing.get(c.name) ?? (c.background ? "working (bg)" : "idle");
        const busy = now !== "idle" && now !== "benched";
        return (
          <Text key={c.name}>
            <Text color={c.benched ? "gray" : colourOf(c)} bold={busy}>
              {busy ? "● " : "○ "}
              {c.name}
            </Text>
            <Text dimColor>{` ${now}`}</Text>
          </Text>
        );
      })}
      {flags.map((f) => (
        <Text key={f} dimColor>
          {f}
        </Text>
      ))}
    </Box>
  );
}

function QuestionBar({ store, chips }: { store: TuiStore; chips: SeatChip[] }) {
  const ask = store.asks[0];
  useInput((input) => {
    if (!ask) return;
    const choice = ({ a: "allow", A: "allow_always", d: "deny", c: "cancel" } as const)[input as "a" | "A" | "d" | "c"];
    if (choice) ask.resolve(choice);
  });
  if (!ask) return null;
  const chip = chips.find((c) => c.name === ask.req.seat);
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={colourOf(chip)} paddingX={1}>
      <Text>
        <Text bold>? </Text>
        <Text bold color={colourOf(chip)}>
          {ask.req.seat}
        </Text>
        {ask.req.kind === "limit" ? ` ${ask.req.title}` : ` wants: ${ask.req.title}${ask.req.kind ? ` [${ask.req.kind}]` : ""}`}
        {store.asks.length > 1 ? <Text dimColor>{`  (+${store.asks.length - 1} waiting)`}</Text> : null}
      </Text>
      {ask.preview.slice(0, 12).map((l, i) => (
        <Text key={i} dimColor>
          {l}
        </Text>
      ))}
      <Text dimColor>{ask.req.kind === "limit" ? "a let it through · d hold" : "a allow · A always (room rule) · d deny · c cancel turn"}</Text>
    </Box>
  );
}

export function App({ store, human, room, seats, flags, onSubmit, liveLines = 14 }: AppProps) {
  const [, setTick] = useState(0);
  const [value, setValue] = useState("");
  useEffect(() => {
    const redraw = () => setTick((t) => t + 1);
    store.on("change", redraw);
    return () => {
      store.off("change", redraw);
    };
  }, [store]);
  const chips = seats();
  const chipOf = (b: Block) => chips.find((c) => c.name === b.seat);
  const asking = store.asks.length > 0;
  return (
    <>
      <Static items={[...store.finished]}>
        {(b) => <BlockView key={b.id} block={b} chip={chipOf(b)} human={human} />}
      </Static>
      {[...store.live.values()].map((b) => (
        <BlockView key={b.id} block={b} chip={chipOf(b)} human={human} live maxLines={liveLines} />
      ))}
      <StatusBar chips={chips} doing={store.doing} flags={flags()} room={room} />
      {asking ? (
        <QuestionBar store={store} chips={chips} />
      ) : (
        <Box>
          <Text bold>{`${human}> `}</Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={(text) => {
              setValue("");
              onSubmit(text);
            }}
          />
        </Box>
      )}
    </>
  );
}

/** Ctrl+C, handed to the room: the first cancels a running round, a second quits. */
export function Interrupts({ onInterrupt }: { onInterrupt: () => void }) {
  useInput((input, key) => {
    if (key.ctrl && input === "c") onInterrupt();
  });
  return null;
}
