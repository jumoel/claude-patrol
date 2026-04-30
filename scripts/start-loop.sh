#!/usr/bin/env bash
# Restart loop for `pnpm start`. The server can request a restart by exiting
# with code 42 - everything else propagates and breaks the loop.
#
# Why a wrapper instead of spawning a detached child from inside node:
# when the parent node process exits, the parent shell takes the terminal
# back. An orphaned child trying to render a TUI on top of the shell prompt
# ends up fighting for stdin and looking broken. Keeping the same foreground
# process (this script) hold the terminal across restarts avoids that.

set -uo pipefail

args=("$@")
while true; do
  node src/index.js "${args[@]}"
  code=$?
  if [ "$code" -ne 42 ]; then
    exit "$code"
  fi
  # Subsequent runs are restarts - reattach existing tmux/PR sessions.
  reattach_present=0
  for a in "${args[@]:-}"; do
    if [ "$a" = "--reattach" ]; then reattach_present=1; break; fi
  done
  if [ "$reattach_present" -eq 0 ]; then
    args+=("--reattach")
  fi
done
