# Tools

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

Tool results are truncated at ~10,000 characters to keep context small. For
large files, `read_file` accepts optional `offset` (1-based starting line) and
`limit` (max number of lines) parameters so the agent can fetch specific ranges
(e.g. lines 50–100) instead of only the truncated beginning. `read_file` output
is prefixed with line numbers to make follow-up slices easy.
