/* MagicUI iframe runtime.
 *
 * Plain dependency-free JS (Chart.js UMD is inlined separately by the host).
 * Runs inside a sandboxed, opaque-origin iframe with a no-network CSP.
 * Receives full dashboard snapshots from the host over postMessage and diffs
 * them against the DOM via per-slot updatedAt — no framework, no reducer.
 *
 * Contract highlights:
 * - The dashboard NEVER scrolls. Cards clip; clipped content gets an
 *   expander that opens an overlay (the only scrollable surface).
 * - Decisions and Open Points are runtime chrome: always visible, never
 *   condensed away, and interactive decision controls are built from REAL
 *   permission data pushed by the host — never from watcher output.
 * - Clipboard goes through the host (copy_request) because an opaque-origin
 *   iframe cannot reliably use navigator.clipboard itself.
 */
/* global Chart */
(function () {
  "use strict";

  var CHANNEL = "magic-ui";
  var charts = new Map(); // slot -> Chart instance
  var renderedSlots = new Map(); // slot -> updatedAt
  var lastState = null;
  var pendingDecisions = new Map(); // requestId -> decision model
  var decisionSelections = new Map(); // requestId -> Map(questionIndex -> answer)

  function post(msg) {
    msg.channel = CHANNEL;
    window.parent.postMessage(msg, "*");
  }

  window.addEventListener("error", function (e) {
    post({ type: "runtime_error", message: String((e && e.message) || "unknown error") });
  });

  // ── Palette (mirrors runtime.css custom properties) ──────────────────
  function cssVar(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }
  function seriesColors() {
    return [cssVar("--s1"), cssVar("--s2"), cssVar("--s3"), cssVar("--s4"), cssVar("--s5"), cssVar("--s6"), cssVar("--s7"), cssVar("--s8")];
  }

  // ── DOM helpers ──────────────────────────────────────────────────────
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // Sanitized-by-the-server HTML still goes through a conservative client
  // gate: template-parse and strip anything executable that could have
  // slipped through. Belt and braces — the CSP is the actual wall.
  function setGeneratedHtml(target, html) {
    var tpl = document.createElement("template");
    tpl.innerHTML = html;
    var bad = tpl.content.querySelectorAll("script, style, iframe, object, embed, link, meta, img, svg, video, audio, form, input, button, a");
    for (var i = 0; i < bad.length; i++) bad[i].remove();
    var walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      var node = walker.currentNode;
      for (var a = node.attributes.length - 1; a >= 0; a--) {
        var attr = node.attributes[a];
        var name = attr.name.toLowerCase();
        if (name.indexOf("on") === 0 || name === "style" || name === "href" || name === "src") {
          node.removeAttribute(attr.name);
        }
      }
    }
    clear(target);
    target.appendChild(tpl.content);
  }

  // ── Overlay (the expander target) ────────────────────────────────────
  function openOverlay(title, fillBody) {
    var overlay = document.getElementById("overlay");
    var titleEl = overlay.querySelector(".overlay-title-text");
    var body = overlay.querySelector(".overlay-body");
    titleEl.textContent = title || "";
    clear(body);
    fillBody(body);
    overlay.classList.add("open");
  }
  function closeOverlay() {
    document.getElementById("overlay").classList.remove("open");
    // Destroy chart instances that live only inside the overlay.
    charts.forEach(function (chart, key) {
      if (key.indexOf("overlay:") === 0) {
        chart.destroy();
        charts.delete(key);
      }
    });
  }

  function copyButton(getText) {
    var btn = el("button", "icon-btn copy-btn");
    btn.title = "Copy to clipboard";
    btn.setAttribute("aria-label", "Copy to clipboard");
    btn.textContent = "⧉";
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      post({ type: "copy_request", text: getText() });
      btn.classList.add("copied");
      btn.textContent = "✓";
      setTimeout(function () {
        btn.classList.remove("copied");
        btn.textContent = "⧉";
      }, 1200);
    });
    return btn;
  }

  function expandButton(title, fillBody) {
    var btn = el("button", "icon-btn expand-btn");
    btn.title = "Expand";
    btn.setAttribute("aria-label", "Expand " + (title || "card"));
    btn.textContent = "⤢";
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      openOverlay(title, fillBody);
    });
    return btn;
  }

  // ── Slot cards ───────────────────────────────────────────────────────
  // chartKey lets overlay renders (archived topics) keep their Chart.js
  // instances separate from the live board's.
  function buildCard(name, slot, chartKey) {
    var card = el("div", "card");
    card.dataset.slot = name;
    var actions = el("div", "card-actions");
    card.appendChild(actions);

    if (slot.title && !slot.stat) {
      card.appendChild(el("div", "card-title", slot.title));
    }
    var body = el("div", "card-body");
    card.appendChild(body);

    if (slot.chart) {
      var wrap = el("div", "chart-wrap");
      body.appendChild(wrap);
      var canvas = document.createElement("canvas");
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", slot.title || slot.chart.title || "chart");
      wrap.appendChild(canvas);
      renderChart(chartKey || name, canvas, slot.chart);
    } else if (slot.stat) {
      var statBox = el("div");
      var valueRow = el("div");
      var value = el("span", "stat-value", slot.stat.value);
      valueRow.appendChild(value);
      if (slot.stat.trend) {
        var arrow = slot.stat.trend === "up" ? "▲" : slot.stat.trend === "down" ? "▼" : "◆";
        var trend = el("span", "stat-trend " + slot.stat.trend, arrow);
        trend.setAttribute("aria-label", "trend " + slot.stat.trend);
        valueRow.appendChild(trend);
      }
      statBox.appendChild(valueRow);
      statBox.appendChild(el("div", "stat-label", slot.stat.label));
      body.appendChild(statBox);
    } else if (slot.snippet) {
      card.classList.add("snippet");
      var snip = slot.snippet;
      if (snip.language) body.appendChild(el("span", "lang-chip", snip.language));
      var pre = el("pre");
      pre.textContent = snip.code;
      body.appendChild(pre);
      actions.appendChild(copyButton(function () { return snip.code; }));
      actions.appendChild(expandButton(snip.title, function (target) {
        if (snip.language) target.appendChild(el("span", "lang-chip", snip.language));
        var full = el("pre");
        full.textContent = snip.code;
        target.appendChild(full);
        var copyRow = el("div", "dp-buttons");
        var cp = el("button", "dp-btn primary", "Copy script");
        cp.addEventListener("click", function () {
          post({ type: "copy_request", text: snip.code });
          cp.textContent = "Copied ✓";
        });
        copyRow.appendChild(cp);
        target.appendChild(copyRow);
      }));
    } else if (slot.html) {
      var gen = el("div", "gen");
      setGeneratedHtml(gen, slot.html);
      body.appendChild(gen);
    }

    return card;
  }

  // After cards are in the document, mark clipped ones and give them an
  // expander (never a scrollbar).
  function applyClipAffordances(container) {
    var bodies = container.querySelectorAll(".card-body");
    for (var i = 0; i < bodies.length; i++) {
      (function (body) {
        var card = body.parentElement;
        if (card.querySelector(".chart-wrap")) return; // charts fit by design
        if (body.scrollHeight > body.clientHeight + 2) {
          body.classList.add("clipped");
          var actions = card.querySelector(".card-actions");
          if (actions && !actions.querySelector(".expand-btn")) {
            var titleEl = card.querySelector(".card-title");
            var html = body.querySelector(".gen");
            var pre = body.querySelector("pre");
            actions.appendChild(expandButton(
              titleEl ? titleEl.textContent : "",
              function (target) {
                var clone = (html || pre || body).cloneNode(true);
                clone.classList && clone.classList.remove("clipped");
                target.appendChild(clone);
              }
            ));
          }
        }
      })(bodies[i]);
    }
  }

  // ── Charts (Chart.js; dataviz-skill mark specs) ──────────────────────
  function baseScales(showAxes) {
    if (!showAxes) return { x: { display: false }, y: { display: false } };
    return {
      x: {
        grid: { display: false },
        border: { color: cssVar("--baseline") },
        ticks: { color: cssVar("--muted"), font: { size: 10 }, maxRotation: 0, autoSkip: true },
      },
      y: {
        grid: { color: cssVar("--grid") },
        border: { display: false },
        ticks: { color: cssVar("--muted"), font: { size: 10 }, maxTicksLimit: 5 },
        beginAtZero: true,
      },
    };
  }

  function renderChart(name, canvas, spec) {
    if (typeof Chart === "undefined") return;
    var colors = seriesColors();
    var multi = spec.series.length > 1;
    var isSpark = spec.kind === "sparkline";
    var isDonut = spec.kind === "donut";
    var labels = spec.labels || spec.series[0].data.map(function (_, i) { return String(i + 1); });

    var datasets;
    if (isDonut) {
      // Donut encodes one series across labels; slice colors follow the
      // fixed categorical order with a 2px surface gap between segments.
      datasets = [{
        data: spec.series[0].data,
        backgroundColor: spec.series[0].data.map(function (_, i) { return colors[i % colors.length]; }),
        borderColor: cssVar("--surface-1"),
        borderWidth: 2,
      }];
      labels = spec.labels || spec.series.map(function (s) { return s.label; });
      if (!spec.labels && spec.series.length > 1) {
        // Alternate donut shape: one value per series entry.
        datasets = [{
          data: spec.series.map(function (s) { return s.data[0] || 0; }),
          backgroundColor: spec.series.map(function (_, i) { return colors[i % colors.length]; }),
          borderColor: cssVar("--surface-1"),
          borderWidth: 2,
        }];
      }
    } else {
      datasets = spec.series.map(function (s, i) {
        var color = colors[i % colors.length];
        if (spec.kind === "bar") {
          return {
            label: s.label,
            data: s.data,
            backgroundColor: color,
            // 4px rounded data-end, anchored baseline; 2px surface gap via
            // percentage spacing; thin bars.
            borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 },
            borderSkipped: "start",
            maxBarThickness: 26,
            categoryPercentage: 0.72,
            barPercentage: 0.9,
          };
        }
        return {
          label: s.label,
          data: s.data,
          borderColor: color,
          backgroundColor: color,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.25,
          fill: false,
        };
      });
    }

    var config = {
      type: isDonut ? "doughnut" : spec.kind === "bar" ? "bar" : "line",
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        cutout: isDonut ? "62%" : undefined,
        plugins: {
          legend: {
            display: (multi && !isSpark) || isDonut,
            position: "bottom",
            labels: {
              color: cssVar("--ink-2"),
              usePointStyle: true,
              pointStyle: "rectRounded",
              boxWidth: 8,
              boxHeight: 8,
              font: { size: 10 },
            },
          },
          tooltip: {
            enabled: !isSpark,
            backgroundColor: cssVar("--surface-1"),
            titleColor: cssVar("--ink"),
            bodyColor: cssVar("--ink-2"),
            borderColor: cssVar("--baseline"),
            borderWidth: 1,
            titleFont: { size: 11 },
            bodyFont: { size: 11 },
          },
          title: { display: false },
        },
        scales: isDonut ? undefined : baseScales(!isSpark),
      },
    };

    var existing = charts.get(name);
    if (existing) existing.destroy();
    charts.set(name, new Chart(canvas, config));
  }

  // ── Panels: Open Points + Decisions (runtime chrome) ─────────────────
  var KIND_LABEL = { action: "TO DO", question: "ASKED", blocker: "BLOCKED" };
  var KIND_ICON = { action: "▸", question: "?", blocker: "⚠" };

  function renderOpenItems(items) {
    var panelBody = document.getElementById("open-points-body");
    clear(panelBody);
    if (!items.length) {
      panelBody.appendChild(el("div", "panel-empty", "Nothing waiting on you."));
      return;
    }
    var maxVisible = 5;
    items.slice(0, maxVisible).forEach(function (item) {
      var row = el("div", "open-item");
      var chip = el("span", "kind-chip " + item.kind);
      chip.appendChild(el("span", null, KIND_ICON[item.kind] || "▸"));
      chip.appendChild(el("span", null, KIND_LABEL[item.kind] || "TO DO"));
      row.appendChild(chip);
      row.appendChild(el("span", null, item.text));
      panelBody.appendChild(row);
    });
    if (items.length > maxVisible) {
      var more = el("button", "more-row", "Show all " + items.length + " open points…");
      more.addEventListener("click", function () {
        openOverlay("Open points", function (target) {
          items.forEach(function (item) {
            var row = el("div", "open-item");
            var chip = el("span", "kind-chip " + item.kind);
            chip.appendChild(el("span", null, KIND_ICON[item.kind] || "▸"));
            chip.appendChild(el("span", null, KIND_LABEL[item.kind] || "TO DO"));
            row.appendChild(chip);
            row.appendChild(el("span", null, item.text));
            target.appendChild(row);
          });
        });
      });
      panelBody.appendChild(more);
    }
  }

  // ── Archived topics (chips in the status strip) ──────────────────────
  function openTopicOverlay(topic) {
    openOverlay(topic.title, function (target) {
      var grid = el("div", "overlay-grid");
      target.appendChild(grid);
      var names = Object.keys(topic.slots || {});
      // Respect the topic's layout order where available.
      names.sort(function (a, b) {
        var la = (topic.layout || []).findIndex(function (l) { return l.slot === a; });
        var lb = (topic.layout || []).findIndex(function (l) { return l.slot === b; });
        if (la !== -1 && lb !== -1) return la - lb;
        if (la !== -1) return -1;
        if (lb !== -1) return 1;
        return 0;
      });
      names.forEach(function (name) {
        var card = buildCard(name, topic.slots[name], "overlay:" + topic.id + ":" + name);
        grid.appendChild(card);
      });
      if (names.length === 0) {
        target.appendChild(el("div", "panel-empty", "This topic had no content."));
      }
    });
  }

  function renderTopics(state) {
    var host = document.getElementById("topic-chips");
    clear(host);
    var topics = state.topics || [];
    if (state.currentTopicTitle && (topics.length > 0 || state.currentTopicTitle !== "Session")) {
      host.appendChild(el("span", "topic-current", state.currentTopicTitle));
    }
    topics.forEach(function (topic) {
      var chip = el("button", "topic-chip", topic.title);
      chip.title = "Reopen archived topic: " + topic.title;
      chip.addEventListener("click", function () { openTopicOverlay(topic); });
      host.appendChild(chip);
    });
  }

  var SRC_LABEL = { user: "You", ai_auto: "AI", agent: "Agent" };

  function decisionRow(entry) {
    var row = el("div", "decision");
    var head = el("div", "decision-head");
    head.appendChild(el("span", "src-chip " + entry.source, SRC_LABEL[entry.source] || entry.source));
    head.appendChild(el("span", "decision-title", entry.title));
    if (entry.behavior) {
      head.appendChild(el("span", "behavior " + entry.behavior, entry.behavior === "allow" ? "✓ allowed" : "✕ denied"));
    }
    row.appendChild(head);
    row.appendChild(el("div", "decision-detail", entry.detail));
    return row;
  }

  function renderDecisionLog(entries) {
    var panelBody = document.getElementById("decisions-body");
    clear(panelBody);
    if (!entries.length) {
      panelBody.appendChild(el("div", "panel-empty", "No decisions yet."));
      return;
    }
    var maxVisible = 6;
    entries.slice(0, maxVisible).forEach(function (entry) {
      panelBody.appendChild(decisionRow(entry));
    });
    if (entries.length > maxVisible) {
      var more = el("button", "more-row", "Show all " + entries.length + " decisions…");
      more.addEventListener("click", function () {
        openOverlay("Decisions", function (target) {
          entries.forEach(function (entry) { target.appendChild(decisionRow(entry)); });
        });
      });
      panelBody.appendChild(more);
    }
  }

  // ── Live decision prompts (interactive; host-fed real data) ──────────
  function submitDecision(requestId, response) {
    post({ type: "decision_response", requestId: requestId, response: response });
    pendingDecisions.delete(requestId);
    decisionSelections.delete(requestId);
    renderLiveDecisions();
  }

  function buildQuestionBlock(requestId, q, qIndex, singleAutoSubmit) {
    var block = el("div", "dp-question");
    if (q.question) block.appendChild(el("div", "q-text", q.question));
    var btnRow = el("div", "dp-buttons");
    var selections = decisionSelections.get(requestId);

    (q.options || []).forEach(function (opt) {
      var label = typeof opt === "string" ? opt : opt.label;
      var btn = el("button", "dp-btn", label);
      if (typeof opt === "object" && opt.description) btn.title = opt.description;
      if (selections && selections.get(qIndex) === label) btn.classList.add("selected");
      btn.addEventListener("click", function () {
        if (singleAutoSubmit) {
          submitDecision(requestId, { action: "answers", answers: [{ index: qIndex, question: q.question, answer: label }] });
          return;
        }
        var sel = decisionSelections.get(requestId) || new Map();
        sel.set(qIndex, label);
        decisionSelections.set(requestId, sel);
        renderLiveDecisions();
      });
      btnRow.appendChild(btn);
    });

    var input = el("input", "dp-input");
    input.type = "text";
    input.placeholder = "Other…";
    input.setAttribute("aria-label", "Custom answer");
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && input.value.trim()) {
        if (singleAutoSubmit) {
          submitDecision(requestId, { action: "answers", answers: [{ index: qIndex, question: q.question, answer: input.value.trim() }] });
        } else {
          var sel = decisionSelections.get(requestId) || new Map();
          sel.set(qIndex, input.value.trim());
          decisionSelections.set(requestId, sel);
          renderLiveDecisions();
        }
      }
    });

    block.appendChild(btnRow);
    block.appendChild(input);
    return block;
  }

  function buildDecisionPrompt(model) {
    var box = el("div", "decision-prompt");
    box.dataset.requestId = model.requestId;
    box.appendChild(el("div", "dp-title", model.title));
    if (model.detail) {
      var detail = el("div", "dp-detail");
      detail.textContent = model.detail;
      box.appendChild(detail);
    }

    if (model.kind === "ask_user_question" && model.questions && model.questions.length) {
      var single = model.questions.length === 1;
      model.questions.forEach(function (q, i) {
        box.appendChild(buildQuestionBlock(model.requestId, q, i, single));
      });
      if (!single) {
        var row = el("div", "dp-buttons");
        var submit = el("button", "dp-btn primary", "Submit answers");
        submit.addEventListener("click", function () {
          var sel = decisionSelections.get(model.requestId) || new Map();
          var answers = model.questions.map(function (q, i) {
            return { index: i, question: q.question, answer: sel.get(i) || "" };
          });
          if (answers.some(function (a) { return !a.answer; })) return;
          submitDecision(model.requestId, { action: "answers", answers: answers });
        });
        row.appendChild(submit);
        box.appendChild(row);
      }
    } else {
      var buttons = el("div", "dp-buttons");
      var allow = el("button", "dp-btn primary", model.kind === "exit_plan_mode" ? "Approve plan" : "Allow");
      allow.addEventListener("click", function () {
        submitDecision(model.requestId, { action: "allow" });
      });
      buttons.appendChild(allow);
      (model.suggestions || []).forEach(function (s) {
        var btn = el("button", "dp-btn", s.label);
        btn.addEventListener("click", function () {
          submitDecision(model.requestId, { action: "allow", suggestionIndex: s.index });
        });
        buttons.appendChild(btn);
      });
      var deny = el("button", "dp-btn deny", "Deny");
      deny.addEventListener("click", function () {
        submitDecision(model.requestId, { action: "deny" });
      });
      buttons.appendChild(deny);
      box.appendChild(buttons);
    }
    return box;
  }

  function renderLiveDecisions() {
    var host = document.getElementById("decisions-live");
    clear(host);
    pendingDecisions.forEach(function (model) {
      host.appendChild(buildDecisionPrompt(model));
    });
  }

  // ── Main render (diff by slot updatedAt) ─────────────────────────────
  function renderState(state) {
    lastState = state;
    var hero = document.getElementById("hero");
    var main = document.getElementById("main");
    var emptyState = document.getElementById("empty-state");

    var areaFor = {};
    var spanFor = {};
    (state.layout || []).forEach(function (l) {
      areaFor[l.slot] = l.area;
      spanFor[l.slot] = l.span;
    });

    var slotNames = Object.keys(state.slots || {});
    emptyState.style.display = slotNames.length ? "none" : "flex";

    // Remove cards whose slots are gone.
    var existingCards = document.querySelectorAll(".card[data-slot]");
    for (var i = 0; i < existingCards.length; i++) {
      var cardEl = existingCards[i];
      var slotName = cardEl.dataset.slot;
      if (!state.slots[slotName]) {
        var chart = charts.get(slotName);
        if (chart) { chart.destroy(); charts.delete(slotName); }
        renderedSlots.delete(slotName);
        cardEl.remove();
      }
    }

    // Add/update slots. Order: layout order first, then remaining by recency.
    var ordered = slotNames.slice().sort(function (a, b) {
      var la = (state.layout || []).findIndex(function (l) { return l.slot === a; });
      var lb = (state.layout || []).findIndex(function (l) { return l.slot === b; });
      if (la !== -1 && lb !== -1) return la - lb;
      if (la !== -1) return -1;
      if (lb !== -1) return 1;
      return state.slots[b].updatedAt - state.slots[a].updatedAt;
    });

    ordered.forEach(function (name) {
      var slot = state.slots[name];
      var area = areaFor[name] || "main";
      var target = area === "hero" ? hero : main; // side/footer areas are chrome-reserved
      var existing = document.querySelector('.card[data-slot="' + CSS.escape(name) + '"]');
      var unchanged = existing && renderedSlots.get(name) === slot.updatedAt
        && existing.parentElement === target;
      if (unchanged) return;
      if (existing) {
        var oldChart = charts.get(name);
        if (oldChart) { oldChart.destroy(); charts.delete(name); }
        existing.remove();
      }
      var card = buildCard(name, slot);
      var span = spanFor[name];
      if (span === 2) card.classList.add("span-2");
      if (span === 3) card.classList.add("span-3");
      target.appendChild(card);
      renderedSlots.set(name, slot.updatedAt);
    });

    renderOpenItems(state.openItems || []);
    renderDecisionLog(state.decisionLog || []);
    renderTopics(state);

    var dot = document.getElementById("status-dot");
    dot.className = "status-dot" + (state.status !== "live" ? " " + state.status : "");
    document.getElementById("status-text").textContent =
      state.status === "live" ? "Live" : state.status === "degraded" ? "Watcher degraded" : "Watcher idle";

    applyClipAffordances(document.getElementById("root"));
  }

  // ── Message handling ─────────────────────────────────────────────────
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.channel !== CHANNEL) return;
    switch (data.type) {
      case "init":
      case "theme":
        document.body.dataset.theme = data.theme === "dark" ? "dark" : "light";
        // Re-render charts so chrome colors pick up the new mode.
        if (lastState) {
          renderedSlots.clear();
          renderState(lastState);
        }
        break;
      case "state":
        renderState(data.state);
        break;
      case "decision_show":
        pendingDecisions.set(data.request.requestId, data.request);
        renderLiveDecisions();
        post({ type: "decision_ack", requestId: data.request.requestId });
        break;
      case "decision_hide":
        pendingDecisions.delete(data.requestId);
        decisionSelections.delete(data.requestId);
        renderLiveDecisions();
        break;
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeOverlay();
  });

  // ── Boot ─────────────────────────────────────────────────────────────
  function boot() {
    var root = el("div");
    root.id = "root";
    root.innerHTML =
      '<div id="hero"></div>' +
      '<div id="main"></div>' +
      '<div id="empty-state">' +
      '<div>✦</div>' +
      "<div>Magic dashboard warming up…</div>" +
      '<div style="font-size:11px;">The watcher paints this area as the session works.</div>' +
      "</div>" +
      '<div id="side">' +
      '<div class="card panel open-points"><div class="card-title">Open points</div><div class="card-body" id="open-points-body"></div></div>' +
      '<div class="card panel"><div class="card-title">Decisions</div><div class="card-body" id="decisions-body"></div></div>' +
      "</div>" +
      '<div id="footer">' +
      '<div id="decisions-live" aria-live="assertive"></div>' +
      '<div id="status-strip"><span class="status-dot" id="status-dot"></span><span id="status-text">Connecting…</span>' +
      '<span id="topic-chips" aria-label="Archived topics"></span></div>' +
      "</div>";
    document.body.appendChild(root);

    var overlay = el("div");
    overlay.id = "overlay";
    overlay.innerHTML =
      '<div class="overlay-card">' +
      '<div class="overlay-title"><span class="overlay-title-text"></span>' +
      '<button class="icon-btn overlay-close" aria-label="Close" title="Close">✕</button></div>' +
      '<div class="overlay-body"></div>' +
      "</div>";
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeOverlay();
    });
    overlay.querySelector(".overlay-close").addEventListener("click", closeOverlay);
    document.body.appendChild(overlay);

    post({ type: "ready" });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
