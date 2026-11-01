/**
 * The interactive test report view (MCP Apps, SEP-1865).
 *
 * One self-contained HTML page with no external requests: the host loads it
 * in a sandboxed iframe and talks to it with JSON-RPC over postMessage. The
 * page speaks the small part of the MCP Apps protocol it needs directly
 * (ui/initialize, tool-input, tool-result, tools/call, ui/message,
 * size-changed), so it ships no framework and no bundle.
 *
 * Everything from the tool result is written with textContent, never as
 * HTML: test titles and error messages come from the project under test.
 *
 * Kept as a TypeScript string so `tsc` ships it in dist/ with the server.
 */

export const TEST_REPORT_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Playwright test report</title>
<style>
:root {
  --bg: var(--color-background-primary, #ffffff);
  --bg2: var(--color-background-secondary, #f5f6f8);
  --fg: var(--color-text-primary, #1d2125);
  --fg2: var(--color-text-secondary, #5b636b);
  --line: var(--color-border-primary, #dfe2e6);
  --ok: var(--color-text-success, #1f7a3d);
  --bad: var(--color-text-danger, #b42318);
  --warn: var(--color-text-warning, #9a6700);
  --okbg: var(--color-background-success, #e7f6ec);
  --badbg: var(--color-background-danger, #fdecea);
  --warnbg: var(--color-background-warning, #fff4d6);
  --radius: var(--border-radius-md, 8px);
  --sans: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
  --mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
:root[data-theme="dark"] {
  --bg: var(--color-background-primary, #17191c);
  --bg2: var(--color-background-secondary, #212429);
  --fg: var(--color-text-primary, #e8eaed);
  --fg2: var(--color-text-secondary, #a2a9b1);
  --line: var(--color-border-primary, #33373d);
  --ok: var(--color-text-success, #6fd08c);
  --bad: var(--color-text-danger, #ff8a80);
  --warn: var(--color-text-warning, #f2c94c);
  --okbg: var(--color-background-success, #17301f);
  --badbg: var(--color-background-danger, #3a1d1b);
  --warnbg: var(--color-background-warning, #3a3117);
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 var(--sans); }
main { padding: 14px 16px 16px; }
h1 { font-size: 15px; margin: 0 0 10px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.badge { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
.badge.ok { background: var(--okbg); color: var(--ok); }
.badge.bad { background: var(--badbg); color: var(--bad); }
.badge.warn { background: var(--warnbg); color: var(--warn); }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(84px, 1fr)); gap: 8px; margin-bottom: 12px; }
.stat { background: var(--bg2); border-radius: var(--radius); padding: 8px 10px; }
.stat b { display: block; white-space: nowrap; font-size: 18px; font-variant-numeric: tabular-nums; }
.stat span { color: var(--fg2); font-size: 12px; }
.stat.failed b { color: var(--bad); }
.stat.passed b { color: var(--ok); }
.stat.flaky b { color: var(--warn); }
.bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: var(--bg2); margin-bottom: 12px; }
.bar i { display: block; }
.toolbar { display: flex; gap: 8px; margin-bottom: 8px; }
input[type=search] { flex: 1; min-width: 0; padding: 6px 10px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg); color: var(--fg); font: inherit; }
ul { list-style: none; margin: 0; padding: 0; }
li.failure { border: 1px solid var(--line); border-radius: var(--radius); margin-bottom: 8px; overflow: hidden; }
li.failure > button.head { all: unset; cursor: pointer; display: block; width: 100%; padding: 8px 10px; box-sizing: border-box; }
li.failure > button.head:focus-visible { outline: 2px solid var(--color-ring-primary, #3b82f6); outline-offset: -2px; }
.title { font-weight: 600; word-break: break-word; }
.where { color: var(--fg2); font: 12px var(--mono); word-break: break-all; }
.kind { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--bad); margin-left: 6px; }
.body { padding: 0 10px 10px; display: none; }
li.open .body { display: block; }
pre { margin: 6px 0; padding: 8px; background: var(--bg2); border-radius: 6px; font: 12px/1.4 var(--mono); white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; }
.cmp { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.cmp div > span { font-size: 12px; color: var(--fg2); }
@media (max-width: 480px) { .cmp { grid-template-columns: 1fr; } }
.actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
button.act { font: inherit; font-size: 13px; padding: 5px 10px; border-radius: var(--radius); border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; }
button.act.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
button.act:disabled { opacity: .55; cursor: default; }
.muted { color: var(--fg2); }
.note { font-size: 12px; color: var(--fg2); margin-top: 10px; }
.empty { padding: 18px; text-align: center; color: var(--fg2); background: var(--bg2); border-radius: var(--radius); }
.spin { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--fg2); border-right-color: transparent; border-radius: 50%; animation: s 0.8s linear infinite; }
@keyframes s { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
</head>
<body>
<main id="root"><p class="muted"><span class="spin"></span> Waiting for the test results…</p></main>
<script>
(function () {
  "use strict";
  var root = document.getElementById("root");
  var nextId = 1;
  var pending = {};
  var lastInput = {};
  var hostCaps = {};
  var openai = window.openai;

  // ---- JSON-RPC over postMessage (MCP Apps) ----
  function post(msg) { window.parent.postMessage(msg, "*"); }
  function request(method, params) {
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    });
  }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id !== undefined && !msg.method) {
      var p = pending[msg.id];
      if (!p) return;
      delete pending[msg.id];
      if (msg.error) p.reject(new Error(msg.error.message || "request failed"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "ui/notifications/tool-input") { lastInput = (msg.params && msg.params.arguments) || {}; return; }
    if (msg.method === "ui/notifications/tool-result") { render(msg.params || {}); return; }
    if (msg.method === "ui/notifications/tool-cancelled") { message("The tool call was cancelled."); return; }
    if (msg.method === "ui/notifications/host-context-changed") { applyContext(msg.params || {}); return; }
    if (msg.method === "ui/resource-teardown") { post({ jsonrpc: "2.0", id: msg.id, result: {} }); return; }
    if (msg.method === "ping" && msg.id !== undefined) { post({ jsonrpc: "2.0", id: msg.id, result: {} }); }
  });

  function applyContext(ctx) {
    if (ctx.theme === "dark" || ctx.theme === "light") document.documentElement.setAttribute("data-theme", ctx.theme);
    var vars = ctx.styles && ctx.styles.variables;
    if (vars) Object.keys(vars).forEach(function (k) { if (vars[k]) document.documentElement.style.setProperty(k, vars[k]); });
  }

  function callTool(name, args) {
    if (openai && typeof openai.callTool === "function") return openai.callTool(name, args);
    return request("tools/call", { name: name, arguments: args || {} });
  }
  function canCallTools() { return !!(openai && openai.callTool) || !!hostCaps.serverTools; }
  function sendMessage(text) {
    if (openai && typeof openai.sendFollowUpMessage === "function") return openai.sendFollowUpMessage({ prompt: text });
    return request("ui/message", { role: "user", content: [{ type: "text", text: text }] });
  }
  function canMessage() { return !!(openai && openai.sendFollowUpMessage) || !!hostCaps.message; }

  // ---- DOM helpers (textContent only) ----
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function clear() { while (root.firstChild) root.removeChild(root.firstChild); }
  function message(text) { clear(); root.appendChild(el("p", "muted", text)); }
  function where(f) { return f.file + (f.line ? ":" + f.line : ""); }
  function duration(ms) {
    if (typeof ms !== "number") return "";
    if (ms < 1000) return Math.round(ms) + " ms";
    var s = ms / 1000;
    return s < 60 ? s.toFixed(1) + " s" : Math.floor(s / 60) + "m " + Math.round(s % 60) + "s";
  }
  function button(label, cls, onClick) {
    var b = el("button", "act" + (cls ? " " + cls : ""), label);
    b.type = "button";
    b.addEventListener("click", function () {
      if (b.disabled) return;
      b.disabled = true;
      var before = b.textContent;
      b.textContent = "…";
      Promise.resolve().then(onClick).catch(function (err) {
        b.title = String(err && err.message || err);
      }).then(function () { b.disabled = false; b.textContent = before; });
    });
    return b;
  }

  // ---- views ----
  function render(result) {
    var data = result.structuredContent;
    if (!data && result.content) {
      // Hosts that drop structuredContent: show the Markdown text.
      clear();
      var text = result.content.filter(function (c) { return c.type === "text"; }).map(function (c) { return c.text; }).join("\n\n");
      root.appendChild(el("pre", null, text || "No result."));
      return;
    }
    data = data || {};
    if (data.error) return renderError(data.error);
    if (data.run) return renderRun(data);
    if (data.failure) return renderSingleFailure(data);
    if (data.status === "running" && data.runId) return renderRunning(data);
    message(data.ok ? "Done." : "The tool reported a problem; see the text reply.");
  }

  function renderError(error) {
    clear();
    var h = el("h1", null, "Could not run the tests");
    h.appendChild(el("span", "badge bad", error.kind || "ERROR"));
    root.appendChild(h);
    root.appendChild(el("pre", null, error.message || ""));
    if (error.hint) root.appendChild(el("p", "muted", error.hint));
  }

  function renderRunning(data) {
    clear();
    var h = el("h1", null, "Tests are running");
    h.appendChild(el("span", "badge warn", data.runId));
    root.appendChild(h);
    var p = el("p", "muted");
    p.appendChild(el("span", "spin"));
    p.appendChild(document.createTextNode(" This report updates when the run finishes."));
    root.appendChild(p);
    if (!canCallTools()) return;
    var poll = function () {
      callTool("get-run-status", { runId: data.runId, waitSeconds: 20 }).then(function (res) {
        var sc = (res && res.structuredContent) || {};
        if (sc.status === "running" && !sc.run) setTimeout(poll, 500);
        else render(res);
      }).catch(function () { setTimeout(poll, 5000); });
    };
    setTimeout(poll, 500);
  }

  function renderRun(data) {
    var run = data.run;
    clear();
    var total = run.passed + run.failed + run.flaky + run.skipped;
    var h = el("h1", null, "Playwright test report");
    var verdict = run.failed > 0 ? ["bad", run.failed + " failed"] : run.flaky > 0 ? ["warn", "flaky"] : total === 0 ? ["warn", "no tests ran"] : ["ok", "all passed"];
    h.appendChild(el("span", "badge " + verdict[0], verdict[1]));
    if (run.partial) h.appendChild(el("span", "badge warn", "stopped early"));
    if (data.status === "cancelled") h.appendChild(el("span", "badge warn", "cancelled"));
    root.appendChild(h);

    var stats = el("div", "stats");
    [["passed", run.passed], ["failed", run.failed], ["flaky", run.flaky], ["skipped", run.skipped]].forEach(function (s) {
      var box = el("div", "stat " + s[0]);
      box.appendChild(el("b", null, s[1]));
      box.appendChild(el("span", null, s[0]));
      stats.appendChild(box);
    });
    var time = el("div", "stat");
    time.appendChild(el("b", null, duration(run.durationMs)));
    time.appendChild(el("span", null, "duration"));
    stats.appendChild(time);
    root.appendChild(stats);

    if (total > 0) {
      var bar = el("div", "bar");
      bar.setAttribute("role", "img");
      bar.setAttribute("aria-label", run.passed + " passed, " + run.failed + " failed, " + run.flaky + " flaky, " + run.skipped + " skipped");
      [["passed", "var(--ok)"], ["failed", "var(--bad)"], ["flaky", "var(--warn)"], ["skipped", "var(--line)"]].forEach(function (s) {
        if (!run[s[0]]) return;
        var seg = el("i");
        seg.style.width = (100 * run[s[0]] / total) + "%";
        seg.style.background = s[1];
        bar.appendChild(seg);
      });
      root.appendChild(bar);
    }

    if (!run.failures.length) {
      root.appendChild(el("div", "empty", run.failed > 0 ? "Failures were not listed. Ask for get-failure." : "No failures."));
    } else {
      var toolbar = el("div", "toolbar");
      var search = el("input");
      search.type = "search";
      search.placeholder = "Filter failures by title, file or error";
      search.setAttribute("aria-label", "Filter failures");
      toolbar.appendChild(search);
      if (run.failures.length > 1 && canMessage()) {
        toolbar.appendChild(button("Fix all", "primary", function () {
          return sendMessage("Please fix the " + run.failures.length + " failing Playwright tests from the last run. Start with get-failure for each one, then suggest-fix.");
        }));
      }
      root.appendChild(toolbar);
      var list = el("ul");
      run.failures.forEach(function (f, i) { list.appendChild(failureItem(f, i + 1, run.failures.length === 1)); });
      root.appendChild(list);
      search.addEventListener("input", function () {
        var q = search.value.trim().toLowerCase();
        Array.prototype.forEach.call(list.children, function (li) {
          li.style.display = !q || li.getAttribute("data-text").indexOf(q) >= 0 ? "" : "none";
        });
      });
      if (run.failuresTruncated) root.appendChild(el("p", "note", "Only the first failures are listed; the text reply has the rest."));
    }
    if (run.quarantined) root.appendChild(el("p", "note", run.quarantined + " failing test(s) are quarantined and do not fail the run."));
    var rerun = rerunArgs();
    if (rerun && canCallTools()) {
      var actions = el("div", "actions");
      actions.appendChild(button("Run again", null, function () {
        message("Running the tests again…");
        return callTool("run-test", rerun).then(render);
      }));
      root.appendChild(actions);
    }
  }

  function rerunArgs() {
    var keep = {};
    ["testFiles", "grep", "browser", "config", "projectRoot", "retries", "workers", "lastFailed", "timeoutMs", "testTimeoutMs"].forEach(function (k) {
      if (lastInput[k] !== undefined) keep[k] = lastInput[k];
    });
    return keep;
  }

  function failureItem(f, index, open) {
    var li = el("li", "failure" + (open ? " open" : ""));
    li.setAttribute("data-text", (f.title + " " + f.file + " " + f.message).toLowerCase());
    var head = el("button", "head");
    head.type = "button";
    head.setAttribute("aria-expanded", open ? "true" : "false");
    var t = el("div", "title", f.title);
    t.appendChild(el("span", "kind", f.kind));
    head.appendChild(t);
    head.appendChild(el("div", "where", where(f) + (f.project ? "  ·  " + f.project : "")));
    li.appendChild(head);
    var body = el("div", "body");
    body.appendChild(el("pre", null, f.message));
    var details = el("div");
    body.appendChild(details);
    var actions = el("div", "actions");
    if (canCallTools()) {
      actions.appendChild(button("Show details", null, function () {
        return callTool("get-failure", { index: index }).then(function (res) {
          var sc = (res && res.structuredContent) || {};
          while (details.firstChild) details.removeChild(details.firstChild);
          fillDetails(details, sc.failure, res);
        });
      }));
      actions.appendChild(button("Re-run this test", null, function () {
        message("Running " + where(f) + "…");
        return callTool("run-test", { testFiles: [where(f)] }).then(render);
      }));
    }
    if (canMessage()) {
      actions.appendChild(button("Ask to fix", "primary", function () {
        return sendMessage("Fix the failing Playwright test \"" + f.title + "\" at " + where(f) + ". Call get-failure with index " + index + " first, then suggest-fix.");
      }));
    }
    if (actions.firstChild) body.appendChild(actions);
    li.appendChild(body);
    head.addEventListener("click", function () {
      var isOpen = li.classList.toggle("open");
      head.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });
    return li;
  }

  function fillDetails(target, failure, res) {
    if (failure && (failure.expected || failure.actual)) {
      var cmp = el("div", "cmp");
      var a = el("div"); a.appendChild(el("span", null, "Expected")); a.appendChild(el("pre", null, failure.expected || ""));
      var b = el("div"); b.appendChild(el("span", null, "Received")); b.appendChild(el("pre", null, failure.actual || ""));
      cmp.appendChild(a); cmp.appendChild(b);
      target.appendChild(cmp);
    }
    var text = ((res && res.content) || []).filter(function (c) { return c.type === "text"; }).map(function (c) { return c.text; }).join("\n\n");
    if (text) target.appendChild(el("pre", null, text));
  }

  function renderSingleFailure(data) {
    clear();
    var f = data.failure;
    var h = el("h1", null, "Failure " + (data.index || 1) + (data.total ? " of " + data.total : ""));
    h.appendChild(el("span", "badge bad", f.kind));
    root.appendChild(h);
    root.appendChild(el("div", "title", f.title));
    root.appendChild(el("div", "where", where(f)));
    var box = el("div");
    box.appendChild(el("pre", null, f.message));
    fillDetails(box, { expected: f.expected, actual: f.actual }, null);
    root.appendChild(box);
    var actions = el("div", "actions");
    if (canCallTools() && data.total && data.total > 1) {
      var i = data.index || 1;
      if (i > 1) actions.appendChild(button("Previous", null, function () { return callTool("get-failure", { index: i - 1 }).then(render); }));
      if (i < data.total) actions.appendChild(button("Next", null, function () { return callTool("get-failure", { index: i + 1 }).then(render); }));
    }
    if (canMessage()) {
      actions.appendChild(button("Ask to fix", "primary", function () {
        return sendMessage("Fix the failing Playwright test \"" + f.title + "\" at " + where(f) + " with suggest-fix.");
      }));
    }
    if (actions.firstChild) root.appendChild(actions);
  }

  // ---- size reporting ----
  function reportSize() {
    var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    notify("ui/notifications/size-changed", { width: Math.ceil(window.innerWidth), height: h });
  }

  // ---- start ----
  if (openai) {
    // ChatGPT's window.openai bridge: the result is already there.
    if (openai.toolInput) lastInput = openai.toolInput;
    if (openai.toolOutput) render({ structuredContent: openai.toolOutput });
    window.addEventListener("openai:set_globals", function () {
      if (window.openai.toolOutput) render({ structuredContent: window.openai.toolOutput });
    });
    return;
  }
  request("ui/initialize", {
    appInfo: { name: "playwright-e2e-mcp-report", version: "1.0.0" },
    appCapabilities: {},
    protocolVersion: "2026-01-26"
  }).then(function (init) {
    hostCaps = (init && init.hostCapabilities) || {};
    applyContext((init && init.hostContext) || {});
    notify("ui/notifications/initialized", {});
    if (typeof ResizeObserver === "function") new ResizeObserver(reportSize).observe(document.body);
    reportSize();
  }).catch(function () { /* not inside an MCP Apps host */ });
})();
</script>
</body>
</html>
`;
