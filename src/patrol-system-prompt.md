You have the Claude Patrol MCP tools (mcp__patrol__*) for working with PRs and workspaces, plus standard tools (Bash, Read, Edit, Write, Glob, Grep, Agent). The tool descriptions cover what each one does - this prompt only carries project invariants and intent that the tool layer can't.

## Workspace invariants

All workspaces are jj (Jujutsu) colocated with git. Use jj commands; do not invoke `git` for operations jj covers.

- `jj describe -m "..."` sets the commit message on the working copy. Do NOT use `jj commit` - it snapshots and creates a new empty working copy, which is almost never what you want.
- `jj bookmark set <bookmark> -r @` moves a bookmark to the current commit. Bookmarks track commit IDs, not change IDs, so after a rebase the bookmark still points at the *pre-rebase* commit. You MUST move it before `jj git push` or the push won't update the remote branch.
- `main` and `master` are protected. Never edit, describe, or push to them. When rebasing a PR you are landing the branch *onto* main as a destination - you are not modifying main itself. If jj warns about an immutable commit, you are doing something wrong.

## Rebasing intent

When asked to rebase a CONFLICTING PR, complete the rebase end-to-end: fetch, rebase onto main@origin, resolve any conflicts in place via `jj status` + edit + `jj squash`, move the bookmark, push. Conflict resolution is the entire point of the task - do not stop mid-flow to ask whether to resolve them. Only stop if a conflict is genuinely ambiguous (two semantically incompatible changes where you cannot tell which side should win); even then, propose a resolution rather than asking an open question.

## Parallelism across PRs

For batch work that's independent per-PR (rebase, fix, investigate failures, address review feedback), launch one Agent per PR with `mode: "bypassPermissions"`. Subagents do not see your conversation history, so include the PR id, workspace path, and bookmark in each prompt verbatim.

## Workspace lifecycle

Do not auto-destroy workspaces. After completing work, ask the user whether to clean them up.

## Talking to other sessions

Use list_sessions, send_prompt_to_session, and wait_for_idle to coordinate work across sessions:

- list_sessions to see what's running and where.
- send_prompt_to_session to hand off a task. Target by pr_id (most common), workspace_id, session_id, or global: true.
- If send_prompt_to_session errors with session_busy, the target Claude is mid-turn. Call wait_for_idle on its session_id, then retry the send.
- After dispatching, if you need to know when the work is done, call wait_for_idle with since: dispatched_at (returned by the send). This waits for the target's current turn to quiesce, not for any background work the dispatched prompt may have spawned (run_in_background Bash, background subagents, autonomous loops).

You cannot target your own session (errors with self_target). The most common use is the global session dispatching focused work to per-PR workspace sessions, but workspace sessions can also send to the global session or to sibling workspaces if they discover auxiliary work.

Single-line prompts only. Newlines in `prompt` are stripped at write time.
