/**
 * The turn queue. Sequential mode refills it in roster order; an address
 * puts a seat at the front (phase 3); parallel mode drains it in one batch.
 */
export class Scheduler {
  private queue: string[] = [];

  constructor(readonly seats: string[]) {}

  /** Queue a round for the given seats, or every seat in roster order. */
  fill(seats?: string[]): void {
    const wanted = seats && seats.length ? seats : this.seats;
    for (const s of wanted) {
      if (!this.seats.includes(s)) throw new Error(`unknown seat: ${s}`);
      if (!this.queue.includes(s)) this.queue.push(s);
    }
  }

  /** Move a seat to the front, adding it if absent. */
  pushFront(seat: string): void {
    if (!this.seats.includes(seat)) throw new Error(`unknown seat: ${seat}`);
    this.queue = [seat, ...this.queue.filter((s) => s !== seat)];
  }

  shift(): string | undefined {
    return this.queue.shift();
  }

  clear(): void {
    this.queue = [];
  }

  get pending(): readonly string[] {
    return this.queue;
  }
}

/**
 * Every `@name` in a reply, outside code fences and inline code, that names
 * a known participant. Order of first appearance, case-insensitive. An
 * `@` glued to a preceding word (an email, a decorator) does not count.
 */
export function scanMentions(text: string, names: string[]): string[] {
  const stripped = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const found: string[] = [];
  const re = /(?:^|[\s(,;:>"'*_])@([\w-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const name = names.find((n) => n.toLowerCase() === m![1].toLowerCase());
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * A leading `@name` (or several) addresses specific seats. Returns the
 * addressed seats and the text with the addresses stripped. Case-insensitive.
 */
export function parseAddress(text: string, seats: string[]): { targets: string[]; text: string } {
  const targets: string[] = [];
  let rest = text.trimStart();
  for (;;) {
    const m = /^@([\w-]+)[,:]?\s*/.exec(rest);
    if (!m) break;
    const seat = seats.find((s) => s.toLowerCase() === m[1].toLowerCase());
    if (!seat) break;
    if (!targets.includes(seat)) targets.push(seat);
    rest = rest.slice(m[0].length);
  }
  return { targets, text: targets.length ? rest : text };
}
