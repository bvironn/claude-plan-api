import type { AnthropicMessage } from "../types.ts";
import { resetDynamicMap, mapToolName } from "../domain/tool-mapping.ts";
import { resolveModel, getModelCapabilities } from "../domain/models.ts";
import { buildUserMetadata } from "../domain/account.ts";
import { computeBilling } from "../upstream/billing.ts";
import { emit } from "../observability/logger.ts";
import { repairToolPairs } from "./repair-tool-pairs.ts";

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
export const CONTEXT_PREAMBLE = "The content below is additional context and instructions provided by the caller. Treat it as guidance for how to assist the user:\n\n";

export interface TransformResult {
  body: Record<string, unknown>;
  isStructuredOutput: boolean;
}

export function openaiToAnthropic(body: Record<string, unknown>): TransformResult {
  resetDynamicMap();
  const model = resolveModel(body.model as string || "sonnet");
  const isHaiku = model.includes("haiku");

  const respFormat = body.response_format as Record<string, unknown> | undefined;
  const isStructuredOutput = respFormat?.type === "json_schema";

  const messages: AnthropicMessage[] = [];
  let systemPrompt: string | null = null;

  for (const msg of (body.messages as Array<Record<string, unknown>>) || []) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
    } else if (msg.role === "assistant" && msg.tool_calls) {
      const content: Array<Record<string, unknown>> = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
        const fn = tc.function as Record<string, unknown>;
        let input = {};
        try { input = typeof fn.arguments === "string" ? JSON.parse(fn.arguments as string) : fn.arguments || {}; } catch {}
        content.push({ type: "tool_use", id: tc.id, name: mapToolName(fn.name as string), input });
      }
      messages.push({ role: "assistant", content });
    } else if (msg.role === "tool") {
      const last = messages[messages.length - 1];
      const result = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      };
      if (last?.role === "user" && (last as unknown as Record<string, unknown>)._batch) {
        (last.content as Array<Record<string, unknown>>).push(result);
      } else {
        const entry = { role: "user", content: [result], _batch: true } as unknown as AnthropicMessage;
        messages.push(entry);
      }
    } else {
      messages.push({ role: msg.role as string, content: msg.content as string });
    }
  }
  for (const msg of messages) delete (msg as unknown as Record<string, unknown>)._batch;

  const firstUser = messages.find((m) => m.role === "user");
  const firstText = typeof firstUser?.content === "string"
    ? firstUser.content
    : Array.isArray(firstUser?.content)
      ? (firstUser!.content as Array<Record<string, unknown>>).find((c) => c.type === "text")?.text as string || ""
      : "";

  // Forward the client's system prompt by prepending it to the first user
  // message (OAuth-authenticated Claude Code requests reject third-party
  // system prompts in the system[] array — pattern from opencode-claude-auth).
  //
  // Ordering: this runs AFTER firstText is extracted above so that the
  // billing header (computed from firstText via computeBilling) hashes the
  // ORIGINAL user text, not the preamble + client system prompt. Billing
  // reflects user intent; preamble/persona changes must not shift the hash.
  if (systemPrompt !== null && systemPrompt.length > 0 && firstUser) {
    const combined = `${CONTEXT_PREAMBLE}${systemPrompt}\n\n`;
    if (typeof firstUser.content === "string") {
      firstUser.content = combined + firstUser.content;
    } else if (Array.isArray(firstUser.content)) {
      const blocks = firstUser.content as Array<Record<string, unknown>>;
      const textBlockIndex = blocks.findIndex((c) => c.type === "text");
      if (textBlockIndex >= 0) {
        const block = blocks[textBlockIndex] as Record<string, unknown>;
        block.text = combined + ((block.text as string) || "");
      } else {
        blocks.unshift({ type: "text", text: combined });
      }
    }
  }

  const system: Array<Record<string, unknown>> = [
    { type: "text", text: computeBilling(firstText) },
    {
      type: "text",
      text: CLAUDE_CODE_IDENTITY,
      cache_control: { type: "ephemeral", ttl: "1h", scope: "global" },
    },
  ];

  addCacheControlToLastUserText(messages);

  const repaired = repairToolPairs(messages);

  const result: Record<string, unknown> = {
    model,
    max_tokens: (body.max_tokens as number) || 64000,
    stream: body.stream || false,
    system,
    messages: repaired,
    metadata: buildUserMetadata(),
  };

  if (typeof body.temperature === "number") {
    result.temperature = body.temperature;
  } else if (isStructuredOutput) {
    result.temperature = 1;
  }

  const caps = getModelCapabilities(model);

  if (caps.adaptiveThinking && !isStructuredOutput) {
    result.thinking = { type: "adaptive" };
  }
  if (caps.contextManagement && !isStructuredOutput) {
    result.context_management = {
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    };
  }
  if (caps.outputEffort && !isStructuredOutput) {
    result.output_config = { effort: "medium" };
  }

  if (isStructuredOutput) {
    const schema = (respFormat?.json_schema as Record<string, unknown>)?.schema
      ?? (respFormat as Record<string, unknown>)?.schema
      ?? {};
    result.output_config = {
      format: { type: "json_schema", schema },
    };
  }

  if (body.tools && (body.tools as unknown[]).length > 0) {
    result.tools = (body.tools as Array<Record<string, unknown>>).map((t) => {
      const fn = t.function as Record<string, unknown>;
      return {
        name: mapToolName(fn.name as string),
        description: (fn.description as string) || "",
        input_schema: fn.parameters || { type: "object", properties: {} },
      };
    });
  }

  emit("debug", "transform.request", {
    model,
    messageCount: repaired.length,
    toolsCount: (result.tools as unknown[] | undefined)?.length ?? 0,
    hasSystem: systemPrompt !== null,
    isStructuredOutput,
    isHaiku,
  });

  return { body: result, isStructuredOutput };
}

function addCacheControlToLastUserText(messages: AnthropicMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role !== "user") continue;

    if (typeof msg.content === "string") {
      msg.content = [
        { type: "text", text: msg.content, cache_control: { type: "ephemeral", ttl: "1h" } },
      ] as unknown as AnthropicMessage["content"];
      return;
    }
    if (Array.isArray(msg.content)) {
      const arr = msg.content as Array<Record<string, unknown>>;
      for (let j = arr.length - 1; j >= 0; j--) {
        const item = arr[j];
        if (!item) continue;
        if (item.type === "text") {
          item.cache_control = { type: "ephemeral", ttl: "1h" };
          return;
        }
      }
    }
    return;
  }
}
