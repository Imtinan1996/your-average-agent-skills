---
name: diff-viewer
description: Render a branch's changes (against main, or a base the caller names) as one self-contained HTML diff viewer, covering every repo the feature touches. The page lets you mark files viewed, collapse files, jump with the keyboard and open lines in the editor. Selected lines copy as file:line references to paste back to an AI agent, and an agent's review findings can be shown inline. Use when the user asks to see, show, render, view or review the changes, the diff, or what a branch or feature changed, as HTML or in a browser, or wants review findings shown on the diff.
---

# Diff viewer

`scripts/render_diff.py` writes one offline HTML page. For each repo it shows:

- the changes from the merge-base with the base branch up to the working tree, including uncommitted and untracked files;
- "committed only" and "uncommitted only" views when the working tree is dirty;
- one view per commit (the newest 40);
- a summary: branch, base, merge-base, ahead/behind counts and a list of commits you can click.

On the page:

- **Select lines**, then press *Copy reference* / *Copy with code* (or <kbd>c</kbd> / <kbd>C</kbd>). This copies the repo, branch, file and line numbers, plus which version those numbers belong to.
- **Copy summary** (<kbd>s</kbd>) copies the repo, branch, base, commits and every file with its status and line counts. Paste it so an agent has the whole change before you discuss specific lines.
- **Click a line number** on the new side to open that line in the editor. Each file header also has an *Open* link.
- **Go to reference** (<kbd>g</kbd>): paste a `path:line` or a reference copied from the page. The page scrolls there and highlights the lines. It also accepts `#ref=path:12-20;other/path:5` at the end of the page URL.
- **Viewed:** a checkbox per file, remembered in the browser. A file you mark viewed collapses, and is unmarked again if its diff changes in a later render. The *Viewed N / M* count tracks progress, and *Hide viewed* removes viewed files from the page.
- **Collapse and expand:** use the chevron or click the file header, press <kbd>x</kbd> for the current file and <kbd>Shift</kbd>+<kbd>X</kbd> for all, or use the *Collapse all* / *Expand all* buttons.
- **Keyboard:** <kbd>j</kbd>/<kbd>k</kbd> move between files, <kbd>n</kbd>/<kbd>p</kbd> between hunks, <kbd>f</kbd>/<kbd>F</kbd> between findings. <kbd>v</kbd> marks a file viewed, <kbd>o</kbd> opens it in the editor, <kbd>/</kbd> filters by path, and <kbd>?</kbd> lists all shortcuts.
- **Findings** from `--annotations` appear inline under the lines they refer to, with a list at the top and a count on each file header. Each finding has *Copy reply ref*, so the user can answer it by number.
- **Also:** filters by path and by status, split or unified layout, and file names pinned at the top while their file scrolls past.

## Steps

1. **Base branch.** Use `main` unless the caller names another. Give a single repo its own base with `--repo PATH=BASE`. The script compares against whichever of `main` and `origin/main` is closer to HEAD, so a stale local `main` does not leak other work into the diff. It does not fetch.
2. **Repos: render every repo the feature touches, in one page.**
   - Start with the current repo.
   - Then check each other repo in play: the session's additional working directories, repos the user named, and sibling repos of the current one.
   - For each, run `git -C <repo> branch --show-current` and `git -C <repo> log --oneline <base>..HEAD`.
   - Include the repo when its branch carries the same ticket key or branch name, or its commits or uncommitted work belong to the feature. Pass each one with its own `--repo`.
   - If a repo has the feature on a branch that is not checked out, do not switch branches. Tell the user and ask.
3. **Render.** Save into the session scratchpad when there is one, otherwise the system temp dir:
   ```bash
   python3 ~/.claude/skills/diff-viewer/scripts/render_diff.py \
     --repo /path/to/backend --repo /path/to/frontend=develop \
     --out <scratchpad>/<branch>-diff.html --open
   ```
4. **Report.** Give the page's full path; on WSL, also the Windows path the script prints. Add the one-line summary per repo that the script prints. Do not paste the diff into the reply.

## Options

| Flag | Use |
|---|---|
| `--repo PATH[=BASE]` | Repeat once per repo. Defaults to the current directory. |
| `--base BASE` | Base for repos without their own. Default `main`. |
| `--annotations FILE` | JSON findings to show inline (repeatable). Format below. |
| `--editor NAME` | URL scheme for editor links: `vscode` (default), `vscode-insiders`, `cursor`, `windsurf`, `none`. Under WSL the links open through the WSL remote. |
| `--exclude PATHSPEC` | Leave out noise such as lockfiles or generated dumps (`--exclude '*.lock'`). Only use it when the user wants focus; by default show everything. |
| `--no-uncommitted` | Committed work only. |
| `--max-commit-views N` | Per-commit views for the newest N commits (default 40, 0 for none). |
| `--context N` | Context lines around each change (default 3). |
| `--title TEXT` / `--open` | Page title; open the page in the default browser. |

## Showing review findings

After reviewing a diff, write the findings to JSON and render with `--annotations`. The user then reads them in place and answers each one by number. The file is either a list or `{"findings": [...]}`; each item has these fields:

| Field | |
|---|---|
| `path` (required) | Path relative to the repo root; an absolute path inside the repo also works. |
| `line`, `end_line` | Line range. Leave out `line` for a note on the whole file. |
| `side` | `new` (default): line numbers of the branch tip or working tree. `old`: line numbers of the base version, for removed code. |
| `severity` | `error`, `warning`, `suggestion`, `question` or `info` (default). |
| `title`, `body` | At least one of the two is required. The body is plain text; line breaks are kept. |
| `source` | Who raised it, e.g. `code-review`. |
| `repo` | Repo name or path. Needed only when several repos are rendered and the path alone is ambiguous. |

- Findings appear inline in the branch views (All, Committed, Uncommitted), not in per-commit views.
- A finding on a line outside the diff's context shows at the top of its file.
- A finding on a file outside the diff appears only in the list.
- The script prints how many findings it loaded and names any it skipped.

## When the user pastes something from the page

- **A selection reference:**
  ```
  Selected in a diff of repo `backend` (/abs/path), branch `feature-x`:
  All changes, HEAD 1a2b3c4d compared with merge-base 9f8e7d6c with main.
  - app/models/user.rb:40-52 (added: 44-52; unchanged: 40-43), line numbers in HEAD 1a2b3c4d
  - app/models/user.rb:38-39 (removed lines), line numbers in merge-base 9f8e7d6c with main
  ```
  Each range says which version its numbers belong to:
  - `working tree` or `HEAD`: read the file at the repo path.
  - A commit or merge-base: use `git -C <repo> show <sha>:<path>`.

  A *Copy with code* reference includes the lines themselves. Still check them against the files: the page is a snapshot from when it was generated.
- **A finding reply** (`Re finding #3 (...) at path:line ...`, followed by "My reply: ..."): answer about that finding. Re-render with an updated annotations file if the findings change.
- **A summary** (`Changes under review ...`): use it as the map of the change before reading files.
- If the code has moved on since the page was generated, offer to regenerate it.

When pointing the user at lines, you can give a link straight to them: append `#ref=path:12-20;other/file.rb:5` to the page's file URL.

## Notes

- Never publish the page to an external service unless the user asks. It contains the repo's source.
- The page inlines diff2html and highlight.js from `assets/`, so it works offline. Regenerating it is cheap; do that rather than editing the HTML.
- Viewed marks live in the browser's local storage for file pages, so they survive re-renders of the same repo and file.
