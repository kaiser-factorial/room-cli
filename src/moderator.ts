import { ConfigError } from "./config.js";

/**
 * The moderator: when one of the room's limits trips (the wake cap, the
 * echo pause, the post limit), something with judgment decides whether the
 * move is fine after all. A cheap model through OpenRouter by default; the
 * human when there is no key or the model cannot answer.
 */

export type LimitKind = "cap" | "echo" | "post";

export interface LimitCase {
  kind: LimitKind;
  /** The seat whose move tripped the limit. */
  from: string;
  /** The seat it would wake, for cap and echo. */
  to?: string;
  /** What tripped, in a sentence, e.g. "6 seat-to-seat wakes this thread (cap 6)". */
  detail: string;
  /** The last few messages, rendered `[name]: text`. */
  recent: string;
  /** For a post: what the seat wants to post. */
  text?: string;
}

export interface Verdict {
  verdict: "allow" | "hold" | "nudge";
  /** One short line, shown to the human and kept in the transcript. */
  reason: string;
  /** For nudge: what to tell the seat on its next turn. */
  note?: string;
  /** Who decided: the model's id, or "human". */
  by: string;
}

export interface Moderator {
  readonly label: string;
  decide(c: LimitCase): Promise<Verdict>;
}

/** The human decides: asked once per case. Without a way to ask, everything holds. */
export class HumanModerator implements Moderator {
  readonly label = "you";
  constructor(private readonly ask?: (question: string) => Promise<boolean>) {}
  async decide(c: LimitCase): Promise<Verdict> {
    if (!this.ask) return { verdict: "hold", reason: "no moderator; held", by: "human" };
    const what =
      c.kind === "post"
        ? `${c.from} wants to post past its limit (${c.detail}): ${c.text}`
        : `${c.from} → ${c.to}: ${c.detail}`;
    const yes = await this.ask(`${what}. Let it through?`);
    return { verdict: yes ? "allow" : "hold", reason: yes ? "you let it through" : "you held it", by: "human" };
  }
}

const SYSTEM = `You moderate a group chat between one human and several AI coding agents ("seats"). The room has simple limits so the seats cannot run away: a cap on how many times seats wake each other per human message, a pause when two seats trade short replies back and forth, and a limit on mid-turn posts. A limit just tripped. Decide whether this move is worth letting through.

Allow it when the exchange is making progress: converging on a fix, handing off real work, a question that needs its answer, a post that tells others something they need now.
Hold it when it is going in circles: agreeing, thanking, restating, asking each other to go first, status noise, or anything the human would be annoyed to pay for.
Nudge when it is useful but drifting: let it through and tell the seat, in one sentence, what would make the next turn worth it.

Reply with JSON only: {"verdict": "allow" | "hold" | "nudge", "reason": "<under 15 words, for the human>", "note": "<for nudge: one sentence to the seat>"}`;

/** A model on OpenRouter decides; the fallback decides when it cannot. */
export class OpenRouterModerator implements Moderator {
  readonly label: string;
  constructor(
    private readonly opts: {
      apiKey: string;
      model: string;
      fallback: Moderator;
      timeoutMs?: number;
      fetch?: typeof fetch;
      onError?: (message: string) => void;
    },
  ) {
    this.label = opts.model;
  }

  async decide(c: LimitCase): Promise<Verdict> {
    try {
      return await this.ask(c);
    } catch (err) {
      this.opts.onError?.(`moderator ${this.opts.model} could not answer (${(err as Error).message}); asking ${this.opts.fallback.label}`);
      return this.opts.fallback.decide(c);
    }
  }

  private async ask(c: LimitCase): Promise<Verdict> {
    const user = [
      `Limit: ${c.kind} — ${c.detail}`,
      c.kind === "post" ? `${c.from} wants to post: ${c.text}` : `Move: ${c.from} is waking ${c.to}.`,
      `Recent messages:\n${c.recent || "(none)"}`,
    ].join("\n\n");
    const res = await (this.opts.fetch ?? fetch)("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "room",
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: user },
        ],
        max_tokens: 200,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return parseVerdict(body.choices?.[0]?.message?.content ?? "", this.opts.model);
  }
}

/** The verdict in a model's reply: the first JSON object in it. Throws when there is none. */
export function parseVerdict(content: string, by: string): Verdict {
  const json = content.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error("no JSON in the reply");
  const v = JSON.parse(json) as { verdict?: string; reason?: string; note?: string };
  if (v.verdict !== "allow" && v.verdict !== "hold" && v.verdict !== "nudge") throw new Error(`bad verdict ${v.verdict}`);
  const reason = String(v.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 160) || v.verdict;
  const note = v.verdict === "nudge" ? String(v.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || undefined : undefined;
  return { verdict: v.verdict, reason, note, by };
}

export const DEFAULT_MODERATOR_MODEL = "anthropic/claude-haiku-4.5";

/**
 * The moderator a spec names: "off" (limits just hold), "you" (asked each
 * time), a model id on OpenRouter, or "auto": the default model when
 * OPENROUTER_API_KEY is set, else you. A model falls back to you.
 */
export function moderatorFor(
  spec: string,
  o: { ask?: (question: string) => Promise<boolean>; status?: (line: string) => void; env?: NodeJS.ProcessEnv },
): Moderator | undefined {
  const env = o.env ?? process.env;
  const human = new HumanModerator(o.ask);
  if (spec === "off") return undefined;
  if (spec === "you" || spec === "human") return human;
  const key = env.OPENROUTER_API_KEY;
  if (spec === "auto" && !key) return human;
  if (!key) throw new ConfigError(`the moderator ${spec} needs OPENROUTER_API_KEY`);
  return new OpenRouterModerator({
    apiKey: key,
    model: spec === "auto" ? (env.ROOM_MODERATOR_MODEL ?? DEFAULT_MODERATOR_MODEL) : spec,
    fallback: human,
    onError: o.status,
  });
}
