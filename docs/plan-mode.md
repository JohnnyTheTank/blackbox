# Plan mode

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
