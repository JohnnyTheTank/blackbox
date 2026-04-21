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

| Command             | Effect                                               |
| ------------------- | ---------------------------------------------------- |
| `/help`             | Show the help                                        |
| `/model`            | Show the current model                               |
| `/model <slug>`     | Switch model (e.g. `/model google/gemini-2.5-pro`)   |
| `/models`           | Curated list of common tool-capable models           |
| `/paste [text]`     | Attach the macOS clipboard image (optional text)     |
| `/plan`             | Enter plan mode (read-only, produces markdown plans) |
| `/agent`            | Leave plan mode, back to the default agent mode      |
| `/plans`            | List + pick open plans (↑↓ + Enter to open)          |
| `/plans all`        | List + pick open and done plans                      |
| `/plan done <slug>` | Mark a plan as done (renames to `*.plan.done.md`)    |
| `/reset`            | Clear the chat history (keeps current mode)          |
| `/exit` / `exit`    | Quit (also Ctrl-C)                                   |

Full list of tool-capable models:
<https://openrouter.ai/models?supported_parameters=tools&fmt=cards&categories=programming>

## Tools

| Tool                    | Purpose                                               | Mode       |
| ----------------------- | ----------------------------------------------------- | ---------- |
| `read_file`             | Read a file inside the sandbox                        | both       |
| `list_files`            | List files/subdirs (depth 2)                          | both       |
| `edit_file`             | Overwrite a file inside the sandbox                   | agent only |
| `execute_bash`          | Run a shell command (30s timeout)                     | agent only |
| `fetch_url`             | Fetch a public http(s) URL; HTML stripped to text     | both       |
| `openrouter:web_search` | Real-time web search with citations (~$4 / 1k hits)   | both       |
| `openrouter:datetime`   | Current date and time (free)                          | both       |
| `ask_user`              | Ask the developer a clarifying question (MC/text)     | plan only  |
| `write_plan`            | Persist the final plan as `.blackbox/plans/*.plan.md` | plan only  |

Tool results are truncated at ~8000 characters to keep context small.

## Plan mode

A read-only mode inspired by Cursor's plan mode. Use it when you want the
agent to think through a change before touching any files.

```text
> /plan
Plan mode active. Read-only; writes plans to .blackbox/plans/<slug>.plan.md.
plan > add a dark-mode toggle to the settings screen
? Which state layer should hold the theme preference?
  › localStorage only
    React context + localStorage
    Global store (Redux/Zustand)
...
Wrote plan to .blackbox/plans/dark-mode-toggle.plan.md (2134 bytes)

plan > /agent
Agent mode active.
> implement .blackbox/plans/dark-mode-toggle.plan.md
...

> /plan done dark-mode-toggle
Marked plan done: .blackbox/plans/dark-mode-toggle.plan.md → .blackbox/plans/dark-mode-toggle.plan.done.md
```

- In plan mode, `edit_file` and `execute_bash` are disabled. The agent can
  only read code, browse docs, ask you clarifying questions via `ask_user`,
  and produce a single markdown plan via `write_plan`.
- Plans always land in `.blackbox/plans/<slug>.plan.md` so you can commit
  them to your repo as an audit trail of planned work.
- Plan bodies are written in English by default. Ask explicitly (e.g.
  "schreib den Plan auf Deutsch") to get another language; clarifying
  questions still follow your own language.
- `/plans` lists only open plans and lets you pick one with ↑↓ + Enter to
  print its content in the terminal; done plans are hidden. `/plans all`
  includes done plans in the picker. `/plan done <slug>` renames a plan to
  `<slug>.plan.done.md` so it disappears from `/plans` but stays in git
  history.

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
