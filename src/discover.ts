/**
 * What the harnesses on this machine already have set up: skills (folders
 * with a SKILL.md) and MCP servers, read from each harness's own config.
 * The menu lists them; the room can share them with every seat.
 */
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { parse } from "smol-toml";

export interface Skill {
  name: string;
  description: string;
  /** Which harness's config it came from: claude, codex, gemini, hermes, or shared. */
  harness: string;
  /** The folder holding its SKILL.md (for a command, the folder holding it). */
  dir: string;
  /** A plugin command: the .md file itself. */
  file?: string;
  kind?: "skill" | "command";
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

/**
 * Skill folders (a SKILL.md, possibly with skills nested inside it) and, in
 * plugin trees, plugin commands (`commands/<name>.md`), which carry
 * instructions the same way.
 */
export function findSkills(o: Where = {}): Skill[] {
  const home = o.home ?? homedir();
  const cwd = o.cwd ?? process.cwd();
  const roots: Array<[string, string, number]> = [
    ["claude", join(cwd, ".claude", "skills"), 2],
    ["claude", join(home, ".claude", "skills"), 2],
    ["claude", join(home, ".claude", "plugins"), 8],
    ["codex", join(cwd, ".codex", "skills"), 2],
    ["codex", join(home, ".codex", "skills"), 2],
    ["codex", join(home, ".codex", "plugins"), 8],
    ["grok", join(home, ".grok"), 6],
    ["gemini", join(home, ".gemini", "skills"), 2],
    ["hermes", join(home, ".hermes", "skills"), 3],
    ["shared", join(cwd, ".agents", "skills"), 2],
    ["shared", join(home, ".agents", "skills"), 2],
    ["shared", join(home, ".config", "room", "skills"), 2],
  ];
  const out: Skill[] = [];
  const seen = new Set<string>();
  for (const [harness, root, depth] of roots) {
    const found = walkSkills(root, depth);
    for (const dir of found.skills) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      const meta = frontmatter(readFileSync(join(dir, "SKILL.md"), "utf8"));
      out.push({ name: meta.name ?? basename(dir), description: meta.description ?? "", harness, dir });
    }
    for (const file of found.commands) {
      if (seen.has(file)) continue;
      seen.add(file);
      const meta = frontmatter(readFileSync(file, "utf8"));
      out.push({ name: basename(file, ".md"), description: meta.description ?? "", harness, dir: dirname(file), file, kind: "command" });
    }
  }
  return out;
}

/** Never worth walking into: version control, dependencies, trash, caches. */
const SKIP = new Set([".git", "node_modules", ".trash", ".Trash", "trash", ".cache", "cache", "__pycache__", ".venv", "venv"]);

function walkSkills(root: string, depth: number): { skills: string[]; commands: string[] } {
  const skills: string[] = [];
  const commands: string[] = [];
  if (!isDir(root)) return { skills, commands };
  const walk = (dir: string, left: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const n = e.name;
      if (SKIP.has(n)) continue;
      const p = join(dir, n);
      // Only directories (a linked one counts); files are never stat'ed.
      if (!e.isDirectory() && !(e.isSymbolicLink() && isDir(p))) continue;
      if (existsSync(join(p, "SKILL.md"))) skills.push(p);
      // A plugin's commands: each .md in a commands/ folder of a plugin tree.
      if (n === "commands" && depth > 2) {
        for (const f of safeList(p)) if (f.endsWith(".md") && !isDir(join(p, f))) commands.push(join(p, f));
      }
      // Skills can sit inside skills (a plugin shipping sub-skills), so keep walking either way.
      if (left > 0) walk(p, left - 1);
    }
  };
  walk(root, depth);
  return { skills: skills.sort(), commands: commands.sort() };
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
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
  if (skill.file) {
    return [`Command ${skill.name} (a ${skill.harness} plugin command), in ${skill.file}:`, "", readFileSync(skill.file, "utf8").trim()].join("\n");
  }
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
    return `- ${k.name} (${k.harness}${k.kind === "command" ? " command" : ""}): ${d.length > 120 ? d.slice(0, 119) + "…" : d || "no description"}`;
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
