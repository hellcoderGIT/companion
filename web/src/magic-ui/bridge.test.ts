// Tests for the MagicUI bridge pure functions: srcdoc security envelope,
// PermissionRequest → decision-model mapping, and the decision-response →
// permission_response wire translation (must stay byte-compatible with what
// the classic PermissionBanner sends, incl. the keyed-by-question-TEXT
// AskUserQuestion contract).
import { describe, expect, it } from "vitest";
import { buildMagicUiSrcdoc, decisionResponseToWire, isRuntimeMessage, toDecisionModel } from "./bridge.js";
import type { PermissionRequest } from "../types.js";

function perm(overrides: Partial<PermissionRequest>): PermissionRequest {
  return {
    request_id: "req-1",
    tool_name: "Bash",
    input: {},
    tool_use_id: "toolu_1",
    timestamp: 1,
    ...overrides,
  };
}

describe("buildMagicUiSrcdoc", () => {
  it("embeds a no-network CSP and the requested theme", () => {
    const doc = buildMagicUiSrcdoc("dark");
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain('data-theme="dark"');
    // Chart.js + runtime are inlined (no external script tags at all)
    expect(doc).not.toMatch(/<script[^>]+src=/);
  });
});

describe("isRuntimeMessage", () => {
  it("accepts channel-tagged messages and rejects everything else", () => {
    expect(isRuntimeMessage({ channel: "magic-ui", type: "ready" })).toBe(true);
    expect(isRuntimeMessage({ type: "ready" })).toBe(false);
    expect(isRuntimeMessage(null)).toBe(false);
    expect(isRuntimeMessage("ready")).toBe(false);
  });
});

describe("toDecisionModel", () => {
  it("maps AskUserQuestion input to question models", () => {
    const model = toDecisionModel(perm({
      tool_name: "AskUserQuestion",
      input: {
        questions: [
          { question: "Which DB?", options: [{ label: "Postgres", description: "relational" }, { label: "SQLite" }], multiSelect: false },
        ],
      },
    }));
    expect(model.kind).toBe("ask_user_question");
    expect(model.questions).toHaveLength(1);
    expect(model.questions?.[0].question).toBe("Which DB?");
    expect(model.questions?.[0].options.map((o) => o.label)).toEqual(["Postgres", "SQLite"]);
  });

  it("maps ExitPlanMode to a plan-approval model", () => {
    const model = toDecisionModel(perm({ tool_name: "ExitPlanMode", input: { plan: "# The plan" } }));
    expect(model.kind).toBe("exit_plan_mode");
    expect(model.detail).toContain("The plan");
  });

  it("maps tool permissions with labeled suggestions and command detail", () => {
    const model = toDecisionModel(perm({
      tool_name: "Bash",
      input: { command: "rm -rf dist" },
      permission_suggestions: [
        { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf dist" }], behavior: "allow", destination: "session" },
      ],
    }));
    expect(model.kind).toBe("tool");
    expect(model.detail).toContain("$ rm -rf dist");
    expect(model.suggestions).toEqual([{ label: 'Allow "rm -rf dist" for session', index: 0 }]);
  });
});

describe("decisionResponseToWire", () => {
  it("produces a deny identical to the classic banner", () => {
    expect(decisionResponseToWire(perm({}), { action: "deny" })).toEqual({
      type: "permission_response",
      request_id: "req-1",
      behavior: "deny",
      message: "Denied by user",
    });
  });

  it("keys AskUserQuestion answers by question TEXT, index only as fallback", () => {
    const p = perm({
      tool_name: "AskUserQuestion",
      input: { questions: [{ question: "Which DB?", options: [] }, { question: "", options: [] }] },
    });
    const wire = decisionResponseToWire(p, {
      action: "answers",
      answers: [
        { index: 0, question: "Which DB?", answer: "Postgres" },
        { index: 1, question: "", answer: "custom" },
      ],
    });
    expect(wire.behavior).toBe("allow");
    expect(wire.updated_input?.answers).toEqual({ "Which DB?": "Postgres", "1": "custom" });
  });

  it("attaches the chosen permission suggestion on allow", () => {
    const suggestion: import("../types.js").PermissionRequest["permission_suggestions"] extends (infer U)[] | undefined ? U : never = {
      type: "addRules",
      rules: [{ toolName: "Bash" }],
      behavior: "allow",
      destination: "session",
    };
    const p = perm({ permission_suggestions: [suggestion] });
    const wire = decisionResponseToWire(p, { action: "allow", suggestionIndex: 0 });
    expect(wire.updated_permissions).toEqual([suggestion]);
    const plain = decisionResponseToWire(p, { action: "allow" });
    expect(plain.updated_permissions).toBeUndefined();
  });
});
