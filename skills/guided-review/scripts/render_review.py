#!/usr/bin/env python3
"""Render a guided, file-by-file review page for a repo's changes.

  --list     print the changed files (path, status, +/-) so explanations can be written
  (default)  render the page from the changes plus an explanations JSON file
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
TEST_PATTERN = re.compile(r'(^|/)(tests?|__tests__|spec|specs|fixtures)/|\.(test|spec)\.[^/]+$|_test\.(go|py)$|(^|/)test_[^/]+\.py$')
HUNK = re.compile(r'^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$')
LANGS = {
    'ts': 'typescript', 'tsx': 'typescript', 'mts': 'typescript', 'cts': 'typescript',
    'js': 'javascript', 'jsx': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript', 'mongodb': 'javascript',
    'json': 'json', 'md': 'markdown', 'py': 'python', 'rb': 'ruby', 'go': 'go', 'rs': 'rust',
    'java': 'java', 'kt': 'kotlin', 'cs': 'csharp', 'php': 'php', 'swift': 'swift',
    'yml': 'yaml', 'yaml': 'yaml', 'toml': 'ini', 'ini': 'ini', 'sh': 'bash', 'bash': 'bash',
    'css': 'css', 'scss': 'scss', 'less': 'less', 'html': 'xml', 'xml': 'xml', 'svg': 'xml',
    'sql': 'sql', 'graphql': 'graphql', 'dist': 'bash', 'env': 'bash',
}


def git(repo, *args, ok=(0,)):
    res = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True)
    if res.returncode not in ok:
        sys.exit(f'git {" ".join(args)} failed: {res.stderr.strip()}')
    return res.stdout


def lang_for(path):
    name = os.path.basename(path)
    if name == 'Dockerfile' or name.startswith('Dockerfile.'):
        return 'dockerfile'
    if name.startswith('.env'):
        return 'bash'
    return LANGS.get(name.rsplit('.', 1)[-1].lower() if '.' in name else '', '')


def parse_diff(text):
    hunks, cur, o, n = [], None, 0, 0
    for line in text.split('\n'):
        m = HUNK.match(line)
        if m:
            o, n = int(m.group(1)), int(m.group(2))
            cur = {'header': line, 'lines': []}
            hunks.append(cur)
        elif cur is None or line.startswith('\\'):
            continue
        elif line.startswith('+'):
            cur['lines'].append(['a', None, n, line[1:]]); n += 1
        elif line.startswith('-'):
            cur['lines'].append(['d', o, None, line[1:]]); o += 1
        elif line.startswith(' '):
            cur['lines'].append(['c', o, n, line[1:]]); o += 1; n += 1
    return hunks


def read_text(path):
    try:
        data = path.read_bytes()
    except (FileNotFoundError, IsADirectoryError):
        return None
    if b'\0' in data[:8000]:
        return None
    return data.decode('utf-8', errors='replace')


def resolve_base(repo, base):
    """Return (commit, label). HEAD means uncommitted work only."""
    if base == 'HEAD':
        head = git(repo, 'rev-parse', 'HEAD').strip()
        return head, f'HEAD {head[:7]}'
    candidates = [base] + ([f'origin/{base}'] if not base.startswith('origin/') else [])
    best = None
    for ref in candidates:
        if subprocess.run(['git', '-C', str(repo), 'rev-parse', '--verify', '-q', ref], capture_output=True).returncode:
            continue
        mb = git(repo, 'merge-base', ref, 'HEAD').strip()
        ahead = int(git(repo, 'rev-list', '--count', f'{mb}..HEAD').strip())
        if best is None or ahead < best[2]:
            best = (ref, mb, ahead)
    if not best:
        sys.exit(f'base {base!r} not found')
    return best[1], f'merge-base {best[1][:7]} with {best[0]}'


def collect(repo, base_commit, scope, includes):
    spec = ['--', scope] if scope else []
    entries = {}
    for line in git(repo, 'diff', '--name-status', '--no-renames', base_commit, *spec).splitlines():
        status, path = line.split('\t', 1)
        entries[path] = {'D': 'deleted', 'A': 'added'}.get(status[0], 'modified')
    for path in git(repo, 'ls-files', '--others', '--exclude-standard', *spec).splitlines():
        entries.setdefault(path, 'added')
    for inc in includes:
        rel = os.path.relpath(Path(inc).resolve(), repo) if os.path.isabs(inc) else inc
        target = repo / rel
        paths = [p for p in target.rglob('*') if p.is_file()] if target.is_dir() else [target]
        for p in paths:
            r = str(p.relative_to(repo))
            if r not in entries:
                tracked = subprocess.run(['git', '-C', str(repo), 'ls-files', '--error-unmatch', r], capture_output=True).returncode == 0
                entries[r] = 'modified' if tracked else 'added'
    return entries


def build_file(repo, base_commit, path, status):
    ignored = subprocess.run(['git', '-C', str(repo), 'check-ignore', '-q', path]).returncode == 0
    new_text = '' if status == 'deleted' else read_text(repo / path)
    binary = new_text is None
    if status == 'added':
        diff = git(repo, 'diff', '--no-index', '-U3', '--', '/dev/null', path, ok=(0, 1))
        old_text = ''
    else:
        diff = git(repo, 'diff', '-U3', base_commit, '--', path)
        old_text = git(repo, 'show', f'{base_commit}:{path}', ok=(0, 128))
    hunks = [] if binary else parse_diff(diff)
    adds = sum(1 for h in hunks for l in h['lines'] if l[0] == 'a')
    dels = sum(1 for h in hunks for l in h['lines'] if l[0] == 'd')
    return {
        'path': path, 'name': os.path.basename(path), 'dir': os.path.dirname(path),
        'status': status, 'ignored': ignored, 'binary': binary,
        'isTest': bool(TEST_PATTERN.search(path)), 'lang': lang_for(path),
        'hash': hashlib.sha1(diff.encode()).hexdigest()[:12],
        'adds': adds, 'dels': dels, 'hunks': hunks,
        'newText': new_text or '',
        'oldText': old_text if dels and len(old_text) < 300_000 else '',
        'newLines': len((new_text or '').splitlines()),
    }


def validate(files, exp):
    warnings = []
    by_path = {f['path']: f for f in files}
    for path in by_path:
        if path not in exp.get('files', {}):
            warnings.append(f'no explanation for {path}')
    for path, e in exp.get('files', {}).items():
        f = by_path.get(path)
        if not f:
            warnings.append(f'explanation for {path}, which is not in the change')
            continue
        for c in e.get('changes', []):
            m = re.fullmatch(r'(\d+)(?:-(\d+))?', str(c.get('lines', '')))
            if not m:
                warnings.append(f'{path}: bad line range {c.get("lines")!r} (use "12" or "12-20")')
                continue
            start, end = int(m.group(1)), int(m.group(2) or m.group(1))
            if start < 1 or end < start or end > max(f['newLines'], 1):
                warnings.append(f'{path}: line range {c["lines"]} is outside the file (1-{f["newLines"]})')
    return warnings


def open_page(out):
    win = subprocess.run(['wslpath', '-w', str(out)], capture_output=True, text=True).stdout.strip() if shutil.which('wslpath') else ''
    if win:
        print(f'Windows path: {win}')
        opener = ['wslview', win] if shutil.which('wslview') else ['explorer.exe', win]
    elif sys.platform == 'darwin':
        opener = ['open', str(out)]
    else:
        opener = ['xdg-open', str(out)]
    subprocess.Popen(opener, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', default='.')
    ap.add_argument('--base', default='HEAD', help='HEAD = uncommitted work only; a branch = merge-base with it up to the working tree')
    ap.add_argument('--scope', default='', help='only paths under this directory')
    ap.add_argument('--include', action='append', default=[], help='extra file or directory to include (e.g. git-ignored files that belong to the change)')
    ap.add_argument('--exclude', action='append', default=[], help='regex of paths to leave out')
    ap.add_argument('--explanations', help='explanations JSON')
    ap.add_argument('--out', help='output HTML path')
    ap.add_argument('--list', action='store_true', help='print the changed files and exit')
    ap.add_argument('--open', action='store_true')
    args = ap.parse_args()

    repo = Path(git(Path(args.repo), 'rev-parse', '--show-toplevel').strip())
    scope = os.path.relpath(Path(args.scope).resolve(), repo) if args.scope and os.path.isabs(args.scope) else args.scope.rstrip('/')
    base_commit, base_label = resolve_base(repo, args.base)
    entries = collect(repo, base_commit, scope, args.include)
    entries = {p: s for p, s in entries.items() if not any(re.search(x, p) for x in args.exclude)}

    exp = json.loads(Path(args.explanations).read_text()) if args.explanations else {}
    exp_files = exp.get('files', {})
    order = [p for p in exp_files if p in entries] + sorted(p for p in entries if p not in exp_files)
    files = [build_file(repo, base_commit, p, entries[p]) for p in order]

    if args.list:
        print(f'repo {repo} · branch {git(repo, "branch", "--show-current").strip() or "(detached)"} · base {base_label}')
        for f in files:
            flags = ' '.join(x for x in [f['status'], 'test' if f['isTest'] else '', 'IGNORED-BY-GIT' if f['ignored'] else '', 'binary' if f['binary'] else ''] if x)
            print(f'{f["path"]}\t+{f["adds"]} -{f["dels"]}\t{f["newLines"]} lines\t{flags}')
        return

    if not args.out:
        sys.exit('--out is required when rendering')
    for f in files:
        e = exp_files.get(f['path'], {})
        f['group'] = e.get('group', 'Other')
        f['exp'] = {k: e.get(k, d) for k, d in [('summary', 'No explanation written for this file.'), ('purpose', ''), ('changes', []), ('notes', [])]}
        if 'isTest' in e:
            f['isTest'] = bool(e['isTest'])
    warnings = validate(files, exp)
    for f in files:
        f.pop('newLines')

    head = git(repo, 'rev-parse', 'HEAD').strip()
    branch = git(repo, 'branch', '--show-current').strip() or '(detached)'
    ov = exp.get('overview', {})
    data = {
        'key': hashlib.sha1(f'{repo}|{branch}|{base_commit}|{scope}'.encode()).hexdigest()[:12],
        'repo': repo.name, 'repoPath': str(repo), 'scope': scope,
        'branch': branch, 'headShort': head[:7],
        'baseShort': base_commit[:7], 'baseLabel': base_label,
        'uncommittedOnly': args.base == 'HEAD',
        'generatedAt': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),
        'overview': {'title': ov.get('title', f'Review of {branch}'), 'body': ov.get('body', []), 'order_hint': ov.get('order_hint', '')},
        'files': files,
    }
    blob = json.dumps(data).replace('</', '<\\/')
    html = (SKILL / 'assets' / 'template.html').read_text().replace('__DATA__', blob)
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html)

    print(f'Wrote {out} ({len(files)} files, {out.stat().st_size // 1024} KB) · base {base_label}')
    for f in files:
        if f['ignored']:
            print(f'NOTE: {f["path"]} is ignored by git and will not be committed as things stand')
    for w in warnings:
        print(f'WARNING: {w}')
    if args.open:
        open_page(out)


main()
