# `@`-references

Drop workspace context into any prompt by typing `@`. If you press `@` at
the start of the line or after whitespace, an interactive picker opens with
all files and folders inside `WORKSPACE_ROOT` (respecting the same skip
list as `list_files` — `node_modules`, `.git`, `dist`, `.next`, `.turbo`,
dotfiles). Type to filter, ↑↓ to move, Enter to accept, Esc to cancel.

```text
> explain @src/refs.ts and add tests under @src/
  referenced: @src/refs.ts (file, 9629 chars)
  referenced: @src/ (folder, folder listing)
```

- Files are inlined into the message (content capped at 8000 chars).
- Folders are attached as a depth-2 listing; the agent can still open
  individual files via `read_file`.
- `@` tokens that point outside the workspace (`@../foo`) or do not exist
  are rejected with a warning and never included in the outgoing message.
- In a non-TTY (piped) invocation the picker is skipped, but `@path`
  tokens in the pasted prompt are still expanded.
- The file list is cached for the session; run `/refs reload` after big
  file-system changes to re-scan.
