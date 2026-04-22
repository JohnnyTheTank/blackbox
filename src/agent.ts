import {
  appendToMessages,
  callModel,
  createInitialState,
  stepCountIs,
  updateState,
} from "@openrouter/agent";
import type {
  BaseInputsUnion,
  ConversationState,
  Item,
  Tool,
} from "@openrouter/agent";
import type {
  EasyInputMessageContentInputImage,
  InputText,
} from "@openrouter/sdk/models";

import { AGENT_TOOLS, type AskUserHandler } from "./tools.ts";
import { getClient } from "./client.ts";
import { TOOL_CALL_ARG_PREVIEW_MAX } from "./config.ts";
import { shortenArgs } from "./utils/format.ts";

export type UserContentPart = InputText | EasyInputMessageContentInputImage;
export type UserContent = string | UserContentPart[];

export type AgentState = {
  conversation: ConversationState;
  systemPrompt: string;
};

export type ToolCallRecord = {
  name: string;
  args: string;
  result: string;
};

export type AgentReporter = {
  onToolCall?: (name: string, args: string) => void;
  onToolResult?: (name: string, result: string) => void;
};

export type RunAgentOptions = {
  tools?: readonly Tool[];
  askUser?: AskUserHandler;
};

export type AgentResult = {
  answer: string;
  state: AgentState;
  toolCalls: ToolCallRecord[];
};

const DEFAULT_STEP_LIMIT = 50;

export function buildInitialHistory(systemPrompt: string): AgentState {
  return {
    conversation: createInitialState(),
    systemPrompt,
  };
}

export function appendInputMessages(
  state: AgentState,
  items: BaseInputsUnion[],
): AgentState {
  return {
    ...state,
    conversation: updateState(state.conversation, {
      messages: appendToMessages(state.conversation.messages, items),
    }),
  };
}

export async function runAgent(
  state: AgentState,
  userContent: UserContent,
  model: string,
  reporter?: AgentReporter,
  signal?: AbortSignal,
  options?: RunAgentOptions,
): Promise<AgentResult> {
  const client = getClient();
  const tools = options?.tools ?? AGENT_TOOLS;
  const askUser = options?.askUser;

  let currentState: ConversationState = state.conversation;
  const accessor = {
    load: async (): Promise<ConversationState> => currentState,
    save: async (s: ConversationState): Promise<void> => {
      currentState = s;
    },
  };

  const input = toInputValue(userContent);
  const context = askUser ? { ask_user: { askUser } } : undefined;

  const result = client.callModel(
    {
      model,
      input,
      instructions: state.systemPrompt,
      tools: tools as readonly Tool[],
      state: accessor,
      stopWhen: stepCountIs(DEFAULT_STEP_LIMIT),
      ...(context !== undefined ? { context: context as never } : {}),
    } as Parameters<typeof client.callModel>[0],
    { signal },
  );

  const toolCalls: ToolCallRecord[] = [];
  const pendingCalls = new Map<string, { name: string; args: string }>();

  const consumeToolCalls = (async (): Promise<void> => {
    try {
      for await (const call of result.getToolCallsStream()) {
        const args = safeStringify(call.arguments ?? {});
        pendingCalls.set(call.id, { name: call.name, args });
        reporter?.onToolCall?.(
          call.name,
          shortenArgs(args, TOOL_CALL_ARG_PREVIEW_MAX),
        );
      }
    } catch {
      // Errors on the primary stream are surfaced via `getText()` below.
    }
  })();

  const consumeToolResults = (async (): Promise<void> => {
    try {
      for await (const event of result.getFullResponsesStream()) {
        if (event.type !== "tool.result") continue;
        const meta = pendingCalls.get(event.toolCallId);
        if (!meta) continue;
        const resultText = stringifyToolResult(event.result);
        toolCalls.push({ name: meta.name, args: meta.args, result: resultText });
        reporter?.onToolResult?.(meta.name, resultText);
      }
    } catch {
      // see above
    }
  })();

  try {
    const answer = await result.getText();
    await Promise.allSettled([consumeToolCalls, consumeToolResults]);
    return {
      answer,
      state: { ...state, conversation: currentState },
      toolCalls,
    };
  } catch (err) {
    // Swallow any lingering iterator rejections so we don't emit
    // "unhandled rejection" warnings after we already rethrew.
    await Promise.allSettled([consumeToolCalls, consumeToolResults]);
    throw err;
  }
}

function toInputValue(content: UserContent): string | Item[] {
  if (typeof content === "string") return content;
  return [
    {
      role: "user",
      content,
    } as Item,
  ];
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
