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
| `/plans`            | Pick an open plan → View / Refine / Execute          |
| `/plans all`        | Same as `/plans`, but includes done plans            |
| `/plan done <slug>` | Mark a plan as done (renames to `*.plan.done.md`)    |
| `/jobs`             | List background jobs + subagents, pick one to tail   |
| `/jobs kill <id>`   | Kill a running job (SIGTERM → SIGKILL)               |
| `/jobs log <id>`    | Tail the log of a job                                |
| `/agents`           | List subagent definitions from `.blackbox/agents/`   |
| `/agents reload`    | Re-scan subagent markdown files from disk            |
| `/reset`            | Clear the chat history (keeps current mode)          |
| `/exit` / `exit`    | Quit (also Ctrl-C, kills remaining jobs)             |

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
| `spawn_background`      | Start a long-running shell command in the background  | agent only |
| `list_jobs`             | List all jobs (shell + subagents) with status/runtime | agent only |
| `read_job_log`          | Tail the log of a job                                 | agent only |
| `kill_job`              | Terminate a running job                               | agent only |
| `list_subagents`        | List subagent definitions from `.blackbox/agents/`    | agent only |
| `spawn_subagent`        | Dispatch a subagent asynchronously (non-blocking)     | agent only |
| `subagent_result`       | Fetch a subagent's final answer once it is done       | agent only |

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
- `/plans` lets you pick an open plan with ↑↓ + Enter. After the content
  is printed you get a second picker with three actions:
  - **View only** — just show the content and return to the prompt.
  - **Refine via prompting** — switches to plan mode and seeds a
    conversation to iterate on the plan. The agent asks what you want to
    change via `ask_user` and then overwrites the plan file via
    `write_plan` using the same slug.
  - **Execute the plan** — switches to agent mode and seeds a prompt that
    tells the agent to read the plan and implement its steps end-to-end.
- `/plans all` is the same but includes done plans in the picker. Done
  plans trigger a warning before you refine or execute them.
- `/plan done <slug>` renames a plan to `<slug>.plan.done.md` so it
  disappears from `/plans` but stays in git history.

## Background jobs

Background jobs let the agent kick off long-running shell commands — dev
servers, file watchers, builds — without blocking your chat turn. Jobs
live only for the duration of the blackbox session: when you exit (or
Ctrl-C twice), all running jobs get SIGTERM followed by SIGKILL.

```text
> start the dev server
  → spawn_background({"command":"yarn dev"})
    Started shell job sh_1 for: yarn dev

> check if it is up yet
  → read_job_log({"job_id":"sh_1","tail":20})
    [job sh_1 | shell | running]
    $ yarn dev
    vite v5.2.10  ready in 412 ms
    ➜  Local:   http://localhost:5173/
```

You can also manage jobs directly from the prompt:

```text
> /jobs
Jobs (2):
  sh_1   shell     running         12s  yarn dev
  sa_1   subagent  done             3s  scout: find all auth code

> /jobs log sh_1
> /jobs kill sh_1
```

Logs are written to `$TMPDIR/blackbox-<pid>/<job_id>.log` and capped at
10 MB per job.

## Subagents

Subagents are LLM sub-runs with their own system prompt, model and tool
whitelist, defined as markdown files with YAML frontmatter. They run
asynchronously: `spawn_subagent` returns a job id immediately, the
main agent continues working, and picks up the final answer later via
`subagent_result`. Good for delegating focused sub-tasks (codebase
recon, code review, parallel exploration).

### Agent definition format

```markdown
---
name: scout
description: Fast read-only codebase recon.
tools: read_file, list_files, fetch_url
model: anthropic/claude-sonnet-4.5
---

System prompt for the scout goes here.
```

Fields:

- `name` (required): unique identifier used by `spawn_subagent`.
- `description` (optional): shown in `list_subagents` / `/agents`.
- `tools` (optional): comma-separated list of tool names, or `*` for all.
  Unknown names raise a load error. Defaults to all tools when omitted.
- `model` (optional): OpenRouter slug; falls back to the main agent's
  model when absent.

### Discovery

On startup (and on `/agents reload`), blackbox scans in order:

1. `~/.blackbox/agents/*.md` — user-wide definitions
2. `<workspace>/.blackbox/agents/*.md` — project-local (overrides user
   on name conflict)

Starter templates live in [`examples/agents/`](examples/agents) —
`scout.md`, `planner.md`, `reviewer.md`, `worker.md`. Copy the ones you
want into `.blackbox/agents/`:

```bash
mkdir -p .blackbox/agents
cp examples/agents/scout.md .blackbox/agents/
```

### Usage from the main agent

```text
> use the scout to find all places that read process.env
  → spawn_subagent({"agent":"scout","task":"find all call sites that read process.env..."})
    Started subagent job sa_1 (agent=scout).
  → subagent_result({"job_id":"sa_1"})
    Job sa_1 is still running (2s). Check again later...
  → subagent_result({"job_id":"sa_1"})
    Job sa_1 done in 6s.
    --- result ---
    Found 3 call sites: src/config.ts:14, src/index.ts:9, src/tools.ts:7...
```

Subagents run inside the same Node process (not a subprocess). They use
live bindings to the same tool registry — if you give an agent
`tools: *` it can itself spawn background jobs or further subagents.

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
