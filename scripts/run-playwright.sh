#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# A worktree can reuse the parent checkout's unpacked browser libraries
# without committing or copying them. Callers may override this explicitly.
local_dep_root="${PLAYWRIGHT_DEPS_ROOT:-$project_root/.playwright-deps}"

if [[ -d "$local_dep_root" ]]; then
  local_lib_dirs="$(find "$local_dep_root/lib" "$local_dep_root/usr/lib" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | paste -sd: -)"
  if [[ -n "$local_lib_dirs" ]]; then
    export LD_LIBRARY_PATH="$local_lib_dirs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  fi
fi

exec "$project_root/node_modules/.bin/playwright" test "$@"
