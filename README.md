# blackbox

A minimal CLI coding agent in TypeScript that talks to tool-calling-capable
LLMs via the [OpenRouter](https://openrouter.ai) API. 

## Quickstart

```bash
git clone https://github.com/JohnnyTheTank/blackbox.git && cd blackbox
npm install
echo "OPENROUTER_API_KEY=sk-or-..." > .env
npm link           # registers the global `blackbox` command
blackbox           # run it from any project folder
```

Run `blackbox` inside any project folder — it uses the current working
directory as its sandbox. The API key is always read from the `.env` inside
the blackbox install directory, so you configure it once and never leak it
into target projects.

Requires Node.js >= 20.12.

## Features

- **Five local tools**: `read_file`, `list_files`, `edit_file`,
  `execute_bash`, `fetch_url`, plus two OpenRouter server tools
  (`web_search`, `datetime`).
- **Workspace sandbox**: file tools are hard-pinned to `cwd`;
  `execute_bash` runs with `cwd` as its working directory.
- **Agentic loop**: up to 50 iterations per prompt, tool calls executed
  and fed back automatically.
- **Multi-turn chat** with history; `/reset` clears it.
- **Model switching** via `/model <slug>` or `--model`.
- **Vision**: local images, URLs, and macOS clipboard (`/paste`) are
  auto-attached for vision-capable models.

## Slash commands

| Command          | Effect                                             |
| ---------------- | -------------------------------------------------- |
| `/help`          | Show the help                                      |
| `/model`         | Show the current model                             |
| `/model <slug>`  | Switch model (e.g. `/model google/gemini-2.5-pro`) |
| `/models`        | Curated list of common tool-capable models         |
| `/paste [text]`  | Attach the macOS clipboard image (optional text)   |
| `/reset`         | Clear the chat history                             |
| `/exit` / `exit` | Quit (also Ctrl-C)                                 |

Full list of tool-capable models:
<https://openrouter.ai/models?supported_parameters=tools&fmt=cards&categories=programming>

## Tools

| Tool                    | Purpose                                             |
| ----------------------- | --------------------------------------------------- |
| `read_file`             | Read a file inside the sandbox                      |
| `list_files`            | List files/subdirs (depth 2)                        |
| `edit_file`             | Overwrite a file inside the sandbox                 |
| `execute_bash`          | Run a shell command (30s timeout)                   |
| `fetch_url`             | Fetch a public http(s) URL; HTML stripped to text   |
| `openrouter:web_search` | Real-time web search with citations (~$4 / 1k hits) |
| `openrouter:datetime`   | Current date and time (free)                        |

Tool results are truncated at ~8000 characters to keep context small.

## Images

Any `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp` reference in your prompt is
auto-attached for vision-capable models. Local files (absolute, relative, or
with `~`) are sent as base64; http(s) URLs are passed through; `/paste`
(macOS) grabs the clipboard image. Limits: max 8 images per prompt, 10 MB
per local file.

## Security warning (YOLO mode)

This agent does **not** ask for confirmation before editing files or running
shell commands. Before letting friends loose on it:

- Run it from a throwaway repo, not `~` or a production checkout.
- `read_file` / `list_files` / `edit_file` are hard-sandboxed, but
  `execute_bash` can still touch absolute paths (`cat /etc/hosts`, `cd /tmp`).
- `fetch_url` accepts any public URL, including `http://localhost:…` and
  intranet hosts.
- Image attachments bypass the sandbox so `~/Desktop/shot.png` works — a
  mistyped path will still ship that file to OpenRouter.
- For real isolation, wrap it in Docker or `bwrap`.
