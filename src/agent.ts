import OpenAI from "openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

export type UserContent = string | ChatCompletionContentPart[];

import { AGENT_TOOL_SCHEMAS, runTool, type AnyTool } from "./tools.ts";
import {
  MAX_ITER,
  OPENROUTER_API_KEY_ENV,
  OPENROUTER_BASE_URL,
  OPENROUTER_HEADERS,
  SYSTEM_PROMPT,
  TOOL_CALL_ARG_PREVIEW_MAX,
} from "./config.ts";

export { SYSTEM_PROMPT } from "./config.ts";

export type ToolCallRecord = {
  name: string;
  args: string;
  result: string;
};

export type AgentReporter = {
  onToolCall?: (name: string, args: string) => void;
  onToolResult?: (name: string, result: string) => void;
};

export type AgentResult = {
  answer: string;
  toolCalls: ToolCallRecord[];
};

export type AskUserRequest = {
  question: string;
  type: "choice" | "text";
  options?: string[];
};

export type AskUserHandler = (
  request: AskUserRequest,
  signal?: AbortSignal,
) => Promise<string>;

export type RunAgentOptions = {
  toolSchemas?: AnyTool[];
  askUser?: AskUserHandler;
};

function createClient(): OpenAI {
  const apiKey = process.env[OPENROUTER_API_KEY_ENV];
  if (!apiKey || apiKey.length === 0) {
    throw new Error(
      `${OPENROUTER_API_KEY_ENV} is not set. Please create a .env file (see .env.example).`,
    );
  }
  return new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: OPENROUTER_HEADERS,
  });
}

let cachedClient: OpenAI | null = null;
function getClient(): OpenAI {
  if (!cachedClient) cachedClient = createClient();
  return cachedClient;
}

function shortenArgs(raw: string): string {
  const max = TOOL_CALL_ARG_PREVIEW_MAX;
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function describeToolCall(call: ChatCompletionMessageToolCall): {
  name: string;
  args: string;
} | null {
  if (call.type !== "function") return null;
  return {
    name: call.function.name,
    args: call.function.arguments ?? "",
  };
}

export class AbortError extends Error {
  constructor(message = "aborted") {
    super(message);
    this.name = "AbortError";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError();
}

export async function runAgent(
  history: ChatCompletionMessageParam[],
  userContent: UserContent,
  model: string,
  reporter?: AgentReporter,
  signal?: AbortSignal,
  options?: RunAgentOptions,
): Promise<AgentResult> {
  const client = getClient();
  const toolCalls: ToolCallRecord[] = [];
  const toolSchemas = options?.toolSchemas ?? AGENT_TOOL_SCHEMAS;
  const askUser = options?.askUser;

  history.push({ role: "user", content: userContent });

  for (let i = 0; i < MAX_ITER; i++) {
    throwIfAborted(signal);
    const response = await client.chat.completions.create(
      {
        model,
        messages: history,
        tools: toolSchemas as ChatCompletionTool[],
      },
      { signal },
    );

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("Empty response received from model");
    }
    const msg = choice.message;
    history.push(msg as ChatCompletionMessageParam);

    const responseToolCalls = msg.tool_calls ?? [];
    if (responseToolCalls.length === 0) {
      return { answer: msg.content ?? "", toolCalls };
    }

    for (const call of responseToolCalls) {
      const described = describeToolCall(call);
      if (!described) continue;
      const { name, args } = described;
      reporter?.onToolCall?.(name, shortenArgs(args));

      let parsedArgs: Record<string, unknown> = {};
      let parseError: string | null = null;
      try {
        parsedArgs = args
          ? (JSON.parse(args) as Record<string, unknown>)
          : {};
      } catch (err) {
        parseError =
          err instanceof Error ? err.message : String(err);
      }

      let result: string;
      if (parseError) {
        result = `Failed to parse tool arguments: ${parseError}`;
      } else if (name === "ask_user") {
        if (!askUser) {
          result =
            "Error: ask_user is only available in plan mode. Do not call this tool.";
        } else {
          result = await runAskUser(askUser, parsedArgs, signal);
        }
      } else {
        result = await runTool(name, parsedArgs, signal);
      }

      reporter?.onToolResult?.(name, result);
      toolCalls.push({ name, args, result });

      history.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });

      throwIfAborted(signal);
    }
  }

  return {
    answer: `(Reached maximum iteration count of ${MAX_ITER}, aborting.)`,
    toolCalls,
  };
}

export function buildInitialHistory(
  systemPrompt: string = SYSTEM_PROMPT,
): ChatCompletionMessageParam[] {
  return [{ role: "system", content: systemPrompt }];
}

async function runAskUser(
  askUser: AskUserHandler,
  parsedArgs: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const question = typeof parsedArgs.question === "string" ? parsedArgs.question : "";
  const type = parsedArgs.type === "choice" ? "choice" : parsedArgs.type === "text" ? "text" : null;
  if (question.length === 0) {
    return "Error: ask_user requires a non-empty 'question' string.";
  }
  if (type === null) {
    return "Error: ask_user requires 'type' to be either 'choice' or 'text'.";
  }

  let options: string[] | undefined;
  if (type === "choice") {
    const raw = parsedArgs.options;
    if (!Array.isArray(raw) || raw.length < 2) {
      return "Error: ask_user with type='choice' needs an 'options' array with at least 2 entries.";
    }
    const cleaned = raw
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter((v) => v.length > 0);
    if (cleaned.length < 2) {
      return "Error: ask_user with type='choice' needs at least 2 non-empty option strings.";
    }
    options = cleaned.slice(0, 6);
  }

  try {
    const answer = await askUser({ question, type, options }, signal);
    const trimmed = (answer ?? "").trim();
    if (trimmed.length === 0) {
      return "User provided no answer (empty or cancelled). Ask again with a clearer question, or proceed with your best assumption and note the open question in the plan.";
    }
    return JSON.stringify({ answer: trimmed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error asking user: ${msg}`;
  }
}
