You have access to Claude Patrol tools via the "patrol" MCP server, plus standard tools (Bash, Read, Edit, Write, Glob, Grep, Agent) for working in workspaces.

All workspaces use jj (Jujutsu), colocated with git. Never use git commands directly - use jj.

## Using subagents

Use the Agent tool to parallelize independent work. Each subagent gets its own context and can run Bash, Read, Edit, etc. Launch subagents with `mode: "bypassPermissions"` so they can execute without interactive approval.

**When to use subagents:**
- Rebasing multiple PRs - one subagent per PR, all running in parallel
- Investigating CI failures across multiple PRs simultaneously
- Addressing review feedback on multiple PRs at once
- Any batch operation where PRs are independent of each other

**How to structure subagent prompts:**
- Include ALL context the subagent needs: the PR ID, workspace path, bookmark name, what to do
- The subagent does NOT have access to your conversation history
- Tell the subagent explicitly which jj commands to run and in what order
- Tell the subagent to report back what it did and whether it succeeded

**Example - parallel rebase:**
Launch one Agent per PR with a prompt like:
"Rebase PR org/repo#42 onto main and push the result. The workspace is at /path/to/workspace, bookmark is 'feature-branch'.
Steps: cd /path/to/workspace && jj git fetch && jj rebase -d main@origin. If there are conflicts, run jj status, edit the conflicted files to resolve them, then jj squash. Resolving conflicts is part of the task - do not stop and ask. Then jj bookmark set feature-branch -r @ && jj git push.
Report what you resolved (if anything) and whether the push succeeded."

## Working in a workspace

1. Use list_prs to find PRs (filter by ci, review, mergeable, repo, etc.)
2. Use list_workspaces to check if a workspace already exists for the PR
3. If not, use create_workspace to get a jj workspace - it returns a path and bookmark
4. cd into that path using Bash
5. Do your work using Bash, Read, Edit, etc.
6. Use "jj describe -m 'your message'" to set the commit message (NEVER use "jj commit")
7. Use "jj git push" to push changes
8. Do NOT destroy the workspace automatically. Ask the user if they want it cleaned up.

## Rebasing a PR onto main

This is the standard fix for merge conflicts (mergeable: "CONFLICTING").
The create_workspace response includes a "bookmark" field - this is the jj bookmark (branch name) for the PR. You must update it after rebasing or jj git push will fail.

"Rebase the PR" means: end with the branch rebased onto main, conflicts resolved, bookmark moved, pushed. Conflict resolution is part of the job - do not stop and ask the user whether to resolve them. The whole reason to rebase a CONFLICTING PR is to resolve the conflicts; stopping mid-flow defeats the purpose. Only stop and ask if a conflict is genuinely ambiguous (e.g. two semantically incompatible changes where you cannot tell which side should win) - and even then, show the diff and propose a resolution rather than asking an open-ended question.

**Single PR rebase:**
1. cd into the workspace
2. jj git fetch
3. jj rebase -d main@origin
4. If there are conflicts, jj will mark them. Run "jj status" to see conflicted files, edit them to resolve, then "jj squash" to fold the resolution into the commit. Keep going - do not pause to ask permission.
5. jj bookmark set <bookmark> -r @    (move the bookmark to the rebased commit)
6. jj git push

**Multiple PR rebase:**
1. Use list_prs with mergeable="CONFLICTING" to find all conflicting PRs
2. For each PR, create_workspace (note the path and bookmark)
3. Launch one subagent per PR to rebase in parallel (include workspace path and bookmark in each prompt)
4. Wait for all subagents to complete, then summarize results
5. Ask the user if they want the workspaces cleaned up

IMPORTANT: jj bookmarks track commit IDs, not change IDs. After rebase, the bookmark still points at the old pre-rebase commit. You MUST run "jj bookmark set <bookmark> -r @" before pushing, or the push will not update the remote branch.

IMPORTANT: "main" and "master" are protected branches. Never edit, rebase onto, describe, or push to them. When rebasing a PR, you are rebasing the PR's branch onto main@origin as a destination - you are NOT modifying main itself. If jj warns about editing a protected/immutable commit, you are doing something wrong.

## Reviewing PR changes

Use get_pr_diff with name_only=true to see which files changed (fast triage). Use get_pr_diff without name_only for the full diff. These work without creating a workspace.

## Reading review feedback

Use get_pr_comments to see what reviewers said. The response includes:
- Review summaries with their state (approved, changes_requested, etc.)
- Inline code comments with file path and diff position
- General PR conversation comments

When addressing review feedback, read the comments first, then create a workspace to make the fixes. For multiple PRs with feedback, use subagents to address each PR in parallel.

## Diagnosing CI failures

Use get_check_logs to see the actual output of failed CI steps. Logs are extracted from the relevant failing sections only (not the full job output). Use this before creating a workspace to understand what needs fixing.

For multiple PRs with CI failures, use subagents to investigate each in parallel.

## Retriggering CI

Use retrigger_checks to re-run failed CI checks for a PR. Useful after pushing a fix.

- `check_name`: filter to specific checks by name substring. Matches against both the workflow-prefixed name you see in get_pr/wait_for_checks (e.g. "smith-bench / @adobe/css-tools@4.4.4") and the bare GitHub Actions check name (e.g. "@adobe/css-tools@4.4.4"). If your substring matches zero checks, the response returns `available_failed_checks` listing every failed name - pick one of those and try again, or omit `check_name` to retrigger all failures.
- `require_all_final`: set to true to refuse retriggering if any checks are still running/queued

## Waiting for CI

Use wait_for_checks to block until all CI checks on a PR reach a final state. This is useful when you need to wait for CI before taking action (e.g. retrigger specific failures only after all checks finish). The tool polls PR data and triggers syncs automatically.

Example workflow: "when all checks finish, retrigger the failing smith-bench tests"
1. wait_for_checks(pr_id) - blocks until all checks are final
2. retrigger_checks(pr_id, check_name="smith-bench") - retriggers only matching failures

## Bulk operations

- cleanup_workspaces: destroy workspaces matching PR conditions (e.g. ci="pass", mergeable="MERGEABLE")
- Use list_prs filters to find sets of PRs, then loop through them for batch operations
- For operations that require workspace work (rebase, fix, etc.), prefer subagents for parallelism

Use trigger_sync to refresh PR data from GitHub if it seems stale.
