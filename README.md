# blackbox

A minimal CLI coding agent (~300 lines of TypeScript) that talks to
tool-calling-capable LLMs through the [OpenRouter](https://openrouter.ai) API.
Inspired by the video _"How does Claude Code actually work?"_ — a simple
"harness" with four tools and a small agentic loop.

## Features

- **Four tools**: `read_file`, `list_files`, `edit_file`, `execute_bash`
- **Workspace sandbox**: All file access is limited to the directory the CLI is
  started from (`WORKSPACE_ROOT`). `execute_bash` runs with
  `cwd=WORKSPACE_ROOT`.
- **Agentic loop**: Up to 25 iterations per prompt; tool calls are executed
  automatically and fed back to the model.
- **Model switching**: slash command `/model <slug>` or CLI flag `--model`.
- **Multi-turn chat**: History is kept between prompts; `/reset` clears it.

## Setup

Requirement: Node.js >= 20.12 (`process.loadEnvFile` is used internally).

```bash
cp .env.example .env
# put your OPENROUTER_API_KEY into .env
npm install
```

## Use it in any project

The CLI uses **the directory it is started from** as its sandbox root, so the
typical flow is: install once, then `cd` into any project and run `blackbox`.

### Option A — global command via `npm link` (recommended)

From the blackbox repo:

```bash
npm link       # creates a global 'blackbox' command
```

Then, from any project folder:

```bash
cd ~/code/some-other-project
blackbox
# or: blackbox --model openai/gpt-5
```

To uninstall:

```bash
npm run unlink
```

### Option B — run from the repo without linking

```bash
cd ~/code/some-other-project
/path/to/blackbox/bin/blackbox.mjs
```

Or inside the blackbox repo itself:

```bash
npm run dev                 # operates on the blackbox repo as workspace
npm run dev -- --model openai/gpt-5
```

### How `.env` is resolved

The API key is always loaded from the `.env` **inside the blackbox install
directory** (not from the target project). You configure the key once and can
then use `blackbox` in any project without exposing the key to it.

## Slash commands

| Command          | Effect                                             |
| ---------------- | -------------------------------------------------- |
| `/help`          | Show the help                                      |
| `/model`         | Show the current model                             |
| `/model <slug>`  | Switch model (e.g. `/model google/gemini-2.5-pro`) |
| `/models`        | Curated list of common tool-capable models         |
| `/reset`         | Clear the chat history                             |
| `/exit` / `exit` | Quit (also Ctrl-C)                                 |

Full list of tool-capable models:
<https://openrouter.ai/models?supported_parameters=tools>

## Tools

| Tool           | Parameters              | Sandbox               |
| -------------- | ----------------------- | --------------------- |
| `read_file`    | `path`                  | hard (`assertInside`) |
| `list_files`   | `path?` (default: root) | hard (`assertInside`) |
| `edit_file`    | `path`, `content`       | hard (`assertInside`) |
| `execute_bash` | `command`               | `cwd`-pinned          |

Tool results are truncated at ~8000 characters to keep the context small.

## Project layout

```
src/
  index.ts     # CLI REPL, slash commands, model switching
  agent.ts     # OpenAI SDK client + agentic loop
  tools.ts     # JSON schemas + local tool implementations
  sandbox.ts   # WORKSPACE_ROOT + assertInside() guard
```

## Security warning (YOLO mode)

This agent is intentionally minimal and does **not** ask for confirmation
before modifying files or running shell commands. The workspace sandbox
protects `read_file`/`list_files`/`edit_file` hard against traversal;
`execute_bash` is `cwd`-pinned but could in theory escape the workspace via
absolute paths (`cat /etc/hosts`) or an explicit `cd /tmp`.

**Recommendations:**

- Always start the CLI from a test repo, not from your home directory.
- Do not leave sensitive sessions open (SSH agent, password manager) while the
  agent is running.
- For real sandboxing, wrap it in a container (Docker) or `bwrap`.

## Typecheck

```bash
npm run typecheck
```
