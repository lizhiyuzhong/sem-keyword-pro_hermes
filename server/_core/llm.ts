import { ENV } from "./env";
import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Token usage tracker (per-request, reset by caller)
// ---------------------------------------------------------------------------
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export const TokenTracker = {
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } as TokenUsage,

  reset() {
    this.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  },

  add(usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) {
    if (!usage) return;
    this.usage.prompt_tokens += usage.prompt_tokens ?? 0;
    this.usage.completion_tokens += usage.completion_tokens ?? 0;
    this.usage.total_tokens += usage.total_tokens ?? 0;
  },

  getTotal(): TokenUsage {
    return { ...this.usage };
  },

  /** Write usage to log file (only in DEV_MODE). */
  log(label: string) {
    if (!ENV.devMode) return;
    try {
      const dir = join(process.cwd(), ".hermes");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const line = `[${new Date().toISOString()}] ${label} | prompt=${this.usage.prompt_tokens} completion=${this.usage.completion_tokens} total=${this.usage.total_tokens}\n`;
      appendFileSync(join(dir, "token-usage.log"), line, "utf-8");
    } catch {
      // best-effort logging
    }
  },
};

export type Role = "system" | "user" | "assistant" | "tool" | "function";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?: "audio/mpeg" | "audio/wav" | "application/pdf" | "audio/mp4" | "video/mp4" ;
  };
};

export type MessageContent = string | TextContent | ImageContent | FileContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
};

export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice =
  | ToolChoicePrimitive
  | ToolChoiceByName
  | ToolChoiceExplicit;

export type InvokeParams = {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  /** Per-request model override. Uses LLM_MODEL env if not set. */
  modelOverride?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OutputSchema = JsonSchema;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

const ensureArray = (
  value: MessageContent | MessageContent[]
): MessageContent[] => (Array.isArray(value) ? value : [value]);

const normalizeContentPart = (
  part: MessageContent
): TextContent | ImageContent | FileContent => {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }

  if (part.type === "text") {
    return part;
  }

  if (part.type === "image_url") {
    return part;
  }

  if (part.type === "file_url") {
    return part;
  }

  throw new Error("Unsupported message content part");
};

const normalizeMessage = (message: Message) => {
  const { role, name, tool_call_id } = message;

  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content)
      .map(part => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\n");

    return {
      role,
      name,
      tool_call_id,
      content,
    };
  }

  const contentParts = ensureArray(message.content).map(normalizeContentPart);

  // If there's only text content, collapse to a single string for compatibility
  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return {
      role,
      name,
      content: contentParts[0].text,
    };
  }

  return {
    role,
    name,
    content: contentParts,
  };
};

const normalizeToolChoice = (
  toolChoice: ToolChoice | undefined,
  tools: Tool[] | undefined
): "none" | "auto" | ToolChoiceExplicit | undefined => {
  if (!toolChoice) return undefined;

  if (toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }

  if (toolChoice === "required") {
    if (!tools || tools.length === 0) {
      throw new Error(
        "tool_choice 'required' was provided but no tools were configured"
      );
    }

    if (tools.length > 1) {
      throw new Error(
        "tool_choice 'required' needs a single tool or specify the tool name explicitly"
      );
    }

    return {
      type: "function",
      function: { name: tools[0].function.name },
    };
  }

  if ("name" in toolChoice) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }

  return toolChoice;
};

const resolveApiUrl = () => {
  // Priority 1: Custom LLM_API_URL (for development with external API)
  if (ENV.llmApiUrl && ENV.llmApiUrl.trim().length > 0) {
    const base = ENV.llmApiUrl.replace(/\/+$/, "");
    // If URL already includes /v1/chat/completions, use as-is
    if (base.endsWith("/v1/chat/completions")) return base;
    return `${base}/v1/chat/completions`;
  }
  // Priority 2: Manus Forge API (production default)
  if (ENV.forgeApiUrl && ENV.forgeApiUrl.trim().length > 0) {
    return `${ENV.forgeApiUrl.replace(/\/$/, "")}/v1/chat/completions`;
  }
  // Fallback
  return "https://forge.manus.im/v1/chat/completions";
};

const assertApiKey = () => {
  // Priority 1: custom LLM_API_KEY
  if (ENV.llmApiKey && ENV.llmApiKey.trim().length > 0) return;
  // Priority 2: Manus Forge API key
  if (ENV.forgeApiKey && ENV.forgeApiKey.trim().length > 0) return;
  throw new Error("No LLM API key configured. Set LLM_API_KEY or BUILT_IN_FORGE_API_KEY.");
};

const resolveApiKey = (): string => {
  if (ENV.llmApiKey && ENV.llmApiKey.trim().length > 0) return ENV.llmApiKey;
  return ENV.forgeApiKey;
};

const resolveModel = (override?: string): string => {
  // Request-level override takes priority
  if (override && override.trim().length > 0) return override.trim();
  // Then env config
  if (ENV.llmModel && ENV.llmModel.trim().length > 0) return ENV.llmModel;
  // Default
  return "gemini-2.5-flash";
};

const normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema,
  model,
}: {
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  model: string;
}):
  | { type: "json_schema"; json_schema: JsonSchema }
  | { type: "text" }
  | { type: "json_object" }
  | undefined => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    // Only Gemini supports json_schema with strict mode.
    // Downgrade to json_object for OpenAI-compatible APIs (DeepSeek, etc.)
    if (explicitFormat.type === "json_schema" && !model.startsWith("gemini")) {
      return { type: "json_object" };
    }
    if (
      explicitFormat.type === "json_schema" &&
      !explicitFormat.json_schema?.schema
    ) {
      throw new Error(
        "responseFormat json_schema requires a defined schema object"
      );
    }
    return explicitFormat;
  }

  const schema = outputSchema || output_schema;
  if (!schema) return undefined;

  if (!schema.name || !schema.schema) {
    throw new Error("outputSchema requires both name and schema");
  }

  // Only Gemini supports json_schema. Downgrade to json_object for others.
  if (!model.startsWith("gemini")) {
    return { type: "json_object" };
  }

  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
    },
  };
};

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  assertApiKey();

  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    outputSchema,
    output_schema,
    responseFormat,
    response_format,
    modelOverride,
  } = params;

  const model = resolveModel(modelOverride);

  const payload: Record<string, unknown> = {
    model,
    messages: messages.map(normalizeMessage),
  };

  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  const normalizedToolChoice = normalizeToolChoice(
    toolChoice || tool_choice,
    tools
  );
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }

  payload.max_tokens = 32768

  // Gemini-specific thinking budget — only set for Gemini models
  if (model.startsWith("gemini")) {
    payload.thinking = { budget_tokens: 128 };
  }

  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
    model,
  });

  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat;
  }

  // Attempt up to 2 times with a 30-second timeout per attempt
  const LLM_TIMEOUT_MS = 30_000;
  const MAX_ATTEMPTS = 2;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      const response = await fetch(resolveApiUrl(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${resolveApiKey()}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `LLM invoke failed: ${response.status} ${response.statusText} – ${errorText}`
        );
      }

      const result = (await response.json()) as InvokeResult;
      TokenTracker.add(result.usage);
      return result;
    } catch (err: any) {
      clearTimeout(timer);
      const isTimeout = err?.name === "AbortError" || err?.message?.includes("aborted");
      const isNetworkError = err?.cause?.code === "UND_ERR_SOCKET" || err?.message?.includes("other side closed") || err?.message?.includes("fetch failed");
      lastError = err;
      if ((isTimeout || isNetworkError) && attempt < MAX_ATTEMPTS) {
        console.warn(`[LLM] Attempt ${attempt} failed (${isTimeout ? "timeout" : "network error"}), retrying...`);
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error("LLM invoke failed after retries");
}
