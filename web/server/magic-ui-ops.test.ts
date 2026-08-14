// Tests for MagicUI op parsing, validation/sanitization and state reduction.
//
// The watcher model's output is untrusted: these tests pin down that
// (a) replies parse leniently (fenced/bare/prose-wrapped JSON) but fail
//     closed on garbage,
// (b) HTML is sanitized to an inert allowlist (no scripts, handlers,
//     inline styles or URLs — the iframe sandbox is the second layer),
// (c) budgets (ops/slots/log lengths) are enforced in the reducer, and
// (d) reduction is pure, version-bumping, and never mutates its input.
import { describe, expect, it } from "vitest";
import {
  appendDecision,
  applyOps,
  makeDecisionEntry,
  parseMagicUiReply,
  sanitizeMagicHtml,
  validateOps,
} from "./magic-ui-ops.js";
import {
  MAGIC_UI_MAX_DECISIONS,
  MAGIC_UI_MAX_OPS_PER_TURN,
  MAGIC_UI_MAX_SLOTS,
  emptyMagicUiState,
  type MagicUiOp,
} from "./magic-ui-types.js";

const NOW = 1_750_000_000_000;

describe("parseMagicUiReply", () => {
  it("parses a fenced json block", () => {
    const reply = 'Here you go:\n```json\n[{"op":"remove_slot","slot":"a"}]\n```';
    expect(parseMagicUiReply(reply)).toEqual([{ op: "remove_slot", slot: "a" }]);
  });

  it("parses a bare JSON array", () => {
    expect(parseMagicUiReply('[{"op":"remove_slot","slot":"a"}]')).toEqual([
      { op: "remove_slot", slot: "a" },
    ]);
  });

  it("recovers an array embedded in prose", () => {
    expect(parseMagicUiReply('sure! [{"op":"remove_slot","slot":"a"}] done')).toEqual([
      { op: "remove_slot", slot: "a" },
    ]);
  });

  it("returns [] for an empty reply (nothing to do)", () => {
    expect(parseMagicUiReply("   ")).toEqual([]);
  });

  it("returns null for unparseable replies", () => {
    expect(parseMagicUiReply("no ops here")).toBeNull();
    expect(parseMagicUiReply('[{"op": broken]')).toBeNull();
    expect(parseMagicUiReply('{"op":"set_slot"}')).toBeNull();
  });
});

describe("sanitizeMagicHtml", () => {
  it("strips script tags and event handlers", () => {
    const dirty = '<div onclick="evil()"><script>alert(1)</script><p>ok</p></div>';
    const clean = sanitizeMagicHtml(dirty);
    expect(clean).not.toContain("script");
    expect(clean).not.toContain("onclick");
    expect(clean).toContain("<p>ok</p>");
  });

  it("strips inline styles, links and images", () => {
    const dirty = '<p style="position:fixed">x</p><a href="javascript:evil()">y</a><img src="http://x/t.png">';
    const clean = sanitizeMagicHtml(dirty);
    expect(clean).not.toContain("style=");
    expect(clean).not.toContain("href");
    expect(clean).not.toContain("img");
  });

  it("keeps allowlisted structure with classes", () => {
    const html = '<div class="stat-grid"><h3>Files</h3><ul><li>a.ts</li></ul></div>';
    expect(sanitizeMagicHtml(html)).toBe(html);
  });
});

describe("validateOps", () => {
  it("drops unknown and malformed ops, keeps valid ones", () => {
    const ops = validateOps([
      { op: "hack_the_planet" },
      { op: "set_slot" }, // missing fields
      { op: "set_slot", slot: "progress", html: "<p>hi</p>" },
      null,
      42,
    ]);
    expect(ops).toEqual([
      { op: "set_slot", slot: "progress", html: "<p>hi</p>", title: undefined, area: undefined, span: undefined },
    ]);
  });

  it("sanitizes set_slot html", () => {
    const ops = validateOps([
      { op: "set_slot", slot: "x", html: '<script>a</script><b onmouseover="p()">t</b>' },
    ]);
    expect(ops).toHaveLength(1);
    const op = ops[0] as Extract<MagicUiOp, { op: "set_slot" }>;
    expect(op.html).toBe("<b>t</b>");
  });

  it("drops a set_slot whose html sanitizes to nothing", () => {
    expect(validateOps([{ op: "set_slot", slot: "x", html: "<script>a</script>" }])).toEqual([]);
  });

  it("caps the number of ops per turn", () => {
    const raw = Array.from({ length: MAGIC_UI_MAX_OPS_PER_TURN + 10 }, (_, i) => ({
      op: "remove_slot",
      slot: `s${i}`,
    }));
    expect(validateOps(raw)).toHaveLength(MAGIC_UI_MAX_OPS_PER_TURN);
  });

  it("validates chart specs and drops non-numeric data", () => {
    const ops = validateOps([
      { op: "chart", slot: "c", spec: { kind: "bar", series: [{ label: "tests", data: [1, "x", 3] }] } },
      { op: "chart", slot: "bad", spec: { kind: "pie3d", series: [{ label: "a", data: [1] }] } },
      { op: "chart", slot: "bad2", spec: { kind: "bar", series: [] } },
    ]);
    expect(ops).toHaveLength(1);
    const chart = ops[0] as Extract<MagicUiOp, { op: "chart" }>;
    expect(chart.spec.series[0].data).toEqual([1, 3]);
  });

  it("normalizes open_item kinds and validates snippet/stat/decision ops", () => {
    const ops = validateOps([
      { op: "open_item", id: "run-tests", text: "Run the migration script", kind: "weird" },
      { op: "resolve_item", id: "run-tests" },
      { op: "snippet", slot: "s", title: "Migrate DB", code: "bun run migrate", language: "bash" },
      { op: "stat", slot: "t", label: "Tests", value: "34 pass", trend: "up" },
      { op: "decision_log", title: "Chose approach B", detail: "Simpler rollback path" },
      { op: "session_summary", text: "We did things." },
    ]);
    expect(ops.map((o) => o.op)).toEqual([
      "open_item", "resolve_item", "snippet", "stat", "decision_log", "session_summary",
    ]);
    expect((ops[0] as Extract<MagicUiOp, { op: "open_item" }>).kind).toBe("action");
  });
});

describe("applyOps", () => {
  it("sets slots, bumps version, and does not mutate the input state", () => {
    const state = emptyMagicUiState(NOW);
    const ops = validateOps([
      { op: "set_slot", slot: "hero", html: "<p>Working on auth</p>", area: "hero" },
      { op: "stat", slot: "tests", label: "Tests", value: "34", area: "side" },
    ]);
    const next = applyOps(state, ops, NOW + 1);
    expect(next.version).toBe(1);
    expect(next.slots.hero?.html).toBe("<p>Working on auth</p>");
    expect(next.slots.tests?.stat?.value).toBe("34");
    expect(next.layout).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slot: "hero", area: "hero" }),
        expect.objectContaining({ slot: "tests", area: "side" }),
      ]),
    );
    // Purity: original untouched
    expect(state.version).toBe(0);
    expect(Object.keys(state.slots)).toHaveLength(0);
  });

  it("removes slots together with their layout entries", () => {
    let state = applyOps(
      emptyMagicUiState(NOW),
      validateOps([{ op: "set_slot", slot: "a", html: "<p>x</p>", area: "main" }]),
      NOW,
    );
    state = applyOps(state, validateOps([{ op: "remove_slot", slot: "a" }]), NOW + 1);
    expect(state.slots.a).toBeUndefined();
    expect(state.layout.find((l) => l.slot === "a")).toBeUndefined();
    expect(state.version).toBe(2);
  });

  it("adds, dedupes and resolves open items", () => {
    let state = applyOps(
      emptyMagicUiState(NOW),
      validateOps([
        { op: "open_item", id: "q1", text: "Which DB?", kind: "question" },
        { op: "open_item", id: "a1", text: "Run bun run migrate", kind: "action" },
      ]),
      NOW,
    );
    expect(state.openItems.map((i) => i.id)).toEqual(["a1", "q1"]);
    // Re-adding the same id replaces it instead of duplicating
    state = applyOps(state, validateOps([{ op: "open_item", id: "q1", text: "Which DB? (updated)", kind: "question" }]), NOW + 1);
    expect(state.openItems.filter((i) => i.id === "q1")).toHaveLength(1);
    expect(state.openItems.find((i) => i.id === "q1")?.text).toContain("updated");
    state = applyOps(state, validateOps([{ op: "resolve_item", id: "q1" }]), NOW + 2);
    expect(state.openItems.map((i) => i.id)).toEqual(["a1"]);
  });

  it("caps the decision log", () => {
    let state = emptyMagicUiState(NOW);
    for (let i = 0; i < MAGIC_UI_MAX_DECISIONS + 5; i++) {
      state = applyOps(state, validateOps([{ op: "decision_log", title: `d${i}`, detail: "x" }]), NOW + i);
    }
    expect(state.decisionLog).toHaveLength(MAGIC_UI_MAX_DECISIONS);
    // Newest first
    expect(state.decisionLog[0].title).toBe(`d${MAGIC_UI_MAX_DECISIONS + 4}`);
  });

  it("evicts the oldest slots beyond the slot budget", () => {
    let state = emptyMagicUiState(NOW);
    for (let i = 0; i < MAGIC_UI_MAX_SLOTS + 3; i++) {
      state = applyOps(state, validateOps([{ op: "set_slot", slot: `s${i}`, html: `<p>${i}</p>` }]), NOW + i);
    }
    expect(Object.keys(state.slots)).toHaveLength(MAGIC_UI_MAX_SLOTS);
    expect(state.slots.s0).toBeUndefined();
    expect(state.slots[`s${MAGIC_UI_MAX_SLOTS + 2}`]).toBeDefined();
  });

  it("stores the session summary without rendering slots", () => {
    const state = applyOps(
      emptyMagicUiState(NOW),
      validateOps([{ op: "session_summary", text: "Auth refactor session." }]),
      NOW,
    );
    expect(state.sessionSummary).toBe("Auth refactor session.");
    expect(Object.keys(state.slots)).toHaveLength(0);
  });
});

describe("new_topic (subject change)", () => {
  it("archives the whole current board and clears it for the new subject", () => {
    let state = applyOps(
      emptyMagicUiState(NOW),
      validateOps([
        { op: "set_slot", slot: "cpu", html: "<p>CPU 2%</p>", area: "hero" },
        { op: "chart", slot: "load", spec: { kind: "line", series: [{ label: "load", data: [1, 2] }] } },
      ]),
      NOW,
    );
    state = { ...state, currentTopicTitle: "Server health" };

    state = applyOps(state, validateOps([
      { op: "new_topic", title: "Project overview" },
      { op: "set_slot", slot: "projects", html: "<p>84 commits</p>", area: "hero" },
    ]), NOW + 10);

    // Old board is gone from the visible slots...
    expect(state.slots.cpu).toBeUndefined();
    expect(state.slots.load).toBeUndefined();
    expect(state.slots.projects).toBeDefined();
    expect(state.currentTopicTitle).toBe("Project overview");
    // ...and preserved as an archived topic under the PREVIOUS title.
    expect(state.topics).toHaveLength(1);
    expect(state.topics[0].title).toBe("Server health");
    expect(state.topics[0].slots.cpu?.html).toContain("CPU 2%");
    expect(state.topics[0].slots.load?.chart?.kind).toBe("line");
    expect(state.topics[0].layout.length).toBeGreaterThan(0);
  });

  it("does not archive an empty board, just retitles", () => {
    const state = applyOps(
      emptyMagicUiState(NOW),
      validateOps([{ op: "new_topic", title: "First subject" }]),
      NOW,
    );
    expect(state.topics).toHaveLength(0);
    expect(state.currentTopicTitle).toBe("First subject");
  });

  it("caps archived topics at the retention limit", () => {
    let state = emptyMagicUiState(NOW);
    for (let i = 0; i < 12; i++) {
      state = applyOps(state, validateOps([
        { op: "set_slot", slot: `s${i}`, html: `<p>${i}</p>` },
        { op: "new_topic", title: `topic-${i}` },
      ]), NOW + i);
    }
    // set_slot runs before new_topic in each batch, so every round archives.
    expect(state.topics.length).toBeLessThanOrEqual(8);
    // Newest first
    expect(state.topics[0].slots[`s11`]).toBeDefined();
  });

  it("rejects a new_topic without a title", () => {
    expect(validateOps([{ op: "new_topic" }, { op: "new_topic", title: "" }])).toEqual([]);
  });
});

describe("appendDecision", () => {
  it("prepends server-generated entries and bumps the version", () => {
    const state = emptyMagicUiState(NOW);
    const entry = makeDecisionEntry("user", "Bash", "Allowed: rm -rf dist", NOW + 5, "allow");
    const next = appendDecision(state, entry);
    expect(next.decisionLog[0]).toMatchObject({
      source: "user",
      title: "Bash",
      behavior: "allow",
    });
    expect(next.version).toBe(1);
    expect(state.decisionLog).toHaveLength(0);
  });
});
