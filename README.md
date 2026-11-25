<p align="center">
  <img src="assets/logo.svg" width="180" alt="Avatar: a bearded developer in sunglasses and headphones behind a laptop">
</p>

# your-average-agent-skills

Agent skills I wrote and use daily, mostly for reviewing code changes. They are written for [Claude Code](https://claude.com/claude-code) but follow the open `SKILL.md` format, so other agents that read skills can use them too.

## Skills

| Skill | What it does | How it runs |
|---|---|---|
| [`diff-viewer`](skills/diff-viewer/SKILL.md) | Renders a branch's changes, across every repo a feature touches, as one offline HTML diff viewer. Mark files viewed, jump with the keyboard, open lines in your editor, copy `file:line` references back to the agent, and see review findings inline. | Automatically, when you ask to see or review a diff in the browser |
| [`guided-review`](skills/guided-review/SKILL.md) | Builds a file-by-file review page: each file comes with an explanation of what changed and why, a diff / full-file toggle, comments and a reviewed mark. The page compiles your comments into feedback to paste back to the agent. | Automatically, when you ask to walk through changes file by file |
| [`review-branch`](skills/review-branch/SKILL.md) | Production-readiness review of a **whole feature branch** (all commits since `main`, plus uncommitted work on top) across frontend and backend repos. Ends with a verdict and a PR description. | Only when you type `/review-branch` |
| [`review-uncommitted`](skills/review-uncommitted/SKILL.md) | The same review, limited to **uncommitted work** (staged, unstaged and untracked). The branch's commits are not reviewed. | Only when you type `/review-uncommitted` |

`diff-viewer` and `guided-review` need `git` and Python 3 (standard library only).

## Install

```bash
git clone https://github.com/Imtinan1996/your-average-agent-skills.git
cd your-average-agent-skills
./install.sh --dry-run   # see what it will do
./install.sh             # symlink skills/* into ~/.claude/skills
```

The script symlinks each skill rather than copying it, so the clone stays the source of truth and `git pull` updates every agent at once. If a skill with the same name already exists as a real directory, it is moved to `~/.claude/skills-backup/<timestamp>/` first. Anything else in the skills directory is left alone. Set `CLAUDE_SKILLS_DIR` to link somewhere else, or add directories to `TARGETS` in `install.sh` for other agents.

To install a single skill without cloning, use the [skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add Imtinan1996/your-average-agent-skills@diff-viewer -g
```

## Third-party skills

[`third-party.txt`](third-party.txt) lists the skills and plugins I use daily but did not write. They stay in their own repos; this one only records where they come from.

```bash
./install.sh --third-party
```

## Adding a skill

1. Create `skills/<name>/SKILL.md` with a header whose `name` matches the folder and whose `description` says what the skill does and when to use it.
2. Put supporting files in `scripts/`, `references/` or `assets/` inside the skill's folder.
3. Run `./install.sh`.

## License

[MIT](LICENSE). The diff2html and highlight.js files bundled in `skills/diff-viewer/assets/` keep their own licenses; see [THIRD_PARTY_LICENSES.md](skills/diff-viewer/assets/THIRD_PARTY_LICENSES.md).
