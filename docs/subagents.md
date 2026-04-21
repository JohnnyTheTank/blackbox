# Subagents

Subagents are LLM sub-runs with their own system prompt, model and tool
whitelist, defined as markdown files with YAML frontmatter. They run
asynchronously: `spawn_subagent` returns a job id immediately, the
main agent continues working, and picks up the final answer later via
`subagent_result`. Good for delegating focused sub-tasks (codebase
recon, code review, parallel exploration).

## Agent definition format

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

## Discovery

On startup (and on `/agents reload`), blackbox scans in order:

1. `~/.blackbox/agents/*.md` — user-wide definitions
2. `<workspace>/.blackbox/agents/*.md` — project-local (overrides user
   on name conflict)

Starter templates live in [`../examples/agents/`](../examples/agents) —
`scout.md`, `planner.md`, `reviewer.md`, `worker.md`. Copy the ones you
want into `.blackbox/agents/`:

```bash
mkdir -p .blackbox/agents
cp examples/agents/scout.md .blackbox/agents/
```

## Usage from the main agent

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
