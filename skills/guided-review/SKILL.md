---
name: guided-review
description: Build a guided, file-by-file review page for a change and open it in the browser. Each file comes with an explanation of what changed and why, a diff / full-file toggle, a reviewed mark and comments, and the page compiles the comments into feedback to paste back to an agent. Use when the user wants to walk through or review changes file by file with explanations, leave comments on them, or hand review comments back to an agent; also when they paste feedback copied from that page.
---

# Guided review

`scripts/render_review.py` turns a repo's changes plus an explanations file you write into one HTML page. The reviewer goes through the files one at a time. Each file shows your explanation (with line chips that jump to the code), a diff / full-file toggle, line and whole-file comments, and a *Mark reviewed* button. A switch includes or excludes test files. Once every file is reviewed, the page compiles all the comments, with `path:line` references and code excerpts, into text the reviewer copies back to you. Progress and comments persist in the browser.

The value of the page is the explanations. Read every file before you write one.

## Steps

1. **Scope the change.** Pick the base and the scope:
   - Uncommitted work: `--base HEAD` (the default).
   - A branch: `--base main`, or whatever base the user names. The script compares from the merge-base up to the working tree, untracked files included.
   - `--scope DIR` limits the review to one package of a monorepo.

   Then list the files:
   ```bash
   python3 ~/.claude/skills/guided-review/scripts/render_review.py --repo <repo> --base <base> [--scope <dir>] --list
   ```
   Look for files the change needs that git ignores: `git -C <repo> status --ignored --porcelain -- <scope>`. Add each one with `--include <path>` (on the `--list` run and the render run), and point out in its notes that it won't be committed as things stand. Done when the list holds every file the change touches.

2. **Write the explanations.** Read each listed file's diff (`git diff <base> -- <path>`, or the whole file if it's new) and enough of the surrounding code to say what the change serves. Write the JSON described in [references/explanations-format.md](references/explanations-format.md) to the session scratchpad. Line ranges use the current working-tree numbers, so take them from `cat -n`, not from memory. Use `notes` for real findings a reviewer should weigh: risks, leftovers, mismatches between code and docs. Done when every listed file has an entry.

3. **Render and open.**
   ```bash
   python3 ~/.claude/skills/guided-review/scripts/render_review.py --repo <repo> --base <base> [--scope <dir>] [--include <path>]... \
     --explanations <scratchpad>/explanations.json --out <scratchpad>/review.html --open
   ```
   The script prints a `WARNING` for every listed file without an explanation, and for every line range outside its file. Fix the JSON and re-render until no warnings remain. `--exclude REGEX` drops noise (generated dumps) only when the user asks for focus.

4. **Report.** Give the page's full path, and on WSL also the Windows path the script prints. Then give the file count, and anything the user should know before committing, such as git-ignored files and the most serious notes. Leave the diff itself on the page.

## When the user pastes feedback from the page

It starts with `Code review feedback on the ... changes in repo ...` and has numbered points, each with a `path:line` reference and often a code excerpt.

- Line numbers are working-tree numbers, except references marked as from the base, which point at removed lines. Read those with `git show <base>:<path>`.
- The excerpts are a snapshot from when the comment was written. Check each one against the file before you act on it.
- Address every point and reply by number. Ask about a point only when it is genuinely ambiguous.
- After making changes, offer to re-render the page. Files whose diff changed come back unreviewed; the comments stay.

## Notes

- The page is a local file containing source code. Keep it local; publish it only if the user asks.
- Syntax highlighting loads highlight.js from cdnjs. Offline, the code shows as plain text and everything else still works.
- Browser state is keyed by repo, branch, base and scope, so re-rendering the same review keeps the reviewer's progress.
