(() => {
  'use strict';

  const DATA = JSON.parse(document.getElementById('data').textContent);
  const STATUSES = ['added', 'modified', 'renamed', 'deleted'];
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const store = {
    get(key) { try { return localStorage.getItem(`diff-viewer:${key}`); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(`diff-viewer:${key}`, value); } catch { /* storage unavailable */ } },
    del(key) { try { localStorage.removeItem(`diff-viewer:${key}`); } catch { /* storage unavailable */ } },
  };

  const state = {
    repo: DATA.repos.length > 1 ? '*' : '0',
    view: 'all',
    format: store.get('format') || 'side-by-side',
    filter: '',
    statuses: new Set(STATUSES),
    hideViewed: store.get('hide-viewed') === '1',
  };

  // What is on screen: one entry per repo section, so a selection, a click or a finding
  // can be traced back to its repo, view and file.
  let rendered = [];
  const fileInfo = new WeakMap(); // wrapper -> { entry, file }
  // Collapsed state chosen by hand this session; unset means "collapsed if viewed".
  const collapsedByHand = new Map();

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) if (child !== null && child !== undefined) node.append(child);
    return node;
  }

  const barHeight = () => $('#bar').offsetHeight;
  const docTop = (node) => node.getBoundingClientRect().top + window.scrollY;
  const isVisible = (node) => node.offsetParent !== null;

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = el('textarea', { readonly: 'readonly' });
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    }
  }

  let toastTimer;
  function toast(message) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.add('toast--show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('toast--show'), 2400);
  }

  function ranges(numbers) {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    const out = [];
    for (const n of sorted) {
      const last = out[out.length - 1];
      if (last && n === last[1] + 1) last[1] = n; else out.push([n, n]);
    }
    return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
  }

  // ---------- editor links ----------

  function editorUrl(repo, path, line) {
    if (!DATA.editor) return null;
    const abs = encodeURI(`${repo.path}/${path}`);
    const { scheme, remote } = DATA.editor;
    return remote ? `${scheme}://vscode-remote/${remote}${abs}:${line || 1}` : `${scheme}://file${abs}:${line || 1}`;
  }

  function openUrl(url) {
    if (!url) return;
    const a = el('a', { href: url });
    document.body.append(a);
    a.click();
    a.remove();
  }

  // ---------- controls ----------

  function scopeRepos() {
    return state.repo === '*' ? DATA.repos.map((_, i) => i) : [Number(state.repo)];
  }

  function viewFor(repo) {
    return repo.views.find((v) => v.id === state.view) || null;
  }

  function fillRepoSelect() {
    const select = $('#repo');
    select.innerHTML = '';
    if (DATA.repos.length > 1) select.append(el('option', { value: '*', text: `All repos (${DATA.repos.length})` }));
    DATA.repos.forEach((repo, i) => select.append(el('option', { value: String(i), text: `${repo.name} · ${repo.branch}` })));
    select.value = state.repo;
    select.closest('.field').hidden = DATA.repos.length === 1;
  }

  function fillViewSelect() {
    const select = $('#view');
    select.innerHTML = '';
    const repos = scopeRepos().map((i) => DATA.repos[i]);
    const seen = new Set();
    const options = [];
    for (const repo of repos) {
      for (const view of repo.views) {
        if (repos.length > 1 && view.id.startsWith('commit-')) continue; // commits differ per repo
        if (seen.has(view.id)) continue;
        seen.add(view.id);
        options.push(view);
      }
    }
    options.filter((v) => !v.id.startsWith('commit-')).forEach((v) => select.append(el('option', { value: v.id, text: v.label })));
    const commits = options.filter((v) => v.id.startsWith('commit-'));
    if (commits.length) {
      const group = el('optgroup', { label: 'Single commit (oldest first)' });
      commits.forEach((v) => group.append(el('option', { value: v.id, text: v.label })));
      select.append(group);
    }
    if (!seen.has(state.view)) state.view = 'all';
    select.value = state.view;
  }

  function fillChips() {
    const holder = $('#status-chips');
    holder.innerHTML = '';
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const i of scopeRepos()) {
      const view = viewFor(DATA.repos[i]);
      if (view) view.files.forEach((f) => { counts[f.status] += 1; });
    }
    for (const status of STATUSES) {
      if (!counts[status]) continue;
      const button = el('button', {
        type: 'button', 'data-status': status, 'aria-pressed': String(state.statuses.has(status)),
        text: `${status} ${counts[status]}`,
      });
      button.addEventListener('click', () => {
        if (state.statuses.has(status)) state.statuses.delete(status); else state.statuses.add(status);
        button.setAttribute('aria-pressed', String(state.statuses.has(status)));
        render();
      });
      holder.append(button);
    }
  }

  function syncToggles() {
    $$('.seg button[data-format]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.format === state.format)));
    $('#hide-viewed').setAttribute('aria-pressed', String(state.hideViewed));
    document.body.classList.toggle('dv-hide-viewed', state.hideViewed);
    document.body.classList.toggle('dv-editor', Boolean(DATA.editor));
  }

  function refreshControls() {
    fillRepoSelect();
    fillViewSelect();
    fillChips();
    syncToggles();
  }

  function showView(repoIndex, viewId) {
    state.repo = repoIndex === '*' ? '*' : String(repoIndex);
    state.view = viewId;
    refreshControls();
    render();
  }

  function clearFilters() {
    state.filter = '';
    $('#path-filter').value = '';
    state.statuses = new Set(STATUSES);
  }

  // ---------- summary ----------

  function summary() {
    const body = $('#summary-body');
    body.innerHTML = '';
    DATA.repos.forEach((repo, i) => {
      const all = repo.views[0].files;
      const adds = all.reduce((n, f) => n + f.adds, 0);
      const dels = all.reduce((n, f) => n + f.dels, 0);
      const dl = el('dl');
      const row = (term, value) => dl.append(el('dt', { text: term }), el('dd', {}, value));
      row('Path', el('code', { text: repo.path }));
      row('Branch', el('code', { text: `${repo.branch} @ ${repo.head}` }));
      row('Base', el('code', { text: `${repo.base} (merge-base ${repo.mergeBase})` }));
      row('Commits', document.createTextNode(`${repo.ahead} ahead` + (repo.behind ? `, base has moved on by ${repo.behind}` : '')));
      row('Files', document.createTextNode(`${all.length} changed, +${adds} −${dels}` + (repo.dirty ? ' (includes uncommitted work)' : '')));

      const table = el('table', { class: 'commits' });
      repo.commits.forEach((c) => {
        const tr = el('tr', { 'data-view': c.view || null, title: c.view ? 'Show this commit' : null },
          el('td', { class: 'sha', text: c.short }),
          el('td', { text: c.subject + (c.merge ? ' (merge)' : '') }),
          el('td', { class: 'when', text: `${c.author}, ${c.date}` }));
        if (c.view) tr.addEventListener('click', () => { showView(i, c.view); $('#diff').scrollIntoView(); });
        table.append(tr);
      });
      const card = el('section', { class: 'repo-card' }, el('h2', { text: repo.name }), dl);
      if (repo.commits.length) card.append(table);
      if (repo.commitViewsOmitted) card.append(el('p', { class: 'note', text: `${repo.commitViewsOmitted} older commits have no single-commit view.` }));
      body.append(card);
    });
    if (DATA.excludes.length) body.append(el('p', { class: 'note', text: `Left out: ${DATA.excludes.join(', ')}` }));
  }

  function summaryText() {
    const out = [`Changes under review (diff generated ${DATA.generated}):`];
    for (const i of scopeRepos()) {
      const repo = DATA.repos[i];
      const files = repo.views[0].files;
      const adds = files.reduce((n, f) => n + f.adds, 0);
      const dels = files.reduce((n, f) => n + f.dels, 0);
      out.push('', `Repo \`${repo.name}\` (${repo.path}): branch \`${repo.branch}\` at ${repo.head}, `
        + `compared with ${repo.base} (merge-base ${repo.mergeBase}); ${repo.ahead} commits ahead`
        + (repo.behind ? `, base ${repo.behind} commits further on` : '')
        + (repo.dirty ? '; includes uncommitted and untracked work' : '') + '.');
      if (repo.commits.length) {
        out.push('Commits (oldest first):');
        repo.commits.forEach((c) => out.push(`- ${c.short} ${c.subject}${c.merge ? ' (merge)' : ''}`));
      }
      out.push(`Files (${files.length}, +${adds} -${dels}):`);
      files.forEach((f) => {
        const name = f.status === 'renamed' ? `${f.old} -> ${f.path}` : f.path;
        out.push(`- ${f.status} ${name} (+${f.adds} -${f.dels})`);
      });
      if (repo.annotations.length) out.push(`Findings shown in the page: ${repo.annotations.length}.`);
    }
    return out.join('\n');
  }

  // ---------- findings (agent annotations) ----------

  function annotationRef(repo, ann) {
    const lines = ann.line ? `:${ann.endLine && ann.endLine !== ann.line ? `${ann.line}-${ann.endLine}` : ann.line}` : '';
    return `${ann.path}${lines}`;
  }

  function replyText(repo, ann) {
    return [
      `Re finding #${ann.id} (${ann.severity}${ann.source ? `, from ${ann.source}` : ''}) at ${annotationRef(repo, ann)}`
        + `${ann.side === 'old' ? ' (base version)' : ''} in repo \`${repo.name}\` (${repo.path}), branch \`${repo.branch}\`:`,
      `"${ann.title || ann.body.split('\n')[0]}"`,
      'My reply: ',
    ].join('\n');
  }

  function buildFindings() {
    const all = DATA.repos.flatMap((repo, i) => repo.annotations.map((ann) => ({ repo, i, ann })));
    const panel = $('#findings');
    panel.hidden = all.length === 0;
    if (!all.length) return;
    const bySeverity = all.reduce((acc, { ann }) => ({ ...acc, [ann.severity]: (acc[ann.severity] || 0) + 1 }), {});
    $('#findings-title').textContent = `Findings (${all.length}: ${Object.entries(bySeverity).map(([s, n]) => `${n} ${s}`).join(', ')})`;
    const list = $('#findings-list');
    list.innerHTML = '';
    for (const { repo, i, ann } of all) {
      const button = el('button', { type: 'button', text: ann.title || ann.body.split('\n')[0].slice(0, 120) });
      button.addEventListener('click', () => gotoAnnotation(i, ann));
      list.append(el('li', { class: `sev-${ann.severity}`, value: String(ann.id) },
        el('strong', { class: 'dv-note__sev', text: `${ann.severity} ` }), button, ' ',
        el('span', { class: 'loc', text: `${DATA.repos.length > 1 ? `${repo.name}/` : ''}${annotationRef(repo, ann)}` })));
    }
  }

  function noteCard(repo, ann) {
    const copyButton = el('button', { type: 'button', text: 'Copy reply ref', title: 'Copy a reference to this finding to answer it' });
    copyButton.addEventListener('click', async () => {
      toast(await copy(replyText(repo, ann)) ? `Reference to finding #${ann.id} copied.` : 'Could not reach the clipboard.');
    });
    return el('div', { class: `dv-note sev-${ann.severity}`, id: `dv-note-${ann.id}` },
      el('div', { class: 'dv-note__head' },
        el('span', { class: 'dv-note__sev', text: `#${ann.id} ${ann.severity}` }),
        ann.title ? el('span', { class: 'dv-note__title', text: ann.title }) : null,
        el('span', { class: 'dv-note__meta', text: [ann.source, annotationRef(repo, ann)].filter(Boolean).join(' · ') }),
        el('span', { class: 'dv-note__actions' }, copyButton)),
      ann.body ? el('p', { class: 'dv-note__body', text: ann.body }) : null);
  }

  function placeAnnotations(entry) {
    const { repo, view } = entry;
    if (!repo.annotations.length || view.id.startsWith('commit-')) return; // numbers refer to the branch tip
    const pairs = [];
    for (const ann of repo.annotations) {
      const wrapper = entry.wrappers.find((w) => fileInfo.get(w).file.path === ann.path);
      if (!wrapper) continue;
      const nums = [];
      for (let n = ann.line || 0; ann.line && n <= (ann.endLine || ann.line); n += 1) nums.push(n);
      const hits = nums.length ? rowsFor(wrapper, ann.side, nums) : [];
      const badge = $('.dv-finding-count', wrapper);
      badge.hidden = false;
      badge.textContent = String(Number(badge.textContent || 0) + 1);
      if (!hits.length) {
        let holder = $('.dv-file-notes', wrapper);
        if (!holder) {
          holder = el('div', { class: 'dv-file-notes' });
          $('.d2h-file-header', wrapper).after(holder);
        }
        holder.append(noteCard(repo, ann));
        continue;
      }
      hits.forEach(({ row, twin }) => [row, twin].forEach((r) => r && r.classList.add('dv-annotated', `sev-${ann.severity}`)));
      const anchor = hits[hits.length - 1];
      const noteRow = el('tr', { class: 'dv-note-row' }, el('td', { colspan: '2' }, noteCard(repo, ann)));
      anchor.row.after(noteRow);
      if (anchor.twin) {
        const spacer = el('tr', { class: 'dv-note-row dv-note-spacer' }, el('td', { colspan: '2' }));
        anchor.twin.after(spacer);
        pairs.push([noteRow, spacer]);
      }
    }
    entry.notePairs = pairs;
  }

  // Split view keeps one table per side, so each finding gets a blank twin row on the
  // other side, kept the same height so the two sides stay level.
  function syncNoteLayout() {
    for (const entry of rendered) {
      entry.wrappers.forEach((w) => $$('.d2h-file-side-diff, .d2h-file-diff', w).forEach((pane) => {
        pane.style.setProperty('--pane-w', `${pane.clientWidth - 2}px`);
      }));
      (entry.notePairs || []).forEach(([noteRow, spacer]) => { spacer.style.height = `${noteRow.offsetHeight}px`; });
    }
  }

  function gotoAnnotation(repoIndex, ann) {
    let node = document.getElementById(`dv-note-${ann.id}`);
    if (!node) {
      clearFilters();
      showView(DATA.repos.length > 1 ? '*' : repoIndex, 'all');
      node = document.getElementById(`dv-note-${ann.id}`);
    }
    if (!node) { toast(`Finding #${ann.id} is on a file that is not in this diff.`); return; }
    revealWrapper(node.closest('.d2h-file-wrapper'));
    scrollToNode(node, 60);
    node.animate([{ outline: '3px solid var(--sev)' }, { outline: '3px solid transparent' }], { duration: 1400 });
  }

  // ---------- file state: collapse, viewed, current ----------

  const fileKey = (w) => { const { entry, file } = fileInfo.get(w); return `${entry.repo.path}|${file.path}`; };
  const viewedKey = (w) => { const { file } = fileInfo.get(w); return `viewed|${fileKey(w)}|${file.key}`; };
  const isViewed = (w) => store.get(viewedKey(w)) === '1';
  const isCollapsed = (w) => w.classList.contains('dv-collapsed');

  function applyFileState(w) {
    const viewed = isViewed(w);
    const key = fileKey(w);
    const collapsed = collapsedByHand.has(key) ? collapsedByHand.get(key) : viewed;
    w.classList.toggle('dv-is-viewed', viewed);
    w.classList.toggle('dv-collapsed', collapsed);
    $('.dv-viewed input', w).checked = viewed;
    $('.dv-chevron', w).setAttribute('aria-expanded', String(!collapsed));
  }

  function setCollapsed(w, collapsed) {
    collapsedByHand.set(fileKey(w), collapsed);
    applyFileState(w);
    if (!collapsed) requestAnimationFrame(syncNoteLayout);
  }

  function setViewed(w, viewed) {
    if (viewed) store.set(viewedKey(w), '1'); else store.del(viewedKey(w));
    collapsedByHand.delete(fileKey(w));
    applyFileState(w);
    updateProgress();
  }

  function allWrappers() {
    return rendered.flatMap((entry) => entry.wrappers);
  }

  function setAllCollapsed(collapsed) {
    allWrappers().forEach((w) => { collapsedByHand.set(fileKey(w), collapsed); applyFileState(w); });
    if (!collapsed) requestAnimationFrame(syncNoteLayout);
  }

  function updateProgress() {
    const wrappers = allWrappers();
    const viewed = wrappers.filter(isViewed).length;
    $('#progress').textContent = wrappers.length ? `Viewed ${viewed} / ${wrappers.length}` : '';
  }

  function revealWrapper(w) {
    if (!w) return;
    if (state.hideViewed && isViewed(w)) {
      state.hideViewed = false;
      store.set('hide-viewed', '0');
      syncToggles();
    }
    if (isCollapsed(w)) setCollapsed(w, false);
  }

  function decorateFile(entry, wrapper, file) {
    fileInfo.set(wrapper, { entry, file });
    const header = $('.d2h-file-header', wrapper);
    const chevron = el('button', { type: 'button', class: 'dv-chevron', 'aria-label': 'Collapse or expand this file', title: 'Collapse or expand (x)', text: '▾' });
    chevron.addEventListener('click', () => setCollapsed(wrapper, !isCollapsed(wrapper)));
    header.prepend(chevron);
    if (DATA.repos.length > 1 && state.repo === '*') {
      $('.d2h-file-name-wrapper', wrapper)?.prepend(el('span', { class: 'repo-badge', text: entry.repo.name }));
    }

    const actions = el('span', { class: 'dv-file-actions' });
    actions.append(el('span', { class: 'dv-finding-count', hidden: 'hidden', title: 'Findings on this file' }));
    if (DATA.editor && file.status !== 'deleted') {
      const link = el('a', { href: editorUrl(entry.repo, file.path, firstChangedLine(wrapper)), title: 'Open in editor (o)', text: 'Open' });
      actions.append(link);
    }
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.addEventListener('change', () => setViewed(wrapper, checkbox.checked));
    actions.append(el('label', { class: 'dv-viewed', title: 'Mark viewed (v)' }, checkbox, 'Viewed'));
    header.append(actions);

    // Clicking the bare header (not a control, not while selecting text) folds the file.
    header.addEventListener('click', (e) => {
      if (e.target.closest('button, a, label, input') || !window.getSelection().isCollapsed) return;
      setCollapsed(wrapper, !isCollapsed(wrapper));
    });
    applyFileState(wrapper);
  }

  function firstChangedLine(wrapper) {
    const sides = $$('.d2h-file-side-diff', wrapper);
    if (sides.length === 2) {
      const cell = $$('.d2h-code-side-linenumber.d2h-ins', sides[1])[0] || $$('.d2h-code-side-linenumber.d2h-cntx', sides[1])[0];
      return cell ? lineNumber(cell) : 1;
    }
    const cell = $$('.d2h-code-linenumber.d2h-ins, .d2h-code-linenumber.d2h-cntx', wrapper)[0];
    return (cell && lineNumber($('.line-num2', cell))) || 1;
  }

  let currentWrapper = null;
  function findCurrent() {
    const line = barHeight() + 8;
    return allWrappers().filter(isVisible).find((w) => w.getBoundingClientRect().bottom > line + 30) || null;
  }

  function updateCurrent() {
    const next = findCurrent();
    if (next === currentWrapper) return;
    currentWrapper?.classList.remove('dv-current');
    currentWrapper = next;
    currentWrapper?.classList.add('dv-current');
  }

  // ---------- diff ----------

  function render() {
    hideToolbar();
    const main = $('#diff');
    main.innerHTML = '';
    rendered = [];
    currentWrapper = null;
    const query = state.filter.trim().toLowerCase();
    const repos = scopeRepos();

    for (const i of repos) {
      const repo = DATA.repos[i];
      const view = viewFor(repo);
      const section = el('section', { class: 'repo-section' });
      if (repos.length > 1) section.append(el('h2', { class: 'repo-section__title', text: `${repo.name} · ${repo.branch}` }));
      main.append(section);
      if (!view) {
        section.append(el('p', { class: 'empty', text: 'Nothing in this view for this repo.' }));
        continue;
      }
      const files = view.files.filter((f) => state.statuses.has(f.status)
        && (!query || f.path.toLowerCase().includes(query) || (f.old || '').toLowerCase().includes(query)));
      section.append(el('p', {
        class: 'repo-section__meta',
        text: `${view.label}: ${view.newRef} compared with ${view.oldRef} · showing ${files.length} of ${view.files.length} files`,
      }));
      if (!files.length) {
        section.append(el('p', { class: 'empty', text: view.files.length ? 'No files match the filters.' : 'No changes.' }));
        continue;
      }
      const target = el('div');
      section.append(target);
      const ui = new Diff2HtmlUI(target, files.map((f) => f.diff).join(''), {
        outputFormat: state.format,
        drawFileList: true,
        fileListToggle: true,
        fileListStartVisible: false,
        fileContentToggle: false,
        matching: 'none',
        highlight: true,
        synchronisedScroll: true,
        stickyFileHeaders: true,
        colorScheme: 'auto',
      });
      ui.draw();
      ui.highlightCode();
      const wrappers = $$('.d2h-file-wrapper', target);
      const entry = { repo, repoIndex: i, view, files, wrappers, byIndex: wrappers.length === files.length };
      wrappers.forEach((w, k) => decorateFile(entry, w, fileByWrapper(entry, w, k)));
      rendered.push(entry);
      placeAnnotations(entry);
    }
    updateProgress();
    requestAnimationFrame(() => { syncNoteLayout(); updateCurrent(); });
  }

  function fileByWrapper(entry, wrapper, index) {
    if (entry.byIndex) return entry.files[index];
    const name = $('.d2h-file-name', wrapper)?.textContent.trim() || '';
    return entry.files.find((f) => name === f.path || name.endsWith(f.path)) || { path: name, old: null, key: name, status: 'modified' };
  }

  // ---------- rows and line numbers ----------

  function lineNumber(node) {
    const n = parseInt(node && node.textContent.trim(), 10);
    return Number.isNaN(n) ? null : n;
  }

  // Rows showing the given line numbers of one side. In split view each hit carries its
  // twin row on the other side (same index), so both can be marked.
  function rowsFor(wrapper, side, nums) {
    const wanted = new Set(nums);
    const sides = $$('.d2h-file-side-diff', wrapper);
    const hits = [];
    if (sides.length === 2) {
      const mine = $$('tbody tr', sides[side === 'old' ? 0 : 1]);
      const other = $$('tbody tr', sides[side === 'old' ? 1 : 0]);
      mine.forEach((row, k) => {
        const cell = $('.d2h-code-side-linenumber', row);
        if (cell && !cell.classList.contains('d2h-code-side-emptyplaceholder') && wanted.has(lineNumber(cell))) hits.push({ row, twin: other[k] });
      });
    } else {
      $$('tbody tr', wrapper).forEach((row) => {
        const cell = $(side === 'old' ? '.line-num1' : '.line-num2', row);
        if (cell && wanted.has(lineNumber(cell))) hits.push({ row, twin: null });
      });
    }
    return hits;
  }

  function readRow(tr, side) {
    const num = tr.querySelector('.d2h-code-linenumber, .d2h-code-side-linenumber');
    if (!num) return null;
    const cls = num.classList;
    if (cls.contains('d2h-info') || cls.contains('d2h-emptyplaceholder') || cls.contains('d2h-code-side-emptyplaceholder')) return null;
    const type = cls.contains('d2h-ins') ? '+' : cls.contains('d2h-del') ? '-' : ' ';
    let oldN = null;
    let newN = null;
    if (side === 'both') {
      oldN = lineNumber(num.querySelector('.line-num1'));
      newN = lineNumber(num.querySelector('.line-num2'));
    } else if (side === 'old') {
      oldN = lineNumber(num);
    } else {
      newN = lineNumber(num);
    }
    const code = tr.querySelector('.d2h-code-line-ctn');
    return { type, oldN, newN, side, code: code ? code.textContent : '' };
  }

  // Line numbers on the new side open that line in the editor.
  $('#diff').addEventListener('click', (e) => {
    if (!DATA.editor || !window.getSelection().isCollapsed) return;
    const cell = e.target.closest('.line-num2, .d2h-code-side-linenumber');
    const wrapper = cell && cell.closest('.d2h-file-wrapper');
    if (!wrapper || !fileInfo.has(wrapper)) return;
    if (cell.classList.contains('d2h-code-side-linenumber') && cell.closest('.d2h-file-side-diff') !== $$('.d2h-file-side-diff', wrapper)[1]) return;
    const line = lineNumber(cell);
    if (!line) return;
    const { entry, file } = fileInfo.get(wrapper);
    openUrl(editorUrl(entry.repo, file.path, line));
  });
  $('#diff').addEventListener('mouseover', (e) => {
    const cell = e.target.closest('.line-num2, .d2h-file-side-diff + .d2h-file-side-diff .d2h-code-side-linenumber');
    if (cell && DATA.editor && !cell.title) cell.title = 'Open this line in your editor';
  });

  // ---------- selection → reference ----------

  const toolbar = $('#sel-toolbar');
  let lastPicks = null;

  function rowOf(node) {
    const element = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    return element ? element.closest('tr') : null;
  }

  function atEnd(node, offset) {
    return node.nodeType === Node.TEXT_NODE ? offset >= node.length : offset >= node.childNodes.length;
  }

  function collectSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    // A drag that starts at the very end of one row, or stops at the very start of the
    // next, touches that row without selecting any of it.
    const skip = new Set();
    if (atEnd(range.startContainer, range.startOffset)) skip.add(rowOf(range.startContainer));
    if (range.endOffset === 0) skip.add(rowOf(range.endContainer));

    const picks = [];
    for (const entry of rendered) {
      for (const wrapper of entry.wrappers) {
        if (!sel.containsNode(wrapper, true) || isCollapsed(wrapper)) continue;
        const sides = $$('.d2h-file-side-diff', wrapper);
        const panes = sides.length === 2 ? [[sides[0], 'old'], [sides[1], 'new']] : [[$('.d2h-file-diff', wrapper), 'both']];
        let lines = [];
        for (const [pane, side] of panes) {
          if (!pane || !sel.containsNode(pane, true)) continue;
          for (const tr of $$('tbody tr', pane)) {
            if (skip.has(tr) || !sel.containsNode(tr, true)) continue;
            const line = readRow(tr, side);
            if (line) lines.push(line);
          }
        }
        // Split view: an unchanged line sits in both panes; keep the new-side copy.
        if (lines.some((l) => l.side === 'new')) lines = lines.filter((l) => !(l.side === 'old' && l.type === ' '));
        if (lines.length) picks.push({ repo: entry.repo, view: entry.view, file: fileInfo.get(wrapper).file, lines });
      }
    }
    return picks.length ? picks : null;
  }

  function describe(picks, withCode) {
    const out = [];
    const groups = new Map();
    picks.forEach((p) => {
      const key = `${p.repo.path}|${p.view.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    });
    for (const group of groups.values()) {
      const { repo, view } = group[0];
      if (out.length) out.push('');
      out.push(`Selected in a diff of repo \`${repo.name}\` (${repo.path}), branch \`${repo.branch}\`:`);
      out.push(`${view.label}, ${view.newRef} compared with ${view.oldRef}.`);
      for (const { file, lines } of group) {
        const current = lines.filter((l) => l.newN !== null);
        const removed = lines.filter((l) => l.newN === null && l.oldN !== null);
        if (current.length) {
          const added = current.filter((l) => l.type === '+').map((l) => l.newN);
          const kept = current.filter((l) => l.type === ' ').map((l) => l.newN);
          const detail = added.length && kept.length ? ` (added: ${ranges(added)}; unchanged: ${ranges(kept)})`
            : added.length ? ' (added lines)' : ' (unchanged lines)';
          out.push(`- ${file.path}:${ranges(current.map((l) => l.newN))}${detail}, line numbers in ${view.newRef}`);
        }
        if (removed.length) {
          const dropped = removed.filter((l) => l.type === '-').map((l) => l.oldN);
          const what = dropped.length === removed.length ? 'removed lines' : `removed: ${ranges(dropped)}`;
          out.push(`- ${file.old || file.path}:${ranges(removed.map((l) => l.oldN))} (${what}), line numbers in ${view.oldRef}`);
        }
        if (withCode) {
          const width = String(Math.max(...lines.map((l) => l.newN ?? l.oldN ?? 0))).length;
          out.push('', '```diff', `# ${file.path}`);
          lines.forEach((l) => out.push(`${l.type}${String(l.newN ?? l.oldN ?? '').padStart(width)} | ${l.code}`));
          out.push('```');
        }
      }
    }
    return out.join('\n');
  }

  function hideToolbar() {
    toolbar.hidden = true;
    lastPicks = null;
  }

  function updateToolbar() {
    const picks = collectSelection();
    if (!picks) { hideToolbar(); return; }
    lastPicks = picks;
    const lineCount = picks.reduce((n, p) => n + p.lines.length, 0);
    $('#sel-count').textContent = `${lineCount} line${lineCount === 1 ? '' : 's'}` + (picks.length > 1 ? ` · ${picks.length} files` : '');
    toolbar.hidden = false;

    const range = window.getSelection().getRangeAt(0);
    const rects = range.getClientRects();
    const anchor = rects[rects.length - 1] || range.getBoundingClientRect();
    const width = toolbar.offsetWidth;
    const left = Math.min(Math.max(8, window.scrollX + anchor.right - width), window.scrollX + document.documentElement.clientWidth - width - 8);
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${window.scrollY + anchor.bottom + 6}px`;
  }

  async function copySelection(withCode) {
    const picks = lastPicks || collectSelection();
    if (!picks) { toast('Select some lines in the diff first.'); return; }
    const ok = await copy(describe(picks, withCode));
    toast(ok ? 'Reference copied. Paste it to your agent.' : 'Could not reach the clipboard.');
  }

  toolbar.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection alive
  toolbar.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-copy]');
    if (button) copySelection(button.dataset.copy === 'code');
  });
  document.addEventListener('mouseup', (e) => {
    if (!toolbar.contains(e.target)) setTimeout(updateToolbar, 0);
  });
  document.addEventListener('mousedown', (e) => {
    if (!toolbar.contains(e.target)) hideToolbar();
  });

  // ---------- go to a reference ----------

  // Accepts what this page copies ("- path:40-52 (...), line numbers in ..."), plain
  // "path:40-52" / "path:40" / "path", one per line.
  function parseRefs(text) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const listed = lines.filter((l) => l.startsWith('- '));
    const refs = [];
    for (const line of listed.length ? listed : lines) {
      const matches = [...line.matchAll(/([^\s`'"()[\]]+?):(\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*)/g)];
      if (matches.length) {
        matches.forEach((m, k) => {
          const nums = [];
          m[2].split(',').forEach((part) => {
            const [a, b] = part.split('-').map((x) => parseInt(x, 10));
            for (let n = a; n <= (b || a) && n - a < 5000; n += 1) nums.push(n);
          });
          // This page labels base-side lines "(removed ...)"; everything else is the new side.
          const tail = line.slice(m.index + m[0].length, matches[k + 1] ? matches[k + 1].index : undefined);
          refs.push({ path: m[1].replace(/^[-*]\s*/, ''), nums, side: /\(removed/.test(tail) ? 'old' : 'new' });
        });
      } else {
        const path = line.replace(/^[-*]\s*/, '').replace(/[`'"]/g, '').split(/\s/)[0];
        if (path.includes('/') || path.includes('.')) refs.push({ path, nums: [], side: 'new' });
      }
    }
    return refs;
  }

  function findWrapper(path) {
    const wrappers = allWrappers();
    const norm = path.replace(/^\.\//, '');
    return wrappers.find((w) => fileInfo.get(w).file.path === norm)
      || wrappers.find((w) => { const f = fileInfo.get(w).file; return norm.endsWith(`/${f.path}`) || (f.old && norm === f.old); })
      || wrappers.find((w) => fileInfo.get(w).file.path.endsWith(`/${norm}`))
      || null;
  }

  function scrollToNode(node, extra = 0) {
    const header = node.closest('.d2h-file-wrapper') && $('.d2h-file-header', node.closest('.d2h-file-wrapper'));
    const offset = barHeight() + (header && !node.classList.contains('d2h-file-wrapper') ? header.offsetHeight : 0) + extra;
    window.scrollTo({ top: Math.max(0, docTop(node) - offset) });
  }

  function gotoRef(text) {
    const refs = parseRefs(text);
    if (!refs.length) { toast('No file or path:line found in that text.'); return; }
    $$('.dv-hit').forEach((r) => r.classList.remove('dv-hit'));
    const narrowed = state.view !== 'all' || state.filter || state.statuses.size < STATUSES.length
      || (DATA.repos.length > 1 && state.repo !== '*');
    if (narrowed && refs.some((ref) => !findWrapper(ref.path))) {
      clearFilters();
      showView(DATA.repos.length > 1 ? '*' : state.repo, 'all');
    }
    let first = null;
    const missing = [];
    for (const ref of refs) {
      const wrapper = findWrapper(ref.path);
      if (!wrapper) { missing.push(ref.path); continue; }
      revealWrapper(wrapper);
      const hits = ref.nums.length ? rowsFor(wrapper, ref.side, ref.nums) : [];
      hits.forEach(({ row, twin }) => { row.classList.add('dv-hit'); twin?.classList.add('dv-hit'); });
      first = first || (hits[0] && hits[0].row) || wrapper;
      if (ref.nums.length && !hits.length) missing.push(`${ref.path}:${ranges(ref.nums)} (lines outside the diff)`);
    }
    if (first) requestAnimationFrame(() => scrollToNode(first, first.tagName === 'TR' ? 60 : 0));
    toast(missing.length ? `Not found: ${missing.join(', ')}` : `Showing ${refs.length} reference${refs.length === 1 ? '' : 's'}.`);
  }

  const gotoInput = $('#goto-ref');
  gotoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { gotoRef(gotoInput.value); gotoInput.blur(); }
    if (e.key === 'Escape') gotoInput.blur();
  });
  gotoInput.addEventListener('paste', (e) => {
    const text = e.clipboardData.getData('text');
    if (text.includes('\n') || /:\d/.test(text)) {
      e.preventDefault();
      gotoInput.value = parseRefs(text).map((r) => (r.nums.length ? `${r.path}:${ranges(r.nums)}` : r.path)).join('  ');
      gotoRef(text);
    }
  });
  function gotoHash() {
    const m = window.location.hash.match(/^#ref=(.+)$/);
    if (m) gotoRef(decodeURIComponent(m[1]).replace(/;/g, '\n'));
  }
  window.addEventListener('hashchange', gotoHash);

  // ---------- keyboard ----------

  function jump(nodes, delta, offsetFor) {
    const y = window.scrollY;
    const tops = nodes.map((n) => docTop(n) - offsetFor(n));
    const index = delta > 0 ? tops.findIndex((t) => t > y + 2) : tops.map((t, k) => [t, k]).filter(([t]) => t < y - 2).pop()?.[1];
    if (index === undefined || index < 0) return null;
    window.scrollTo({ top: Math.max(0, tops[index]) });
    return nodes[index];
  }

  const headerOffset = (node) => barHeight() + ($('.d2h-file-header', node.closest('.d2h-file-wrapper'))?.offsetHeight || 0) + 4;

  function gotoFile(delta) {
    jump(allWrappers().filter(isVisible), delta, () => barHeight());
  }

  function gotoHunk(delta) {
    const hunks = allWrappers().filter((w) => isVisible(w) && !isCollapsed(w)).flatMap((w) => {
      const pane = $('.d2h-file-side-diff', w) || $('.d2h-file-diff', w);
      return $$('tbody tr', pane).filter((tr) => $('.d2h-info', tr));
    });
    jump(hunks, delta, headerOffset);
  }

  function gotoFinding(delta) {
    const notes = $$('#diff .dv-note').filter(isVisible);
    if (!notes.length) { toast('No findings shown in this view.'); return; }
    jump(notes, delta, (n) => headerOffset(n) + 40);
  }

  function openCurrent() {
    const w = findCurrent();
    if (!w || !DATA.editor) return;
    const { entry, file } = fileInfo.get(w);
    if (file.status !== 'deleted') openUrl(editorUrl(entry.repo, file.path, firstChangedLine(w)));
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideToolbar(); return; }
    const t = e.target;
    if (e.ctrlKey || e.metaKey || e.altKey || t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
    if ($('#help').open) return;
    const actions = {
      j: () => gotoFile(1),
      k: () => gotoFile(-1),
      n: () => gotoHunk(1),
      p: () => gotoHunk(-1),
      f: () => gotoFinding(1),
      F: () => gotoFinding(-1),
      x: () => { const w = findCurrent(); if (w) setCollapsed(w, !isCollapsed(w)); },
      X: () => setAllCollapsed(allWrappers().some((w) => !isCollapsed(w))),
      v: () => {
        const w = findCurrent();
        if (!w) return;
        const viewed = !isViewed(w);
        setViewed(w, viewed);
        if (viewed) requestAnimationFrame(() => { if (isVisible(w)) window.scrollTo({ top: docTop(w) - barHeight() }); });
      },
      c: () => copySelection(false),
      C: () => copySelection(true),
      s: () => $('#copy-summary').click(),
      o: openCurrent,
      '/': () => $('#path-filter').focus(),
      g: () => gotoInput.focus(),
      '?': () => $('#help').showModal(),
    };
    const action = actions[e.key];
    if (action) { e.preventDefault(); action(); }
  });

  // ---------- wiring ----------

  $('#title').textContent = DATA.title;
  $('#generated').textContent = `Generated ${DATA.generated}`;
  $('#repo').addEventListener('change', (e) => { state.repo = e.target.value; fillViewSelect(); fillChips(); render(); });
  $('#view').addEventListener('change', (e) => { state.view = e.target.value; fillChips(); render(); });
  let filterTimer;
  $('#path-filter').addEventListener('input', (e) => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { state.filter = e.target.value; render(); }, 200);
  });
  $('#path-filter').addEventListener('keydown', (e) => { if (e.key === 'Escape') e.target.blur(); });
  $$('.seg button[data-format]').forEach((b) => b.addEventListener('click', () => {
    state.format = b.dataset.format;
    store.set('format', state.format);
    syncToggles();
    render();
  }));
  $('#collapse-all').addEventListener('click', () => setAllCollapsed(true));
  $('#expand-all').addEventListener('click', () => setAllCollapsed(false));
  $('#hide-viewed').addEventListener('click', () => {
    state.hideViewed = !state.hideViewed;
    store.set('hide-viewed', state.hideViewed ? '1' : '0');
    syncToggles();
  });
  $('#copy-summary').addEventListener('click', async () => {
    toast(await copy(summaryText()) ? 'Summary copied. Paste it to your agent.' : 'Could not reach the clipboard.');
  });
  $('#help-open').addEventListener('click', () => $('#help').showModal());

  const details = $('#summary');
  if (store.get('summary') === 'closed') details.open = false;
  details.addEventListener('toggle', () => store.set('summary', details.open ? 'open' : 'closed'));

  const setBarHeight = () => document.documentElement.style.setProperty('--bar-h', `${barHeight()}px`);
  let resizeFrame;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => { setBarHeight(); syncNoteLayout(); });
  });
  let scrollFrame;
  window.addEventListener('scroll', () => {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(updateCurrent);
  }, { passive: true });

  refreshControls();
  summary();
  buildFindings();
  render();
  setBarHeight();
  if (window.location.hash) requestAnimationFrame(gotoHash);
})();
