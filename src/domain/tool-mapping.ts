import { emit } from "../observability/logger.ts";

// Aliases that bend non-CC tool names toward Claude Code's canonical vocabulary
// so Anthropic's billing router doesn't flag the request as a non-CC client.
// Only entries that CANNOT be derived by auto-PascalCase live here:
//  - semantic translations (e.g. opencode `task` ≠ CC `Task`, it's CC `Agent`)
//  - compound words with internal boundaries (e.g. `webfetch` → `WebFetch`, not `Webfetch`)
// Single-word lowercase names not in this map fall through to autoCanonical().
const CC_ALIASES: Record<string, string> = {
  // semantic translations
  task: "Agent",
  agent: "Agent",
  todowrite: "TaskCreate",
  todoread: "TaskList",
  todo_write: "TaskCreate",
  todo_read: "TaskList",
  question: "AskUserQuestion",
  ask: "AskUserQuestion",
  // compound words (auto-PascalCase would lose the internal boundary)
  webfetch: "WebFetch",
  websearch: "WebSearch",
  notebookedit: "NotebookEdit",
  notebook_edit: "NotebookEdit",
  toolsearch: "ToolSearch",
  tool_search: "ToolSearch",
  schedulewakeup: "ScheduleWakeup",
  taskcreate: "TaskCreate",
  tasklist: "TaskList",
  taskupdate: "TaskUpdate",
  taskget: "TaskGet",
  taskoutput: "TaskOutput",
  taskstop: "TaskStop",
  enterplanmode: "EnterPlanMode",
  exitplanmode: "ExitPlanMode",
  enterworktree: "EnterWorktree",
  exitworktree: "ExitWorktree",
  remotetrigger: "RemoteTrigger",
  croncreate: "CronCreate",
  crondelete: "CronDelete",
  cronlist: "CronList",
  askuserquestion: "AskUserQuestion",
};

/**
 * Request-scoped tool-name mapping state.
 *
 * The forward map (`forward`) translates a client tool name → the Anthropic
 * wire name; the reverse map (`reverse`) translates the wire name back to the
 * original client name. These MUST be per-request: `mapToolName` runs while
 * building the upstream request, but `unmapToolName` runs LATER, mid-stream,
 * when the upstream response arrives. A module-global map would let a second
 * concurrent request clobber the first request's reverse lookup (issue #1).
 */
export interface ToolMap {
  forward: Record<string, string>;
  reverse: Record<string, string>;
}

/** Create a fresh, isolated per-request tool map. */
export function createToolMap(): ToolMap {
  return { forward: {}, reverse: {} };
}

export function sanitizeToolName(name: string): string {
  // Anthropic tool names: [a-zA-Z0-9_], max 64 chars, must start with a letter
  let s = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^[0-9]/.test(s)) s = "T" + s;
  return s.slice(0, 64);
}

function autoCanonical(name: string): string | null {
  // Single-word lowercase: bash -> Bash, read -> Read.
  if (/^[a-z][a-z]*$/.test(name)) {
    return name[0]!.toUpperCase() + name.slice(1);
  }
  // snake_case → PascalCase: web_search -> WebSearch, code_execution -> CodeExecution.
  // Each segment must be lowercase letters/digits, first char of each must be a letter.
  if (/^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)+$/.test(name)) {
    return name
      .split("_")
      .map((s) => s[0]!.toUpperCase() + s.slice(1))
      .join("");
  }
  return null;
}

function ccCanonical(name: string): string | null {
  return CC_ALIASES[name.toLowerCase()] ?? autoCanonical(name);
}

// Prefix Claude Code uses for ALL tool names on the wire (e.g. "mcp_Bash",
// "mcp_Read", "mcp_WebFetch"). Anthropic's OAuth billing validation rejects
// unprefixed names when multiple tools are present — it flags the request as
// a non-Claude-Code client and applies safety policies including redacted
// thinking. We MUST match this shape.
const MCP_PREFIX = "mcp_";

export function mapToolName(name: string, map: ToolMap): string {
  if (map.forward[name]) return map.forward[name];
  if (map.reverse[name]) return name;

  const canonical = ccCanonical(name);
  const base = canonical ?? sanitizeToolName(name);
  // CRITICAL: Anthropic's OAuth-billing validation rejects tool names whose
  // first character (after `mcp_` prefix) is lowercase, returning a misleading
  // HTTP 400 with body `{"error": {"message": "You're out of extra usage..."}}`.
  // The error has NOTHING to do with billing — it is a request-shape rejection.
  // We unconditionally uppercase the first char here to mirror the reference
  // plugin (griffinmartin/opencode-claude-auth) which is empirically known to
  // pass validation. See: src/domain/tool-mapping.ts (this file) commit history.
  const naked = base.startsWith(MCP_PREFIX) ? base.slice(MCP_PREFIX.length) : base;
  const cased = naked.length > 0 ? naked[0]!.toUpperCase() + naked.slice(1) : naked;
  const prefixed = `${MCP_PREFIX}${cased}`;

  const used = new Set(Object.values(map.forward));
  let mapped = prefixed;
  let suffix = 2;
  while (used.has(mapped)) mapped = `${prefixed}_${suffix++}`;

  map.forward[name] = mapped;
  map.reverse[mapped] = name;
  emit("debug", "tool.map", { original: name, mapped, canonical: canonical !== null });
  return mapped;
}

export function unmapToolName(name: string, map: ToolMap): string {
  if (map.reverse[name]) return map.reverse[name];
  // Fallback: if the response carries a prefixed name we never mapped
  // (e.g. tool called in a follow-up turn whose state was lost), strip the
  // prefix to give the client its original name back.
  if (name.startsWith(MCP_PREFIX)) {
    const stripped = name.slice(MCP_PREFIX.length);
    // Restore first-letter lowercase so "mcp_Bash" round-trips to "bash"
    // when the original client used lowercase (most OpenAI-compatible
    // clients do). If the original was PascalCase, the first-letter
    // lowercase is still a reasonable guess — callers that need the
    // exact original should pre-register via mapToolName on their tools.
    return stripped ? stripped[0]!.toLowerCase() + stripped.slice(1) : stripped;
  }
  return name;
}
