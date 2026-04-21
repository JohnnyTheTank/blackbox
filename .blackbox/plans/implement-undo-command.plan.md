# Implement /undo command

## Goal
Add a `/undo` command to the interactive CLI that allows users to revert the last conversation turn (both the user prompt and the agent's response/tool calls). Repeatedly calling `/undo` should continue to revert previous turns.

## Affected Files
- `src/index.ts`: To handle the `/undo` command in the main loop and manage a stack of conversation states.
- `src/agent.ts`: (Optional) To ensure history management is compatible, though likely handled in `index.ts`.

## Steps
1. **Define History State**: In `src/index.ts`, define a way to capture the state before each turn. Since `history` is an array of `ChatCompletionMessageParam` and is mutated by `runAgent`, we need to store snapshots of this array.
2. **Implement State Stack**:
   - Create a `historyStack: ChatCompletionMessageParam[][]` to store previous versions of the `history` array.
   - Before calling `runOneTurn` (which calls `runAgent`), push a deep copy of the current `history` to `historyStack`.
3. **Handle `/undo` command**:
   - Add a check for `entry === "/undo"` in the main loop of `src/index.ts`.
   - If `/undo` is called:
     - Check if `historyStack` is empty.
     - If not empty, pop the last state from `historyStack` and assign it to `history`.
     - Provide feedback to the user (e.g., "Undid last change.").
     - Reset `lastToolCalls` since the context changed.
     - `continue` the loop to wait for next input.
4. **Update `/help`**: Add `/undo` to the printed help message in `printHelp()`.

## Open Questions
- Should `/undo` also revert changes made to the filesystem? 
  - *Decision*: No, `/undo` in the context of a chat usually refers to the conversation history. Reverting filesystem changes (like `write_file`) is complex and risky without a full git-based undo system. The plan focus is on conversation history undo.

## Test Plan
1. Start `blackbox`.
2. Run a prompt (e.g., "hi").
3. Run another prompt (e.g., "how are you?").
4. Type `/undo`.
5. Verify that the context of "how are you?" is gone (e.g., by asking "what was my last question?").
6. Type `/undo` again.
7. Verify that the context is back to the initial state.
8. Verify that calling `/undo` when no history exists doesn't crash and gives a helpful message.
