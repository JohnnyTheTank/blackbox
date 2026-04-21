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

export const CURATED_MODELS: string[] = [
  "openrouter/elephant-alpha",
  "z-ai/glm-4.5-air:free",
  "anthropic/claude-sonnet-4.5",
  "google/gemini-3-flash-preview",
  "nvidia/nemotron-3-super-120b-a12b:free",
];

export const VISION_HINTS: RegExp[] = [
  /claude/i,
  /gemini/i,
  /gpt-4/i,
  /gpt-5/i,
  /grok.*vision/i,
  /qwen.*vl/i,
  /llama.*vision/i,
  /pixtral/i,
  /mistral.*pixtral/i,
  /internvl/i,
];

// Agent loop
export const MAX_ITER = 50;
export const TOOL_CALL_ARG_PREVIEW_MAX = 200;

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
