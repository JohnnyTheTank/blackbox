# Implement /undo command

## Goal
Add a `/undo` command to the interactive CLI that allows users to revert the last conversation turn. This includes reverting the conversation history (messages) and attempting to revert filesystem changes made during that turn using a temporary git-based checkpoint system.

## Affected Files
- `src/index.ts`: To handle the `/undo` command, manage the state stack, and execute git commands for filesystem revert.
- `src/config.ts`: (Optional) To add any git-related constants if needed.

## Steps
1. **Git Initialization Check**: In `src/index.ts` during startup, check if the `WORKSPACE_ROOT` is a git repository. If not, `/undo` will only support history revert or warn that file revert is unavailable.
2. **Define State Interface**: Create an interface `TurnState` in `src/index.ts` to store:
   - `history`: A deep copy of the `ChatCompletionMessageParam[]`.
   - `gitCommitHash`: (Optional) The HEAD hash before the turn started.
3. **Implement State Stack**:
   - Create `stateStack: TurnState[] = []`.
   - Limit stack size (e.g., 10-20) to prevent memory issues.
4. **Pre-Turn Snapshot**:
   - Before `runOneTurn`, create a temporary git commit of the current workspace if there are changes (using `git add . && git commit -m "undo-checkpoint"`).
   - Push the current `history` and the current `git rev-parse HEAD` hash onto `stateStack`.
5. **Handle `/undo` command**:
   - In the main loop, detect `/undo`.
   - Pop the last state from `stateStack`.
   - Restore `history` from the popped state.
   - Revert filesystem: `git reset --hard <gitCommitHash>`.
   - Provide feedback: "Undid last turn (history and file changes reverted)."
   - Reset `lastToolCalls = []`.
6. **Update `/help`**: Add `/undo` to the printed help message in `printHelp()`.
7. **Cleanup**: On exit, optionally remove the temporary git commits or leave them (they are in history anyway). *Decision: Leave them as they are standard git commits, or use a specific branch/ref to avoid polluting main history.*

## Open Questions
- **Git Dependency**: What if the user doesn't have git installed or the folder isn't a repo?
  - *Response*: The command should gracefully downgrade to only undoing history and show a warning: "Git not detected; filesystem changes cannot be undone."
- **Performance**: Will committing before every turn be too slow for large repos?
  - *Response*: Use `git add .` and `git commit` cautiously. For very large repos, this might need an optimization or a toggle.

## Test Plan
1. Start `blackbox` in a git repo.
2. Run a prompt that creates a file: "create a file named test.txt with 'hello'".
3. Verify `test.txt` exists.
4. Run another prompt: "add 'world' to test.txt".
5. Verify `test.txt` content is "hello\nworld".
6. Type `/undo`.
7. Verify `test.txt` content is back to just "hello".
8. Type `/undo` again.
9. Verify `test.txt` no longer exists.
10. Verify conversation history is also reverted at each step.
11. Test `/undo` in a non-git directory and verify it only reverts history and warns the user.
