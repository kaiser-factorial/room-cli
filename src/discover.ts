/**
 * What the harnesses on this machine already have set up: skills (folders
 * with a SKILL.md) and MCP servers, read from each harness's own config.
 * The menu lists them; the room can share them with every seat.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { parse } from "smol-toml";

export interface Skill {
  name: string;
  description: string;
  /** Which harness's config it came from: claude, codex, gemini, hermes, or shared. */
  harness: string;
  /** The folder holding its SKILL.md. */
  dir: string;
}

export interface McpServerEntry {
  name: string;
  harness: string;
  source: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

interface Where {
  home?: string;
  cwd?: string;
}

/** Skill folders: `<root>/<name>/SKILL.md`, and in plugin trees any `skills/<name>/SKILL.md` a few levels down. */
export function findSkills(o: Where = {}): Skill[] {
  const home = o.home ?? homedir();
  const cwd = o.cwd ?? process.cwd();
  const roots: Array<[string, string, number]> = [
    ["claude", join(cwd, ".claude", "skills"), 0],
    ["claude", join(home, ".claude", "skills"), 0],
    ["claude", join(home, ".claude", "plugins"), 5],
    ["codex", join(cwd, ".codex", "skills"), 0],
    ["codex", join(home, ".codex", "skills"), 0],
    ["gemini", join(home, ".gemini", "skills"), 0],
    ["hermes", join(home, ".hermes", "skills"), 1],
    ["shared", join(cwd, ".agents", "skills"), 0],
    ["shared", join(home, ".agents", "skills"), 0],
    ["shared", join(home, ".config", "room", "skills"), 0],
  ];
  const out: Skill[] = [];
  const seen = new Set<string>();
  for (const [harness, root, depth] of roots) {
    for (const dir of skillDirs(root, depth)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      const meta = frontmatter(readFileSync(join(dir, "SKILL.md"), "utf8"));
      out.push({ name: meta.name ?? dir.split(/[\\/]/).pop()!, description: meta.description ?? "", harness, dir });
    }
  }
  return out;
}

function skillDirs(root: string, depth: number): string[] {
  if (!isDir(root)) return [];
  const found: string[] = [];
  const walk = (dir: string, left: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".") || n === "node_modules") continue;
      const p = join(dir, n);
      if (!isDir(p)) continue;
      if (existsSync(join(p, "SKILL.md"))) found.push(p);
      else if (left > 0) walk(p, left - 1);
    }
  };
  walk(root, depth);
  return found.sort();
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `name:` and `description:` from a SKILL.md's YAML front matter. */
export function frontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const get = (key: string) => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(m[1])?.[1]?.trim();
    return line ? line.replace(/^["']|["']$/g, "") : undefined;
  };
  return { name: get("name"), description: get("description") };
}

/** MCP servers configured for Claude Code, Codex, and Gemini/agy. */
export function findMcpServers(o: Where = {}): McpServerEntry[] {
  const home = o.home ?? homedir();
  const cwd = o.cwd ?? process.cwd();
  const out: McpServerEntry[] = [];
  const fromJson = (harness: string, path: string, pick: (doc: Record<string, unknown>) => unknown[]) => {
    const doc = readJson(path);
    if (!doc) return;
    for (const table of pick(doc)) {
      if (!table || typeof table !== "object") continue;
      for (const [name, v] of Object.entries(table as Record<string, Record<string, unknown>>)) out.push(entry(name, harness, path, v));
    }
  };
  const claudeJson = join(home, ".claude.json");
  fromJson("claude", claudeJson, (d) => [d.mcpServers, (d.projects as Record<string, { mcpServers?: unknown }> | undefined)?.[cwd]?.mcpServers]);
  fromJson("claude", join(cwd, ".mcp.json"), (d) => [d.mcpServers]);
  fromJson("gemini", join(home, ".gemini", "settings.json"), (d) => [d.mcpServers]);
  const codex = join(home, ".codex", "config.toml");
  if (existsSync(codex)) {
    try {
      const doc = parse(readFileSync(codex, "utf8")) as { mcp_servers?: Record<string, Record<string, unknown>> };
      for (const [name, v] of Object.entries(doc.mcp_servers ?? {})) out.push(entry(name, "codex", codex, v));
    } catch {
      /* a config the harness itself would reject */
    }
  }
  return out;
}

function entry(name: string, harness: string, source: string, v: Record<string, unknown>): McpServerEntry {
  const strs = (x: unknown) => (Array.isArray(x) ? x.map(String) : undefined);
  const env = v.env && typeof v.env === "object" ? Object.fromEntries(Object.entries(v.env as object).map(([k, x]) => [k, String(x)])) : undefined;
  const url = typeof v.url === "string" ? v.url : typeof v.httpUrl === "string" ? v.httpUrl : undefined;
  return { name, harness, source, command: typeof v.command === "string" ? v.command : undefined, args: strs(v.args), env, url };
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Which harness a seat runs, from its command, so a server is not handed back to the harness that has it. */
export function harnessOf(command: string): string {
  const c = command.toLowerCase();
  if (c.includes("claude")) return "claude";
  if (c.includes("codex")) return "codex";
  if (c.includes("gemini") || c.includes("antigravity") || c.includes("agy")) return "gemini";
  if (c.includes("hermes")) return "hermes";
  return c;
}

/** A skill for a seat to read: its SKILL.md and the files beside it. */
export function readSkill(skill: Skill, maxFiles = 50): string {
  const body = readFileSync(join(skill.dir, "SKILL.md"), "utf8");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      if (files.length >= maxFiles) return;
      const p = join(dir, n);
      if (isDir(p)) walk(p);
      else if (n !== "SKILL.md") files.push(relative(skill.dir, p));
    }
  };
  walk(skill.dir);
  return [
    `Skill ${skill.name} (from ${skill.harness}), in ${skill.dir}:`,
    "",
    body.trim(),
    files.length ? `\nFiles beside it (read them from ${skill.dir}):\n${files.map((f) => `- ${f}`).join("\n")}` : "",
  ].join("\n");
}

/**
 * The `skills` tool's answer: matches for a query, at most `max`, one short
 * line each; without a query, a count by harness and a sample, since a
 * machine can have hundreds and a tool result has a size limit.
 */
export function searchSkills(all: Skill[], query?: string, max = 40): string {
  if (!all.length) return "No skills are shared in this room.";
  const line = (k: Skill) => {
    const d = k.description.replace(/\s+/g, " ").trim();
    return `- ${k.name} (${k.harness}): ${d.length > 120 ? d.slice(0, 119) + "…" : d || "no description"}`;
  };
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) {
    const by = new Map<string, number>();
    for (const k of all) by.set(k.harness, (by.get(k.harness) ?? 0) + 1);
    const counts = [...by].map(([h, n]) => `${n} from ${h}`).join(", ");
    if (all.length <= max) return `${all.length} skills (${counts}):\n${all.map(line).join("\n")}`;
    return `${all.length} skills (${counts}). Pass a query to search them, e.g. {"query": "pdf"}. The first ${max}:\n${all.slice(0, max).map(line).join("\n")}`;
  }
  const hits = all.filter((k) => {
    const hay = `${k.name} ${k.description}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  // Name matches first: "pdf" should find the pdf skill before one that mentions PDFs.
  hits.sort((a, b) => Number(words.some((w) => b.name.toLowerCase().includes(w))) - Number(words.some((w) => a.name.toLowerCase().includes(w))));
  if (!hits.length) return `No skill matches "${query}" (of ${all.length}). Try fewer or other words.`;
  return `${hits.length} match "${query}"${hits.length > max ? `; the first ${max}` : ""}:\n${hits.slice(0, max).map(line).join("\n")}`;
}
