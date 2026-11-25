#!/usr/bin/env python3
"""Render one or more git repos' branch changes as a single self-contained HTML diff viewer.

Usage:
  render_diff.py [--repo PATH[=BASE]]... [--base BASE] [--out FILE] [--title TEXT]
                 [--exclude PATHSPEC]... [--no-uncommitted] [--max-commit-views N]
                 [--context N] [--annotations FILE]... [--editor NAME] [--open]

Each repo is compared from its merge-base with BASE (default: main) to HEAD, plus any
uncommitted and untracked work. Pass --repo once per repo when a feature spans several.
Needs only git and the Python standard library; the page works offline.
"""
import argparse
import datetime
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
ASSETS = SKILL_DIR / 'assets'
MAX_UNTRACKED_BYTES = 1_000_000
SEVERITIES = ('error', 'warning', 'suggestion', 'question', 'info')


class GitError(Exception):
    pass


def git(repo, *args, ok_codes=(0,)):
    proc = subprocess.run(['git', '-c', 'core.quotepath=off', '-C', str(repo), *args],
                          capture_output=True, text=True, errors='replace')
    if proc.returncode not in ok_codes:
        raise GitError(f"git {' '.join(args)} failed in {repo}: {proc.stderr.strip()}")
    return proc.stdout


def rev_exists(repo, rev):
    return subprocess.run(['git', '-C', str(repo), 'rev-parse', '--verify', '--quiet', f'{rev}^{{commit}}'],
                          capture_output=True).returncode == 0


def is_ancestor(repo, a, b):
    return subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', a, b],
                          capture_output=True).returncode == 0


def resolve_base(repo, base):
    """The ref to compare against. For a bare branch name, the local branch and origin/<name>
    are both considered and the one closer to HEAD wins, so a stale local main does not
    drag other people's merged work into the diff."""
    candidates = [base] if rev_exists(repo, base) else []
    if '/' not in base and rev_exists(repo, f'origin/{base}'):
        candidates.append(f'origin/{base}')
    if not candidates:
        raise GitError(f"base '{base}' not found in {repo} (nor origin/{base}); pass --repo {repo}=<base>")
    best, best_mb = None, None
    for cand in candidates:
        mb = git(repo, 'merge-base', cand, 'HEAD').strip()
        if best is None or (mb != best_mb and is_ancestor(repo, best_mb, mb)):
            best, best_mb = cand, mb
    return best, best_mb


def split_files(diff_text):
    """Split a unified diff into per-file chunks with the paths and status the viewer filters on."""
    chunks = re.split(r'(?m)^(?=diff --git )', diff_text)
    files = []
    for chunk in chunks:
        if not chunk.startswith('diff --git '):
            continue
        header = chunk.split('\n@@', 1)[0]
        old = new = None
        for line in header.splitlines():
            if line.startswith('--- '):
                old = None if line[4:] == '/dev/null' else re.sub(r'^a/', '', line[4:])
            elif line.startswith('+++ '):
                new = None if line[4:] == '/dev/null' else re.sub(r'^b/', '', line[4:])
            elif line.startswith('rename from '):
                old = line[len('rename from '):]
            elif line.startswith('rename to '):
                new = line[len('rename to '):]
        if old is None and new is None:  # mode-only or binary change: take the paths from the git line
            m = re.match(r'diff --git a/(.+?) b/(.+)$', chunk.splitlines()[0])
            if m:
                old, new = m.group(1), m.group(2)
        if 'new file mode' in header or (old is None and new):
            status = 'added'
        elif 'deleted file mode' in header or (new is None and old):
            status = 'deleted'
        elif 'rename from ' in header:
            status = 'renamed'
        else:
            status = 'modified'
        adds = dels = 0
        for line in chunk.split('\n@@', 1)[1].splitlines() if '\n@@' in chunk else []:
            if line.startswith('+') and not line.startswith('+++'):
                adds += 1
            elif line.startswith('-') and not line.startswith('---'):
                dels += 1
        text = chunk if chunk.endswith('\n') else chunk + '\n'
        files.append({'old': old, 'new': new, 'path': new or old, 'status': status, 'adds': adds, 'dels': dels,
                      'key': hashlib.sha1(text.encode('utf-8', 'replace')).hexdigest()[:12], 'diff': text})
    return files


def untracked_diff(repo, pathspec, context):
    out = []
    for path in git(repo, 'ls-files', '--others', '--exclude-standard', '-z', '--', *pathspec).split('\0'):
        if not path:
            continue
        full = Path(repo) / path
        if full.is_file() and full.stat().st_size > MAX_UNTRACKED_BYTES:
            out.append(f'diff --git a/{path} b/{path}\nnew file mode 100644\nBinary files /dev/null and b/{path} differ\n')
            continue
        out.append(git(repo, 'diff', f'-U{context}', '--no-index', '--', '/dev/null', path, ok_codes=(0, 1)))
    return ''.join(out)


def collect_repo(spec, default_base, excludes, include_uncommitted, max_commit_views, context):
    path, _, base = spec.partition('=')
    repo = Path(path or '.').expanduser().resolve()
    root = Path(git(repo, 'rev-parse', '--show-toplevel').strip())
    base_ref, mb = resolve_base(root, base or default_base)
    head = git(root, 'rev-parse', 'HEAD').strip()
    branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').strip()
    pathspec = ['.'] + [f':(exclude){p}' for p in excludes]
    diff_args = [f'-U{context}', '-M', '--no-color']

    committed = git(root, 'diff', *diff_args, mb, 'HEAD', '--', *pathspec)
    uncommitted = ''
    if include_uncommitted:
        uncommitted = git(root, 'diff', *diff_args, 'HEAD', '--', *pathspec) + untracked_diff(root, pathspec, context)
    everything = committed
    if uncommitted:
        everything = git(root, 'diff', *diff_args, mb, '--', *pathspec) + untracked_diff(root, pathspec, context)

    short = lambda sha: sha[:8]
    views = [{'id': 'all', 'label': 'All changes' + (' (committed + uncommitted)' if uncommitted else ''),
              'oldRef': f'merge-base {short(mb)} with {base_ref}',
              'newRef': 'working tree' if uncommitted else f'HEAD {short(head)}',
              'files': split_files(everything)}]
    if uncommitted:
        views.append({'id': 'committed', 'label': 'Committed only', 'oldRef': f'merge-base {short(mb)}',
                      'newRef': f'HEAD {short(head)}', 'files': split_files(committed)})
        views.append({'id': 'uncommitted', 'label': 'Uncommitted only (incl. untracked)',
                      'oldRef': f'HEAD {short(head)}', 'newRef': 'working tree', 'files': split_files(uncommitted)})

    log = git(root, 'log', '--reverse', '--format=%H%x1f%P%x1f%an%x1f%aI%x1f%s', f'{mb}..HEAD')
    commits = []
    for line in log.splitlines():
        sha, parents, author, date, subject = line.split('\x1f', 4)
        parents = parents.split()
        commits.append({'sha': sha, 'short': short(sha), 'author': author, 'date': date[:16].replace('T', ' '),
                        'subject': subject, 'merge': len(parents) > 1})
    for c in commits[-max_commit_views:] if max_commit_views else []:
        parent = f"{c['sha']}^1"
        if rev_exists(root, parent):
            text = git(root, 'diff', *diff_args, parent, c['sha'], '--', *pathspec)
        else:
            text = git(root, 'show', *diff_args, '--format=', c['sha'], '--', *pathspec)
        c['view'] = f"commit-{c['short']}"
        views.append({'id': c['view'], 'label': f"{c['short']} {c['subject']}" + (' (merge, vs first parent)' if c['merge'] else ''),
                      'oldRef': f"{c['short']}^1", 'newRef': f"commit {c['short']}", 'files': split_files(text)})

    ahead_behind = git(root, 'rev-list', '--left-right', '--count', f'{base_ref}...HEAD').split()
    return {'name': root.name, 'path': str(root), 'branch': branch, 'head': short(head), 'base': base_ref,
            'mergeBase': short(mb), 'behind': int(ahead_behind[0]), 'ahead': int(ahead_behind[1]),
            'dirty': bool(uncommitted), 'commits': commits, 'views': views,
            'commitViewsOmitted': max(0, len(commits) - max_commit_views) if max_commit_views else len(commits),
            'annotations': []}


def editor_link(editor):
    """How the page builds 'open in editor' links: <scheme>://file/<abs>:<line>, or through
    the WSL remote when this runs inside WSL, so the Windows-side editor opens the Linux file."""
    if editor == 'none':
        return None
    distro = os.environ.get('WSL_DISTRO_NAME')
    if not distro and Path('/proc/version').exists() and 'microsoft' in Path('/proc/version').read_text().lower():
        win = subprocess.run(['wslpath', '-w', '/'], capture_output=True, text=True).stdout.strip()
        m = re.match(r'\\\\wsl(?:\.localhost|\$)\\([^\\]+)', win)
        distro = m.group(1) if m else None
    return {'scheme': editor, 'remote': f'wsl+{distro}' if distro else None}


def load_annotations(paths, repos):
    """Findings an agent wants shown inline: JSON list (or {"findings": [...]}) of
    {path, line, end_line?, side?, severity?, title?, body?, source?, repo?}."""
    placed = 0
    for source_file in paths:
        try:
            raw = json.loads(Path(source_file).expanduser().read_text())
        except (OSError, ValueError) as err:
            sys.exit(f'error: cannot read annotations {source_file}: {err}')
        items = raw.get('findings', raw.get('annotations', [])) if isinstance(raw, dict) else raw
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict) or not item.get('path') or not (item.get('title') or item.get('body')):
                print(f'  skipped annotation without path/title/body: {item!r:.120}')
                continue
            path = re.sub(r'^\./', '', str(item['path']))
            target = None
            wanted = item.get('repo')
            for index, repo in enumerate(repos):
                if wanted and wanted not in (repo['name'], repo['path']):
                    continue
                if path.startswith(repo['path'] + '/'):
                    path = path[len(repo['path']) + 1:]
                in_diff = any(f['path'] == path for v in repo['views'] for f in v['files'])
                if wanted or in_diff or len(repos) == 1:
                    target = index
                    if in_diff:
                        break
            if target is None:
                print(f'  skipped annotation for {path}: no repo given and the file is in no diff')
                continue
            try:
                line = int(item.get('line') or 0) or None
                end_line = int(item.get('end_line') or 0) or line
            except (TypeError, ValueError):
                line = end_line = None
            severity = str(item.get('severity', 'info')).lower()
            placed += 1
            repos[target]['annotations'].append({
                'id': placed, 'path': path, 'line': line, 'endLine': max(end_line or 0, line or 0) or None,
                'side': 'old' if item.get('side') == 'old' else 'new',
                'severity': severity if severity in SEVERITIES else 'info',
                'title': str(item.get('title') or ''), 'body': str(item.get('body') or ''),
                'source': str(item.get('source') or ''),
            })
    return placed


def build_page(repos, title, excludes, editor):
    template = (ASSETS / 'template.html').read_text()
    data = json.dumps({'title': title, 'generated': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),
                       'excludes': excludes, 'editor': editor, 'repos': repos}).replace('</', '<\\/')
    hljs_light = (ASSETS / 'hljs-github.min.css').read_text()
    hljs_dark = (ASSETS / 'hljs-github-dark.min.css').read_text()
    replacements = {
        'TITLE': html.escape(title),
        'DIFF2HTML_CSS': (ASSETS / 'diff2html.min.css').read_text(),
        'HLJS_CSS': f'@media (prefers-color-scheme: light) {{ {hljs_light} }}\n'
                    f'@media (prefers-color-scheme: dark) {{ {hljs_dark} }}',
        'VIEWER_CSS': (ASSETS / 'viewer.css').read_text(),
        'DIFF2HTML_JS': (ASSETS / 'diff2html-ui.min.js').read_text(),
        'VIEWER_JS': (ASSETS / 'viewer.js').read_text(),
        'DATA': data,
    }
    # One pass over the template only: inserted content (the bundle, the diffs) is never
    # scanned for placeholders, so text inside it that looks like one is left alone.
    template = re.sub(r'\{\{DV:([A-Z0-9_]+)\}\}', lambda m: replacements[m.group(1)], template)
    return template


def open_in_browser(out):
    is_wsl = 'microsoft' in Path('/proc/version').read_text().lower() if Path('/proc/version').exists() else False
    try:
        if is_wsl:
            win = subprocess.run(['wslpath', '-w', str(out)], capture_output=True, text=True).stdout.strip()
            print(f'Windows path: {win}')
            opener = ['wslview', win] if shutil.which('wslview') else ['explorer.exe', win]
        elif sys.platform == 'darwin':
            opener = ['open', str(out)]
        else:
            opener = ['xdg-open', str(out)]
        subprocess.Popen(opener, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as err:
        print(f'Could not open a browser ({err}); open the file by hand.')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--repo', action='append', default=[], help='repo path, optionally =BASE (repeatable)')
    ap.add_argument('--base', default='main', help='base branch for repos without their own (default: main)')
    ap.add_argument('--out', help='output HTML path')
    ap.add_argument('--title')
    ap.add_argument('--exclude', action='append', default=[], help='pathspec to leave out, e.g. "*.lock"')
    ap.add_argument('--no-uncommitted', action='store_true', help='ignore working-tree and untracked changes')
    ap.add_argument('--max-commit-views', type=int, default=40, help='newest N commits get their own view')
    ap.add_argument('--context', type=int, default=3, help='context lines around each change')
    ap.add_argument('--annotations', action='append', default=[],
                    help='JSON file of findings to show inline (repeatable); see SKILL.md for the format')
    ap.add_argument('--editor', default='vscode',
                    help='URL scheme for line-number links: vscode, vscode-insiders, cursor, windsurf, or none')
    ap.add_argument('--open', action='store_true', help='open the page in the default browser')
    args = ap.parse_args()

    repos = []
    for spec in args.repo or ['.']:
        try:
            repos.append(collect_repo(spec, args.base, args.exclude, not args.no_uncommitted,
                                      args.max_commit_views, args.context))
        except GitError as err:
            sys.exit(f'error: {err}')

    branches = sorted({r['branch'] for r in repos})
    title = args.title or (f"{', '.join(branches)} vs {repos[0]['base']}" if len(repos) == 1
                           else f"{' / '.join(branches)} across {len(repos)} repos")
    slug = re.sub(r'[^A-Za-z0-9._-]+', '-', '-'.join(branches))[:80] or 'diff'
    out = Path(args.out or Path(tempfile.gettempdir()) / 'diff-viewer' / f'{slug}.html').expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    placed = load_annotations(args.annotations, repos)
    out.write_text(build_page(repos, title, args.exclude, editor_link(args.editor)))

    print(f'Wrote {out} ({out.stat().st_size // 1024} KB)')
    for r in repos:
        files = r['views'][0]['files']
        print(f"  {r['name']}: {r['branch']} vs {r['base']} (merge-base {r['mergeBase']}), "
              f"{len(r['commits'])} commits, {len(files)} files, "
              f"+{sum(f['adds'] for f in files)} -{sum(f['dels'] for f in files)}"
              f"{', uncommitted changes included' if r['dirty'] else ''}"
              f"{', behind base by %d' % r['behind'] if r['behind'] else ''}")
    if args.annotations:
        print(f'  {placed} annotations loaded')
    if args.open:
        open_in_browser(out)


if __name__ == '__main__':
    main()
