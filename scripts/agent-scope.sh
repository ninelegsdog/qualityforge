#!/usr/bin/env bash
#
# Fail a commit that touches files outside the agent's zone.
#
# ## Why this is a script and not a rule
#
# docs/parallel-work.md assigns each agent an exclusive set of files. Written as
# a rule, that is a memory test with four agents running at once. Written as a
# pre-commit hook, it is a gate. The evidence from this repository is that
# agreements between agents are worth exactly as much as the mechanism enforcing
# them: the link checker agreed with the docs until someone injected a broken link.
#
# The zone is a file in the worktree, one allowed path prefix per line. Lines
# starting with "!" are forbidden prefixes, checked first because they are the
# hot files every agent reaches for.
#
# Usage:
#   scripts/agent-scope.sh check              # staged files against the zone
#   scripts/agent-scope.sh show               # the zone and the staged files
#
set -euo pipefail

WORKTREE="${QUALITYFORGE_WORKTREE:-$(pwd)}"
ZONE_FILE="${QUALITYFORGE_ZONE:-$WORKTREE/.agent-zone}"

die() { echo "agent-scope: $*" >&2; exit 1; }

[ -f "$ZONE_FILE" ] || die "нет файла зоны: $ZONE_FILE
  Зона должна быть создана при выдаче worktree: agent-worktree.sh create <name> <base> <zone-file>"

allowed=()
forbidden=()
while IFS= read -r line; do
  case "$line" in
    '!'*) forbidden+=("${line#!}") ;;
    ''|'#'*) ;;
    *) allowed+=("$line") ;;
  esac
done < "$ZONE_FILE"

mapfile -t staged < <(git diff --cached --name-only)

if [ "${#staged[@]}" -eq 0 ]; then
  echo "agent-scope: нечего проверять, в индексе нет файлов"
  exit 0
fi

# Zone files may list directories. A prefix match has to respect the boundary, so
# "src/mcp" matches "src/mcp/server.ts" but not "src/mcpx/thing.ts".
matches_prefix() {
  local prefix="$1" path="$2"
  [ "$path" = "$prefix" ] && return 0
  case "$path" in "$prefix"/*) return 0 ;; esac
  return 1
}

violations=()
for path in "${staged[@]}"; do
  hit=1
  for prefix in "${forbidden[@]+"${forbidden[@]}"}"; do
    if matches_prefix "$prefix" "$path"; then
      violations+=("$path — запрещённая зона ($prefix)")
      hit=0
      break
    fi
  done
  [ "$hit" -eq 0 ] && continue
  for prefix in "${allowed[@]+"${allowed[@]}"}"; do
    if matches_prefix "$prefix" "$path"; then
      hit=0
      break
    fi
  done
  if [ "$hit" -eq 1 ]; then
    violations+=("$path — вне зоны")
  fi
done

if [ "${#violations[@]}" -gt 0 ]; then
  echo "agent-scope: коммит отклонён, ${#violations[@]} файл(ов) вне зоны" >&2
  echo >&2
  echo "  зона ($ZONE_FILE):" >&2
  while IFS= read -r line; do
    case "$line" in ''|'#'*) ;; *) echo "    $line" >&2 ;; esac
  done < "$ZONE_FILE"
  echo >&2
  echo "  нарушения:" >&2
  for v in "${violations[@]}"; do echo "    $v" >&2; done
  echo >&2
  echo "  Если файл действительно нужен — это не твоя зона. Сообщи интегратору," >&2
  echo "  он сделает правку сам. Не расширяй зону молча." >&2
  exit 1
fi

echo "agent-scope: OK, ${#staged[@]} файл(ов) в зоне"