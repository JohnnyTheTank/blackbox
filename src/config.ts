import { WORKSPACE_ROOT } from "./sandbox.ts";
export { WORKSPACE_ROOT } from "./sandbox.ts";

// OpenRouter / API
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://github.com/JohnnyTheTank/blackbox",
  "X-Title": "blackbox-cli-agent",
};
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";

// Models / CLI model UX
export const DEFAULT_MODEL = "google/gemini-3-flash-preview";

// Curated default list of OpenRouter models.
// All entries below support both tool/function calling and image inputs
// (modalities: text+image -> text, supported_parameters: tools).
export const CURATED_MODELS: string[] = [
  "openrouter/elephant-alpha",
  "z-ai/glm-4.5-air:free",
  "nvidia/nemotron-3-super-120b-a12b:free",

  // Anthropic — top coding / agent models
  "anthropic/claude-opus-4.7",
  "anthropic/claude-opus-4.6",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-4.5",

  // OpenAI — GPT-5 family incl. Codex specialists
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.3-codex",
  "openai/gpt-5.1-codex-max",

  // Google — Gemini 3.x
  "google/gemini-3.1-pro-preview",
  "google/gemini-3-flash-preview",

  // xAI
  "x-ai/grok-4.20",

  // Alibaba Qwen
  "qwen/qwen3.6-plus",

  // Moonshot
  "moonshotai/kimi-k2.6",

  // Z.ai
  "z-ai/glm-4.6v",

  // Mistral
  "mistralai/mistral-large-2512",
];

export const VISION_HINTS: RegExp[] = [
  /claude/i,
  /gemini/i,
  /gpt-4/i,
  /gpt-5/i,
  /grok-?\d/i,
  /grok.*vision/i,
  /qwen.*vl/i,
  /qwen3\.\d/i,
  /llama.*vision/i,
  /pixtral/i,
  /mistral.*pixtral/i,
  /mistral-large/i,
  /internvl/i,
  /kimi-k2/i,
  /glm-?\d.*v/i,
  /gemma-?4/i,
];

// Agent loop
export const MAX_ITER = 50;
export const TOOL_CALL_ARG_PREVIEW_MAX = 200;

// Plan mode
export const PLANS_DIR = ".blackbox/plans";
export const PLAN_FILE_SUFFIX = ".plan.md";
export const PLAN_DONE_SUFFIX = ".plan.done.md";

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

export const PLAN_SYSTEM_PROMPT = `You are a CLI planning agent working with a developer in their local project. You are in PLAN MODE: you do research and produce a written plan, you do NOT implement anything.

WORKSPACE_ROOT: ${WORKSPACE_ROOT}

Hard rules:
- You MUST NOT modify any source files. You have no edit_file and no execute_bash tools.
- The only way to save output is the 'write_plan' tool, which writes to ${PLANS_DIR}/<slug>${PLAN_FILE_SUFFIX}.
- End every run with a short natural-language summary that points at the plan file path you wrote. Do not include a restated plan body in chat.

Process (follow roughly in order):
1. Clarify: if the request is ambiguous, call 'ask_user' before researching. Prefer multiple-choice (type: "choice") with 2-6 concrete options over open text; use type: "text" only when free input is truly needed. Ask at most 1-2 critical questions at a time.
2. Research: use read_file, list_files, fetch_url, openrouter:web_search to gather the exact context you need. Cite concrete file paths in the plan.
3. Write the plan exactly once via 'write_plan'. Structure the markdown content with these sections in this order:
   - "# <Title>"
   - "## Goal"
   - "## Affected Files" (bullet list with relative paths)
   - "## Steps" (numbered, concrete, each step small enough to implement on its own)
   - "## Open Questions" (empty bullet list if none)
   - "## Test Plan"

Language policy:
- The plan file content is ALWAYS written in English, regardless of the language the user is using.
- EXCEPTION: if the user explicitly requests a different language for the plan (e.g. "write the plan in German"), use that language for the plan body and section headings.
- Questions asked via 'ask_user' should match the user's own language so they feel natural.

Slug policy for write_plan:
- Use a short kebab-case slug derived from the task: lowercase a-z, digits, and '-'. Example: "add-plan-mode", "fix-login-redirect".
- Do not include the ${PLAN_FILE_SUFFIX} suffix in the slug; the tool appends it.

Do not guess at APIs or file contents you have not read. If a library or framework is involved and you are unsure, use fetch_url on official docs or openrouter:web_search.`;

// Tools
export const TOOL_OUTPUT_MAX_CHARS = 8000;

export const LIST_MAX_ENTRIES = 400;
export const LIST_MAX_DEPTH = 2;
export const LIST_SKIP: Set<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  ".turbo",
]);

export const BASH_TIMEOUT_MS = 30_000;
export const BASH_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export const FETCH_DEFAULT_MAX_BYTES = 500_000;
export const FETCH_MAX_BYTES_CAP = 5_000_000;
export const FETCH_TIMEOUT_MS = 15_000;
export const FETCH_USER_AGENT = "blackbox-cli-agent/0.1";

export const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

// Images
export const IMAGE_SUPPORTED_EXTS: Set<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_PER_PROMPT = 8;

// CLI / UI
export const SPINNER_FRAMES: string[] = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];
export const SPINNER_INTERVAL_MS = 80;

export const TOOL_PREVIEW_MAX_LINES = 3;
export const TOOL_PREVIEW_MAX_CHARS = 240;
export const TOOL_LIST_ARG_PREVIEW_MAX = 120;
