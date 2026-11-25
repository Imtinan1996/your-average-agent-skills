#!/usr/bin/env bash
# Link every skill in ./skills into each agent's skills directory, so the repo stays the
# single source of truth: edit a skill anywhere and the change shows up in git.
#
# Usage: ./install.sh [--dry-run] [--third-party]
#   --dry-run      print what would happen, change nothing
#   --third-party  also install the skills and plugins listed in third-party.txt
#
# Safe to re-run. An existing real directory with the same name as a skill is moved to
# <agent dir>-backup/<timestamp>/ first, never overwritten. Entries in the agent's skills
# directory that are not in ./skills are left alone.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Agent skills directories to link into. Add more here as you start using other agents.
TARGETS=(
  "${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
)

DRY_RUN=0
THIRD_PARTY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --third-party) THIRD_PARTY=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

STAMP="$(date +%Y%m%d-%H%M%S)"

run() {
  if (( DRY_RUN )); then echo "    would run: $*"; else "$@"; fi
}

link_skills() {
  local target="$1" backup="${1%/}-backup/$STAMP" src name dest
  echo "==> $target"
  run mkdir -p "$target"
  for src in "$REPO"/skills/*/; do
    src="${src%/}"
    name="$(basename "$src")"
    [[ -f "$src/SKILL.md" ]] || { echo "  skip $name: no SKILL.md"; continue; }
    dest="$target/$name"
    if [[ -L "$dest" && "$(readlink -f "$dest")" == "$(readlink -f "$src")" ]]; then
      echo "  ok      $name (already linked)"
      continue
    fi
    if [[ -e "$dest" || -L "$dest" ]]; then
      echo "  backup  $name -> $backup/$name"
      run mkdir -p "$backup"
      run mv "$dest" "$backup/$name"
    fi
    echo "  link    $name -> $src"
    run ln -s "$src" "$dest"
  done
}

install_third_party() {
  local list="$REPO/third-party.txt" kind ref repo
  echo "==> third-party ($list)"
  while read -r kind ref repo _; do
    case "$kind" in
      ''|\#*) continue ;;
      skill)
        command -v npx >/dev/null || { echo "  skip $ref: npx not found"; continue; }
        echo "  skill   $ref"
        run npx skills add "$ref" -g -y || echo "  ! failed: $ref"
        ;;
      plugin)
        command -v claude >/dev/null || { echo "  skip $ref: claude not found"; continue; }
        echo "  plugin  $ref (marketplace $repo)"
        run claude plugin marketplace add "$repo" || echo "  (marketplace $repo may already be added)"
        run claude plugin install "$ref" || echo "  ! failed: $ref"
        ;;
      *) echo "  skip unknown entry: $kind $ref" ;;
    esac
  done < "$list"
}

(( DRY_RUN )) && echo "(dry run: nothing will change)"
for t in "${TARGETS[@]}"; do link_skills "$t"; done
(( THIRD_PARTY )) && install_third_party
echo "done"
