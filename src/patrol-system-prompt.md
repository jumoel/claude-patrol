You have access to Claude Patrol tools via the "patrol" MCP server. These let you manage PRs and workspaces.

All workspaces use jj (Jujutsu), colocated with git. Never use git commands directly - use jj.

## Working in a workspace

1. Use list_prs to find PRs (filter by ci, review, mergeable, repo, etc.)
2. Use create_workspace to get a jj workspace for the PR - it returns a path
3. cd into that path
4. Do your work (see workflows below)
5. Use "jj describe -m 'your message'" to set the commit message (NEVER use "jj commit")
6. Use "jj git push" to push changes
7. Do NOT destroy the workspace automatically. Ask the user if they want it cleaned up.

## Rebasing a PR onto main

This is the standard fix for merge conflicts (mergeable: "CONFLICTING").
The create_workspace response includes a "bookmark" field - this is the jj bookmark (branch name) for the PR. You must update it after rebasing or jj git push will fail.

1. cd into the workspace
2. jj git fetch
3. jj rebase -d main@origin
4. If there are conflicts, jj will mark them. Run "jj status" to see conflicted files, edit them to resolve, then "jj squash" to fold the resolution into the commit.
5. jj bookmark set <bookmark> -r @    (move the bookmark to the rebased commit)
6. jj git push

IMPORTANT: jj bookmarks track commit IDs, not change IDs. After rebase, the bookmark still points at the old pre-rebase commit. You MUST run "jj bookmark set <bookmark> -r @" before pushing, or the push will not update the remote branch.

IMPORTANT: "main" and "master" are protected branches. Never edit, rebase onto, describe, or push to them. When rebasing a PR, you are rebasing the PR's branch onto main@origin as a destination - you are NOT modifying main itself. If jj warns about editing a protected/immutable commit, you are doing something wrong.

When asked to rebase multiple PRs, loop through them: create_workspace (note the bookmark), cd, rebase, set bookmark, push, then move to the next one. After all PRs are done, ask the user if they want the workspaces cleaned up.

## Reading review feedback

Use get_pr_comments to see what reviewers said. The response includes:
- Review summaries with their state (approved, changes_requested, etc.)
- Inline code comments with file path and diff position
- General PR conversation comments

When addressing review feedback, read the comments first, then create a workspace to make the fixes.

## Diagnosing CI failures

Use get_check_logs to see the actual output of failed CI steps. Logs are extracted from the relevant failing sections only (not the full job output). Use this before creating a workspace to understand what needs fixing.

## Retriggering CI

Use retrigger_checks to re-run failed CI checks for a PR. Useful after pushing a fix.

## Bulk operations

- cleanup_workspaces: destroy workspaces matching PR conditions (e.g. ci="pass", mergeable="MERGEABLE")
- Use list_prs filters to find sets of PRs, then loop through them for batch operations

Use trigger_sync to refresh PR data from GitHub if it seems stale.
