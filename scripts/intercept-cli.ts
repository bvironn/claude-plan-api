#!/usr/bin/env bun
/**
 * Capture what the real `claude` CLI sends and diff it against this gateway.
 *
 * Starts a local HTTP server, runs `claude -p "say hi" --model <id>` with
 * ANTHROPIC_BASE_URL pointed at it, and records the first /v1/messages
 * request: CLI version (user-agent), anthropic-beta, header names, and the
 * body shape (billing entrypoint, thinking, output_config, ...). No request
 * reaches the real API, so no quota is used; a dummy OAuth token is supplied
 * unless CLAUDE_CODE_OAUTH_TOKEN is already set.
 *
 * Use it whenever the CLI updates to see whether VERSION in src/config.ts or
 * BASE_BETAS / MODEL_OVERRIDES in src/upstream/headers.ts need to follow.
 *
 *   bun scripts/intercept-cli.ts                       # default models
 *   bun scripts/intercept-cli.ts claude-opus-5-5 claude-haiku-4-5
 *   bun scripts/intercept-cli.ts --json                # machine-readable
 */
import { VERSION } from "../src/config.ts";
import { buildBetas, buildHeaders } from "../src/upstream/headers.ts";
import { __setCredentialsForTests } from "../src/domain/credentials.ts";

const DEFAULT_MODELS = ["claude-opus-5-5", "claude-sonnet-5", "claude-opus-4-7", "claude-haiku-4-5"];
const TIMEOUT_MS = 60_000;

interface Capture {
  model: string;
  cliVersion: string | null;
  userAgent: string;
  betas: string[];
  headerNames: string[];
  body: Record<string, unknown> | null;
}

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

/**
 * The parent environment minus inherited CLI/SDK variables. Run from inside
 * another CLI session or an SDK host, the child would otherwise report that
 * host's entrypoint and permission-mode betas instead of a plain terminal
 * CLI's fingerprint.
 */
function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|CLAUDECODE|ANTHROPIC_)/.test(k) && k !== "CLAUDE_CODE_OAUTH_TOKEN") continue;
    env[k] = v;
  }
  return env;
}

async function intercept(model: string): Promise<Capture | null> {
  let resolveCapture!: (c: Capture | null) => void;
  const captured = new Promise<Capture | null>((r) => (resolveCapture = r));

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/v1/messages") && !url.pathname.includes("count_tokens")) {
        const headers = Object.fromEntries(req.headers.entries());
        let body: Record<string, unknown> | null = null;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          body = null;
        }
        // Skip the CLI's background quota/haiku probes; keep the requested model.
        if (body && body.model !== model) {
          return Response.json({ type: "error", error: { type: "overloaded_error", message: "intercept" } }, { status: 529 });
        }
        const userAgent = headers["user-agent"] ?? "";
        resolveCapture({
          model,
          cliVersion: userAgent.match(/claude-cli\/([\d.]+)/)?.[1] ?? null,
          userAgent,
          betas: (headers["anthropic-beta"] ?? "").split(",").map((b) => b.trim()).filter(Boolean),
          headerNames: Object.keys(headers).sort(),
          body,
        });
      }
      // A non-retryable error ends the CLI run quickly.
      return Response.json({ type: "error", error: { type: "invalid_request_error", message: "intercepted" } }, { status: 400 });
    },
  });

  const child = Bun.spawn(["claude", "-p", "say hi", "--model", model], {
    env: {
      ...cleanEnv(),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "sk-ant-oat01-intercept-dummy",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      TERM: "dumb",
    },
    cwd: "/tmp",
    stdout: "ignore",
    stderr: "ignore",
  });

  const timer = setTimeout(() => resolveCapture(null), TIMEOUT_MS);
  void child.exited.then(() => setTimeout(() => resolveCapture(null), 500));
  const result = await captured;
  clearTimeout(timer);
  child.kill();
  server.stop(true);
  return result;
}

function summarizeBody(body: Record<string, unknown> | null): Record<string, unknown> {
  if (!body) return {};
  const system = Array.isArray(body.system) ? (body.system as Array<{ text?: string }>) : [];
  const billing = system.find((s) => s.text?.startsWith("x-anthropic-billing-header"))?.text ?? null;
  return {
    keys: Object.keys(body).sort(),
    billingEntrypoint: billing?.match(/cc_entrypoint=([^;]+)/)?.[1] ?? null,
    billingVersion: billing?.match(/cc_version=([\d.]+)\./)?.[1] ?? null,
    thinking: body.thinking ?? null,
    output_config: body.output_config ?? null,
    context_management: body.context_management ?? null,
  };
}

function diff(label: string, theirs: string[], ours: string[]): boolean {
  const missing = theirs.filter((x) => !ours.includes(x));
  const extra = ours.filter((x) => !theirs.includes(x));
  if (missing.length === 0 && extra.length === 0) {
    console.log(`  ${c.green("✓")} ${label} match`);
    return true;
  }
  console.log(`  ${c.red("✗")} ${label} differ`);
  for (const m of missing) console.log(`      ${c.yellow("+ CLI sends")}    ${m}`);
  for (const e of extra) console.log(`      ${c.yellow("- gateway only")} ${e}`);
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const models = args.filter((a) => !a.startsWith("--"));
  const targets = models.length > 0 ? models : DEFAULT_MODELS;

  // buildHeaders needs a token; the value is irrelevant here.
  __setCredentialsForTests({ accessToken: "dummy", refreshToken: "dummy", expiresAt: Date.now() + 3_600_000 });
  const ourHeaderNames = Object.keys(buildHeaders("claude-opus-5-5")).map((h) => h.toLowerCase());

  const results: Array<Capture & { summary: Record<string, unknown> }> = [];
  let allMatch = true;

  for (const model of targets) {
    if (!json) console.log(c.bold(`\n${model}`));
    const capture = await intercept(model);
    if (!capture) {
      allMatch = false;
      if (!json) console.log(`  ${c.red("✗")} no request captured (is \`claude\` installed and on PATH?)`);
      continue;
    }
    const summary = summarizeBody(capture.body);
    results.push({ ...capture, summary });
    if (json) continue;

    console.log(c.dim(`  user-agent: ${capture.userAgent}`));
    if (capture.cliVersion === VERSION) {
      console.log(`  ${c.green("✓")} CLI version ${VERSION}`);
    } else {
      allMatch = false;
      console.log(`  ${c.yellow("!")} CLI version ${capture.cliVersion} — gateway reports ${VERSION}`);
    }
    allMatch = diff("betas", capture.betas, buildBetas(model).split(",")) && allMatch;
    // Transport headers the gateway never sets itself.
    const ignore = new Set(["host", "connection", "content-length", "content-type", "accept", "accept-encoding", "x-api-key"]);
    const cliHeaders = capture.headerNames.filter((h) => !ignore.has(h));
    allMatch = diff("header names", cliHeaders, ourHeaderNames.filter((h) => !ignore.has(h))) && allMatch;
    console.log(c.dim(`  body: ${JSON.stringify(summary)}`));
  }

  if (json) {
    console.log(JSON.stringify({ gatewayVersion: VERSION, results }, null, 2));
  } else if (!allMatch) {
    console.log(c.yellow("\nDifferences found: review VERSION (src/config.ts) and BASE_BETAS / MODEL_OVERRIDES (src/upstream/headers.ts)."));
  } else {
    console.log(c.green("\nGateway fingerprint matches the installed CLI."));
  }
  process.exit(allMatch ? 0 : 1);
}

await main();
