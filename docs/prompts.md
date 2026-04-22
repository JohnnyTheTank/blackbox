# System prompts

Both of blackbox's top-level system prompts — the default **agent** prompt
and the **plan mode** prompt — live in plain markdown files on disk. You
can edit them without rebuilding, or override them per project / per user
without touching the blackbox checkout at all.

## Where prompts come from

On every fresh conversation (startup, `/clear`, `/plan`, `/agent`, and
when opening a plan via `/plans`), blackbox re-reads the active prompt
file. The first match in this chain wins:

1. `<workspace>/.blackbox/prompts/<name>.md` — **project override**, commit
   this to share a house style per repo.
2. `~/.blackbox/prompts/<name>.md` — **user override**, applies to every
   project for the current user.
3. `<install>/prompts/<name>.md` — **builtin default**, shipped with
   blackbox itself.

`<name>` is either `agent` (default mode) or `plan` (plan mode).

Run `/prompts` inside blackbox to see which file is currently active for
each slot, and `/prompts init` to copy the builtin defaults into
`<workspace>/.blackbox/prompts/` so you can start editing them there.

## Placeholders

Prompt files may reference a few runtime values as `{{PLACEHOLDER}}`
tokens, substituted whenever the file is loaded:

| Placeholder            | Value                                              |
| ---------------------- | -------------------------------------------------- |
| `{{WORKSPACE_ROOT}}`   | Absolute path of the current workspace             |
| `{{PLANS_DIR}}`        | Directory plans are written to (`.blackbox/plans`) |
| `{{PLAN_FILE_SUFFIX}}` | Plan file suffix (`.plan.md`)                      |

Example:

```markdown
You are a blackbox agent.

WORKSPACE_ROOT: {{WORKSPACE_ROOT}}

All file access is restricted to WORKSPACE_ROOT. …
```

## Editing workflow

```bash
# Inside blackbox:
/prompts            # show active prompts + override paths
/prompts init       # scaffold editable copies in the current project
```

After `/prompts init`, edit `.blackbox/prompts/agent.md` or
`.blackbox/prompts/plan.md` in your editor. Changes take effect:

- on the next `/clear`,
- on mode switches (`/plan`, `/agent`),
- when opening a plan via `/plans` → Refine / Execute,
- or in the next blackbox session.

No restart is required — the files are re-read on demand.

## Tips

- Keep the plan-mode prompt honest about the reduced toolset. The plan
  agent has no `edit_file` or `execute_bash`; adding instructions that
  rely on them will just produce confused output.
- If you remove or empty an override file, blackbox falls back to the
  next layer in the chain (user → builtin).
- The builtin defaults in `<install>/prompts/` are your safety net — feel
  free to diff your overrides against them when things drift.
- Subagents (`.blackbox/agents/*.md`) are a separate mechanism with their
  own prompt/model/tool whitelist; see [`subagents.md`](subagents.md).
