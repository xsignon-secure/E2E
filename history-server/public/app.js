(function () {
  var keyInput = document.getElementById('key');
  var select = document.getElementById('project');
  var out = document.getElementById('out');
  var key = '';
  try { key = sessionStorage.getItem('history-token') || ''; } catch (e) {}
  keyInput.value = key;

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    (children || []).forEach(function (c) { node.append(c); });
    return node;
  }

  function api(path) {
    return fetch('/api/v1/' + path, { headers: { authorization: 'Bearer ' + key } }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.error + (body.hint ? ' ' + body.hint : ''));
        return body;
      });
    });
  }

  function showError(e) { out.replaceChildren(el('p', { class: 'err' }, [String(e.message || e)])); }

  function table(title, rows) {
    var section = el('section', {}, [el('h2', {}, [title + ' (' + rows.length + ')'])]);
    if (!rows.length) { section.append(el('p', { class: 'muted' }, ['None.'])); return section; }
    var body = el('tbody', {}, rows.map(function (r) {
      return el('tr', {}, [
        el('td', {}, [r.file, el('br'), el('span', { class: 'muted' }, [r.title + (r.project ? ' [' + r.project + ']' : '')])]),
        el('td', { class: 'strip' }, [r.strip]),
        el('td', {}, [Math.round(r.failRate * 100) + '% of ' + r.runs]),
        el('td', { class: 'muted' }, [r.lastError || '']),
      ]);
    }));
    var head = el('thead', {}, [el('tr', {}, ['Test', 'Last runs (P pass, F fail, ~ flaky)', 'Failed', 'Last error'].map(function (h) { return el('th', {}, [h]); }))]);
    section.append(el('div', { class: 'scroll' }, [el('table', {}, [head, body])]));
    return section;
  }

  function stat(value, label) { return el('div', { class: 'stat' }, [el('b', {}, [value]), el('span', {}, [label])]); }

  function loadSummary() {
    if (!select.value) return;
    out.replaceChildren(el('p', { class: 'muted' }, ['Loading…']));
    api('summary?project=' + encodeURIComponent(select.value) + '&lastRuns=100').then(function (s) {
      var stats = el('section', {}, [el('div', { class: 'stats' }, [
        stat(String(s.runs), 'runs'),
        stat(s.passRate === null ? '–' : Math.round(s.passRate * 100) + '%', 'runs passed'),
        stat(String(s.flaky.length), 'flaky tests'),
        stat(String(s.broken.length), 'broken tests'),
      ])]);
      out.replaceChildren(stats, table('Flaky', s.flaky), table('Broken', s.broken));
    }).catch(showError);
  }

  function open() {
    key = keyInput.value.trim();
    if (!key) { out.replaceChildren(el('p', { class: 'muted' }, ['Paste your token first. Whoever runs this server set it in HISTORY_TOKENS.'])); return; }
    try { sessionStorage.setItem('history-token', key); } catch (e) {}
    api('projects').then(function (p) {
      document.getElementById('projects').hidden = !p.projects.length;
      select.replaceChildren.apply(select, p.projects.map(function (x) { return el('option', { value: x.project }, [x.project + ' · ' + x.runs + ' runs']); }));
      if (!p.projects.length) { out.replaceChildren(el('p', { class: 'muted' }, ['No runs yet. Add history-token and history-url to the GitHub Action, or run: npx playwright-e2e-mcp upload'])); return; }
      loadSummary();
    }).catch(showError);
  }

  document.getElementById('auth').addEventListener('submit', function (e) { e.preventDefault(); open(); });
  select.addEventListener('change', loadSummary);
  if (key) open();
})();
