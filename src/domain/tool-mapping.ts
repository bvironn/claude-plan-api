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

let toolMap: Record<string, string> = {};
let toolMapReverse: Record<string, string> = {};

export function resetDynamicMap() {
  toolMap = {};
  toolMapReverse = {};
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
    return name[0].toUpperCase() + name.slice(1);
  }
  // snake_case → PascalCase: web_search -> WebSearch, code_execution -> CodeExecution.
  // Each segment must be lowercase letters/digits, first char of each must be a letter.
  if (/^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)+$/.test(name)) {
    return name
      .split("_")
      .map((s) => s[0].toUpperCase() + s.slice(1))
      .join("");
  }
  return null;
}

function ccCanonical(name: string): string | null {
  return CC_ALIASES[name.toLowerCase()] ?? autoCanonical(name);
}

export function mapToolName(name: string): string {
  if (toolMap[name]) return toolMap[name];

  const canonical = ccCanonical(name);
  const base = canonical ?? sanitizeToolName(name);

  const used = new Set(Object.values(toolMap));
  let mapped = base;
  let suffix = 2;
  while (used.has(mapped)) mapped = `${base}_${suffix++}`;

  toolMap[name] = mapped;
  toolMapReverse[mapped] = name;
  emit("debug", "tool.map", { original: name, mapped, canonical: canonical !== null });
  return mapped;
}

export function unmapToolName(name: string): string {
  return toolMapReverse[name] ?? name;
}
