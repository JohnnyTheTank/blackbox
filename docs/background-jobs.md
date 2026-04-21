# Background jobs

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
