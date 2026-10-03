#!/usr/bin/env bash
#
# Isolated worktree for one agent working on one task.
#
# ## Why this exists
#
# The evidence in docs/parallel-work.md is that CHANGELOG.md, AGENTS.md and
# package.json were touched by 5 of the last 5 commits. Those are exactly the
# files parallel agents reach for, so two agents on one working tree collide by
# construction. Each agent therefore gets its own worktree, its own branch, its
# own artifacts directory and its own fixture port, and only the integrator ever
# writes to main.
#
# ## The port trap
#
# The fixture port is set by FIXTURE_PORT, not by BASE_URL. scripts/serve.mjs
# reads FIXTURE_PORT; playwright.config.ts waits on BASE_URL. Setting only
# BASE_URL leaves the server on 4311 and Playwright waiting on the other port,
# which fails after 30 seconds with "Timed out waiting from config.webServer".
# Both must be set, and this script sets both from one slot number.
#
# Usage:
#   scripts/agent-worktree.sh create <name> [base-ref] [zone-file]
#   scripts/agent-worktree.sh list
#   scripts/agent-worktree.sh env <name>
#   scripts/agent-worktree.sh verify <name>
#   scripts/agent-worktree.sh remove <name> [--force]
#
set -euo pipefail

REPO="${QUALITYFORGE_REPO:-$HOME/qualityforge}"
ROOT="$HOME/.agents/wt"
SLOT_BASE=4411
MAX_SLOTS=12

die() { echo "agent-worktree: $*" >&2; exit 1; }

require_repo() {
  [ -d "$REPO/.git" ] || [ -f "$REPO/.git" ] || die "репозиторий не найден: $REPO (задайте QUALITYFORGE_REPO)"
}

# Port slot for a name.
#
# The port is read from the worktree's own file when one exists, so an existing
# allocation is always honoured. A hash was tried first and rejected: five names
# collided modulo 12 often enough that two agents would fight over a port, which
# is the exact failure this script exists to prevent.
#
# Allocation is therefore "lowest free slot", computed by looking at what is
# actually on disk. Guaranteed unique, not probably unique.
slot_file() { echo "$ROOT/$1/port"; }

slot_of() {
  local name="$1"
  if [ -f "$(slot_file "$name")" ]; then
    cat "$(slot_file "$name")"
    return
  fi
  local n
  for n in $(seq 0 $((MAX_SLOTS - 1))); do
    if [ -n "$(grep -lx "$n" "$ROOT"/*/port 2>/dev/null | head -1)" ]; then
      continue
    fi
    echo "$n"
    return
  done
  die "заняты все $MAX_SLOTS портов"
}

# Refuse a new allocation that an existing worktree already claims.
assert_free() {
  local slot="$1" holder
  for holder in "$ROOT"/*/port; do
    [ -f "$holder" ] || continue
    if [ "$(cat "$holder")" = "$slot" ]; then
      die "порт-слот $slot уже занят worktree $(basename "$(dirname "$holder")")"
    fi
  done
}

cmd_create() {
  local name="${1:-}" base="${2:-HEAD}" zone_file="${3:-}"
  [ -n "$name" ] || die "нужно имя: create <name> [base-ref] [zone-file]"
  require_repo
  [[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "имя должно быть в lowercase через дефис: $name"

  local dir="$ROOT/$name"
  local branch="qf/$name"
  [ -d "$dir" ] && die "worktree уже существует: $dir"
  git -C "$REPO" show-ref --verify --quiet "refs/heads/$branch" && die "ветка уже существует: $branch"

  # Allocate before creating anything, since allocation only reads the port
  # files of worktrees that already exist. Write the file only once the
  # directory exists.
  local slot; slot=$(slot_of "$name")
  assert_free "$slot"

  mkdir -p "$ROOT"
  git -C "$REPO" worktree add -q -b "$branch" "$dir" "$base"
  echo "$slot" > "$(slot_file "$name")"

  # node_modules is 88 MB and identical in every worktree. A symlink keeps N
  # agents from costing N copies. Treat it as read-only: if a task needs a
  # dependency change, that is an integrator decision, not an agent's.
  [ -e "$dir/node_modules" ] || ln -s "$REPO/node_modules" "$dir/node_modules"

  # Install the scope gate before handing the worktree over. A zone written in a
  # document is a memory test with four agents running; a pre-commit hook is a
  # gate. The hot files are listed as forbidden explicitly, because "not in my
  # zone" is weaker than "listed as someone else's".
  # core.hooksPath, not .git/hooks: in a worktree .git is a FILE, so there is
  # no hooks directory to write into.
  #
  # extensions.worktreeConfig is not optional here. Without it, git writes
  # config from inside a worktree into the COMMON config file, so four agents
  # setting core.hooksPath overwrite each other and every agent ends up gated by
  # whoever wrote last. That happened: all four worktrees pointed at the
  # read-only agent's hooks, whose zone forbids everything, so three agents could
  # not commit at all. One of them found it by hitting it.
  mkdir -p "$dir/.githooks"
  git -C "$REPO" config extensions.worktreeConfig true
  git -C "$dir" config --worktree core.hooksPath "$dir/.githooks"

  if [ -n "$zone_file" ]; then
    [ -f "$zone_file" ] || die "нет файла зоны: $zone_file"
    cp "$zone_file" "$dir/.agent-zone"
    cat > "$dir/.githooks/pre-commit" <<HOOK
#!/usr/bin/env bash
QUALITYFORGE_WORKTREE="$dir" QUALITYFORGE_ZONE="$dir/.agent-zone" \\
  "$dir/scripts/agent-scope.sh" check
HOOK
  else
    cat > "$dir/.githooks/pre-commit" <<HOOK
#!/usr/bin/env bash
echo "agent-worktree: коммитить нельзя — worktree выдан без зоны." >&2
echo "Спроси интегратора." >&2
exit 1
HOOK
  fi
  chmod +x "$dir/.githooks/pre-commit"

  cat <<EOF
  создан:  $dir
  ветка:   $branch  (от $base)
  порт:    $((SLOT_BASE + slot))
  проверка изоляции перед началом работы:
    cd $dir && FIXTURE_PORT=$((SLOT_BASE + slot)) BASE_URL=http://127.0.0.1:$((SLOT_BASE + slot)) npm run test:unit
EOF
}

cmd_list() {
  require_repo
  echo "worktrees в $ROOT:"
  if [ -d "$ROOT" ]; then
    for dir in "$ROOT"/*/; do
      [ -d "$dir" ] || continue
      name=$(basename "$dir")
      printf "  %-14s порт %-5s %s\n" "$name" "$((SLOT_BASE + $(slot_of "$name")))" "$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    done
  fi
  echo "основной:"
  git -C "$REPO" worktree list | sed 's/^/  /'
}

cmd_env() {
  local name="${1:-}" slot
  [ -n "$name" ] || die "нужно имя"
  slot=$((SLOT_BASE + $(slot_of "$name")))
  cat <<EOF
export FIXTURE_PORT=$slot
export BASE_URL=http://127.0.0.1:$slot
EOF
}

cmd_verify() {
  local name="${1:-}" dir slot
  [ -n "$name" ] || die "нужно имя"
  dir="$ROOT/$name"
  [ -d "$dir" ] || die "нет worktree: $dir"
  slot=$((SLOT_BASE + $(slot_of "$name")))
  echo "проверка изоляции: $name"
  echo "  порт $slot; главное дерево не должно быть задето"
  ( cd "$dir" && FIXTURE_PORT="$slot" BASE_URL="http://127.0.0.1:$slot" npm run test:unit )
}

cmd_remove() {
  local name="${1:-}" force="${2:-}"
  [ -n "$name" ] || die "нужно имя"
  local dir="$ROOT/$name" branch="qf/$name"
  [ -d "$dir" ] || die "нет worktree: $dir"

  if [ "$force" != "--force" ]; then
    # Removing a worktree with unmerged work is how an agent's afternoon
    # disappears. Refuse by default and name the branch so it can be recovered.
    if ! git -C "$dir" diff --quiet HEAD 2>/dev/null || [ -n "$(git -C "$dir" status --porcelain)" ]; then
      die "в $name есть незакоммиченные изменения. ветка $branch сохранится в репозитории.
  Закоммитьте или удалите worktree с --force, если работа потеряна."
    fi
  fi

  git -C "$REPO" worktree remove --force "$dir"
  git -C "$REPO" worktree prune
  echo "удалён worktree $dir"
  echo "  ветка $branch осталась в репозитории: git -C $REPO log --oneline $branch"
}

case "${1:-}" in
  create) shift; cmd_create "$@" ;;
  list)   cmd_list ;;
  env)    shift; cmd_env "$@" ;;
  verify) shift; cmd_verify "$@" ;;
  remove) shift; cmd_remove "$@" ;;
  *) die "команда: create | list | env | verify | remove" ;;
esac