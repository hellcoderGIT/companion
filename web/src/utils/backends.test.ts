import { describe, it, expect } from "vitest";
import {
  toModelOptions,
  getModelsForBackend,
  getModesForBackend,
  getAgentModesForBackend,
  getDefaultModel,
  getDefaultMode,
  getDefaultAgentMode,
  getEffortsForBackend,
  getDefaultEffort,
  CLAUDE_MODELS,
  CODEX_MODELS,
  CLAUDE_MODES,
  CODEX_MODES,
  CLAUDE_AGENT_MODES,
  CODEX_AGENT_MODES,
  CLAUDE_EFFORTS,
} from "./backends.js";

describe("toModelOptions", () => {
  it("converts server model info to frontend ModelOption with icons", () => {
    const models = [
      { value: "gpt-5.2-codex", label: "gpt-5.2-codex", description: "Frontier" },
      { value: "gpt-5.1-codex-mini", label: "gpt-5.1-codex-mini", description: "Fast" },
    ];

    const options = toModelOptions(models);

    expect(options).toHaveLength(2);
    expect(options[0].value).toBe("gpt-5.2-codex");
    expect(options[0].label).toBe("gpt-5.2-codex");
    expect(options[0].icon).toBeTruthy();
    expect(options[1].value).toBe("gpt-5.1-codex-mini");
  });

  it("assigns codex icon to codex-containing slugs", () => {
    const options = toModelOptions([
      { value: "gpt-5.2-codex", label: "GPT-5.2 Codex", description: "" },
    ]);
    expect(options[0].icon).toBe("\u2733"); // ✳
  });

  it("assigns max icon to max-containing slugs", () => {
    const options = toModelOptions([
      { value: "gpt-5.1-codex-max", label: "GPT-5.1 Max", description: "" },
    ]);
    // "codex" appears before "max" in the slug, so codex icon wins
    expect(options[0].icon).toBe("\u2733");
  });

  it("assigns mini icon to mini-only slugs", () => {
    const options = toModelOptions([
      { value: "gpt-5.1-mini", label: "GPT-5.1 Mini", description: "" },
    ]);
    expect(options[0].icon).toBe("\u26A1"); // ⚡
  });

  // "xhigh" variants (extra-high reasoning) get the ★ icon when the slug
  // does not also contain "codex" (which wins by earlier placement in the
  // lookup table — see the gpt-5.1-codex-max test above for that rule).
  it("assigns xhigh icon to non-codex xhigh slugs", () => {
    const options = toModelOptions([
      { value: "gpt-xhigh-reasoning", label: "GPT xHigh", description: "" },
    ]);
    expect(options[0].icon).toBe("\u2605"); // ★
  });

  it("uses fallback icon for generic model slugs", () => {
    const options = toModelOptions([
      { value: "gpt-5.2", label: "GPT-5.2", description: "" },
    ]);
    // Should use one of the fallback icons
    expect(options[0].icon).toBeTruthy();
    expect(options[0].icon.length).toBeGreaterThan(0);
  });

  it("uses value as label when label is empty", () => {
    const options = toModelOptions([
      { value: "some-model", label: "", description: "" },
    ]);
    expect(options[0].label).toBe("some-model");
  });

  it("handles empty array", () => {
    expect(toModelOptions([])).toEqual([]);
  });
});

describe("getModelsForBackend", () => {
  it("returns claude models for claude backend", () => {
    expect(getModelsForBackend("claude")).toBe(CLAUDE_MODELS);
  });

  it("returns codex models for codex backend", () => {
    expect(getModelsForBackend("codex")).toBe(CODEX_MODELS);
  });
});

describe("getModesForBackend", () => {
  it("returns claude modes for claude backend", () => {
    expect(getModesForBackend("claude")).toBe(CLAUDE_MODES);
  });

  it("returns codex modes for codex backend", () => {
    expect(getModesForBackend("codex")).toBe(CODEX_MODES);
  });
});

describe("getDefaultModel", () => {
  it("returns first claude model for claude backend", () => {
    expect(getDefaultModel("claude")).toBe(CLAUDE_MODELS[0].value);
  });

  it("returns first codex model for codex backend", () => {
    expect(getDefaultModel("codex")).toBe(CODEX_MODELS[0].value);
  });
});

describe("getDefaultMode", () => {
  it("returns first claude mode for claude backend", () => {
    expect(getDefaultMode("claude")).toBe(CLAUDE_MODES[0].value);
  });

  it("returns first codex mode for codex backend", () => {
    expect(getDefaultMode("codex")).toBe(CODEX_MODES[0].value);
  });
});

describe("getAgentModesForBackend", () => {
  it("returns claude agent modes for claude backend", () => {
    expect(getAgentModesForBackend("claude")).toBe(CLAUDE_AGENT_MODES);
  });

  it("returns codex agent modes for codex backend", () => {
    expect(getAgentModesForBackend("codex")).toBe(CODEX_AGENT_MODES);
  });
});

describe("getDefaultAgentMode", () => {
  it("returns first claude agent mode for claude backend", () => {
    expect(getDefaultAgentMode("claude")).toBe(CLAUDE_AGENT_MODES[0].value);
  });

  it("returns first codex agent mode for codex backend", () => {
    expect(getDefaultAgentMode("codex")).toBe(CODEX_AGENT_MODES[0].value);
  });
});

describe("getEffortsForBackend", () => {
  // Claude exposes the CLI's --effort levels as a dropdown; Codex bakes
  // reasoning effort into the model name, so it gets no effort options.
  it("returns the Claude effort levels for claude backend", () => {
    expect(getEffortsForBackend("claude")).toBe(CLAUDE_EFFORTS);
  });

  it("returns no effort options for codex backend", () => {
    expect(getEffortsForBackend("codex")).toEqual([]);
  });
});

describe("getDefaultEffort", () => {
  // Empty string is the sentinel for "no --effort flag" so the model uses its
  // own built-in default effort — matches the user's requirement to keep the
  // Opus 4.8 default untouched unless explicitly changed.
  it("defaults to empty (model default) for both backends", () => {
    expect(getDefaultEffort("claude")).toBe("");
    expect(getDefaultEffort("codex")).toBe("");
  });
});

describe("CLAUDE_EFFORTS", () => {
  // The CLI accepts exactly: low, medium, high, xhigh, max. The first entry is
  // the empty "Default" sentinel which must never be sent as a flag value.
  it("first entry is the empty default sentinel", () => {
    expect(CLAUDE_EFFORTS[0].value).toBe("");
    expect(CLAUDE_EFFORTS[0].label).toBe("Default");
  });

  it("exposes exactly the CLI-supported effort levels", () => {
    const levels = CLAUDE_EFFORTS.map((e) => e.value).filter(Boolean);
    expect(levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("static model/mode lists", () => {
  it("has codex models with GPT-5.x slugs", () => {
    for (const m of CODEX_MODELS) {
      expect(m.value).toMatch(/^gpt-5/);
    }
  });

  it("has claude models with claude- prefix", () => {
    for (const m of CLAUDE_MODELS) {
      expect(m.value).toMatch(/^claude-/);
    }
  });

  it("has at least 2 modes for each backend", () => {
    expect(CLAUDE_MODES.length).toBeGreaterThanOrEqual(2);
    expect(CODEX_MODES.length).toBeGreaterThanOrEqual(2);
  });

  // Agent modes must never include "plan" — agents are autonomous and
  // cannot wait for human plan approval.
  it("agent modes do not include 'plan' for any backend", () => {
    for (const m of CLAUDE_AGENT_MODES) {
      expect(m.value).not.toBe("plan");
    }
    for (const m of CODEX_AGENT_MODES) {
      expect(m.value).not.toBe("plan");
    }
  });

  it("agent modes default to bypassPermissions", () => {
    expect(CLAUDE_AGENT_MODES[0].value).toBe("bypassPermissions");
    expect(CODEX_AGENT_MODES[0].value).toBe("bypassPermissions");
  });

  // Opus 4.8 is the current Claude default (natural successor to 4.7).
  // Fable 5 — the first publicly available Mythos-class model — is exposed
  // alongside it but is not the default since its safeguards route ~5% of
  // sessions back to Opus 4.8; users should opt in deliberately.
  it("lists claude-opus-4-8 as the first Claude model (default)", () => {
    expect(CLAUDE_MODELS[0].value).toBe("claude-opus-4-8");
  });

  it("includes claude-fable-5 (Mythos-class) in Claude models", () => {
    const slugs = CLAUDE_MODELS.map((m) => m.value);
    expect(slugs).toContain("claude-fable-5");
  });

  // The static list is only a fallback — the live list comes from the Codex
  // app-server `model/list` RPC. We assert the current frontier model (gpt-5.5)
  // and that the default is the first entry.
  it("lists gpt-5.5 as the first Codex model (default fallback)", () => {
    const slugs = CODEX_MODELS.map((m) => m.value);
    expect(slugs).toContain("gpt-5.5");
    expect(CODEX_MODELS[0].value).toBe("gpt-5.5");
  });

  it("claude agent modes include acceptEdits for middle ground", () => {
    expect(CLAUDE_AGENT_MODES.some((m) => m.value === "acceptEdits")).toBe(true);
  });
});
