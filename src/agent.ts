import OpenAI from "openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

export type UserContent = string | ChatCompletionContentPart[];

import { TOOL_SCHEMAS, runTool } from "./tools.ts";
import { WORKSPACE_ROOT } from "./sandbox.ts";

const MAX_ITER = 50;

export const SYSTEM_PROMPT = `You are a pragmatic CLI coding agent helping a developer in their local project.

WORKSPACE_ROOT: ${WORKSPACE_ROOT}

Rules:
- All file access and shell commands are limited to WORKSPACE_ROOT.
- Use only relative paths (e.g. "src/index.ts") or absolute paths that are inside WORKSPACE_ROOT.
- Do not access files outside of the workspace and do not 'cd' to other directories in execute_bash.
- Work in small steps: read relevant files before you modify them.
- edit_file overwrites the file completely; read it with read_file first if you only want to change parts of it.
- If a tool returns an error, analyze it and adapt your next step instead of repeating the same call.
- End with a concise summary of the changes or findings in English.

Available tools:
- read_file(path) — read a file inside WORKSPACE_ROOT
- list_files(path?) — list files/subdirs up to depth 2
- edit_file(path, content) — overwrite a file inside WORKSPACE_ROOT
- execute_bash(command) — run a shell command in WORKSPACE_ROOT
- fetch_url(url, max_bytes?) — fetch a public http(s) URL and return its text content (HTML is stripped, JSON is pretty-printed). Use this to read documentation or public API responses. Avoid internal or sensitive URLs.
- openrouter:web_search — server-side web search; invoke when you need current information you don't have. Prefer a specific query.
- openrouter:datetime — server-side current date and time. Use when the user asks about "now", deadlines, or recent events.

When unsure about a library or API, prefer fetch_url on the official docs or openrouter:web_search over guessing. Do not hallucinate APIs you do not know.`;

function createClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Please create a .env file (see .env.example).",
    );
  }
  return new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/local/blackbox",
      "X-Title": "blackbox-cli-agent",
    },
  });
}

let cachedClient: OpenAI | null = null;
function getClient(): OpenAI {
  if (!cachedClient) cachedClient = createClient();
  return cachedClient;
}

function shortenArgs(raw: string): string {
  const max = 200;
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function logToolCall(call: ChatCompletionMessageToolCall): void {
  if (call.type !== "function") return;
  const name = call.function.name;
  const args = shortenArgs(call.function.arguments ?? "");
  process.stdout.write(`\x1b[2m  → ${name}(${args})\x1b[0m\n`);
}

export async function runAgent(
  history: ChatCompletionMessageParam[],
  userContent: UserContent,
  model: string,
): Promise<string> {
  const client = getClient();

  history.push({ role: "user", content: userContent });

  for (let i = 0; i < MAX_ITER; i++) {
    const response = await client.chat.completions.create({
      model,
      messages: history,
      tools: TOOL_SCHEMAS as ChatCompletionTool[],
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("Empty response received from model");
    }
    const msg = choice.message;
    history.push(msg as ChatCompletionMessageParam);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return msg.content ?? "";
    }

    for (const call of toolCalls) {
      if (call.type !== "function") continue;
      logToolCall(call);

      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = call.function.arguments
          ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
          : {};
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        history.push({
          role: "tool",
          tool_call_id: call.id,
          content: `Failed to parse tool arguments: ${errMsg}`,
        });
        continue;
      }

      const result = await runTool(call.function.name, parsedArgs);
      history.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  return `(Reached maximum iteration count of ${MAX_ITER}, aborting.)`;
}

export function buildInitialHistory(): ChatCompletionMessageParam[] {
  return [{ role: "system", content: SYSTEM_PROMPT }];
}
