# blackbox

A minimal CLI coding agent in TypeScript that talks to tool-calling-capable
LLMs through the [OpenRouter](https://openrouter.ai) API. Inspired by the video
_"How does Claude Code actually work?"_ — a simple "harness" with a handful of
tools and a small agentic loop.

## Features

- **Seven tools**: file system (`read_file`, `list_files`, `edit_file`), shell
  (`execute_bash`), HTTP (`fetch_url`), plus OpenRouter server tools for web
  search and the current date/time.
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

## Example prompts

Typical one-liners that exercise the different tools:

```text
> explain the stack of this project
> find all TODO comments under src/ and fix them
> summarize the docs at https://vitejs.dev/guide/
> search the web for the latest React 19 release notes
> what time is it in Berlin right now?
```

The agent picks the right tools on its own (e.g. `list_files` + `read_file` for
the first prompt, `fetch_url` for the third, `openrouter:web_search` for the
fourth, `openrouter:datetime` for the last).

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

### Local (function tools)

| Tool           | Parameters              | Sandbox / Notes                                                                             |
| -------------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| `read_file`    | `path`                  | hard (`assertInside`)                                                                       |
| `list_files`   | `path?` (default: root) | hard (`assertInside`)                                                                       |
| `edit_file`    | `path`, `content`       | hard (`assertInside`)                                                                       |
| `execute_bash` | `command`               | `cwd`-pinned                                                                                |
| `fetch_url`    | `url`, `max_bytes?`     | none (network); 15s timeout, 500 KB default cap; HTML stripped to text, JSON pretty-printed |

### Remote (OpenRouter server tools)

These are executed by OpenRouter itself — the model decides when to call them
and the result is transparently injected into the conversation.

| Tool                    | Purpose                             | Pricing                            |
| ----------------------- | ----------------------------------- | ---------------------------------- |
| `openrouter:web_search` | Real-time web search with citations | ~$4 per 1000 results (Exa default) |
| `openrouter:datetime`   | Current date and time               | free                               |

See the [OpenRouter docs](https://openrouter.ai/docs/guides/features/server-tools/web-search)
for configuration options (search engine, domain filters, etc.).

Tool results are truncated at ~8000 characters to keep the context small.

## Project layout

```
bin/
  blackbox.mjs   # launcher that spawns tsx on src/index.ts
src/
  index.ts       # CLI REPL, slash commands, model switching
  agent.ts       # OpenAI SDK client + agentic loop
  tools.ts       # tool schemas + local tool implementations
  sandbox.ts     # WORKSPACE_ROOT + assertInside() guard
package.json
.env.example
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
- `fetch_url` follows redirects and accepts any public http(s) URL. It does not
  know which hosts are "internal" — it could in theory reach
  `http://localhost:…` or intranet URLs. Don't run the agent on machines with
  sensitive internal services unless you're comfortable with that.
- For real sandboxing, wrap it in a container (Docker) or `bwrap`.

## Scripts

| Script              | What it does                                      |
| ------------------- | ------------------------------------------------- |
| `npm run dev`       | Run the CLI against the blackbox repo itself      |
| `npm run typecheck` | `tsc --noEmit`                                    |
| `npm run link`      | Register the global `blackbox` command (npm link) |
| `npm run unlink`    | Remove the global `blackbox` command              |
