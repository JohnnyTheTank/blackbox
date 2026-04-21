# blackbox

Simple CLI coding agent in TypeScript that uses tool-calling-capable LLMs via the [OpenRouter](https://openrouter.ai) API. 

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

- **Local tools**: `read_file`, `list_files`, `edit_file`,
  `execute_bash`, `fetch_url`, plus two OpenRouter server tools
  (`web_search`, `datetime`).
- **Workspace sandbox**: file tools are hard-pinned to `cwd`;
  `execute_bash` runs with `cwd` as its working directory.
- **Agentic loop**: up to 50 iterations per prompt, tool calls executed
  and fed back automatically.
- **Background jobs**: `spawn_background` runs long-lived shell commands
  (like `yarn dev`) without blocking the chat. `list_jobs`, `read_job_log`,
  `kill_job` manage them. All jobs die with the session.
- **Subagents**: `spawn_subagent` dispatches a named subagent (defined in
  `.blackbox/agents/*.md`) asynchronously with its own system prompt,
  model and tool whitelist. Fetch the answer later via `subagent_result`.
- **Multi-turn chat** with history; `/clear` clears it.
- **Model switching** via `/model <slug>` or `--model`.
- **Vision**: local images, URLs, and macOS clipboard (`/paste`) are
  auto-attached for vision-capable models.
- **`@`-references**: press `@` while typing to open a filterable picker
  over workspace files and folders; the picked path is inserted into your
  prompt and its content (or a directory listing) is attached automatically
  on submit.

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
| `/plans`            | Pick an open plan → View / Refine / Execute          |
| `/plans all`        | Same as `/plans`, but includes done plans            |
| `/plan done <slug>` | Mark a plan as done (renames to `*.plan.done.md`)    |
| `/jobs`             | List background jobs + subagents, pick one to tail   |
| `/jobs kill <id>`   | Kill a running job (SIGTERM → SIGKILL)               |
| `/jobs log <id>`    | Tail the log of a job                                |
| `/agents`           | List subagent definitions from `.blackbox/agents/`   |
| `/agents reload`    | Re-scan subagent markdown files from disk            |
| `/refs reload`      | Re-scan the workspace for `@`-reference autocomplete |
| `/clear`            | Clear the chat history (keeps current mode)          |
| `/exit` / `exit`    | Quit (also Ctrl-C, kills remaining jobs)             |

Full list of tool-capable models:
<https://openrouter.ai/models?supported_parameters=tools&fmt=cards&categories=programming>

## Documentation

Deep-dive guides live in [`docs/`](docs/):

- [Tools](docs/tools.md) — full tool reference and truncation rules
- [Plan mode](docs/plan-mode.md) — read-only planning workflow
- [Background jobs](docs/background-jobs.md) — long-running shell commands
- [Subagents](docs/subagents.md) — async LLM sub-runs with own prompt/tools
- [`@`-references](docs/references.md) — inlining files/folders into prompts
- [Images](docs/images.md) — vision input, `/paste`, limits

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
