import { describe, it, expect } from "vitest";
import { parseCodexModelList } from "./codex-models.js";

// These tests validate the pure parsing of the Codex app-server `model/list`
// RPC payload into the UI's { value, label, description } model-option shape.
// The payload fixtures mirror the real shape emitted by `codex app-server`
// (id/displayName/description/hidden/isDefault), captured from codex 0.142.x.
describe("parseCodexModelList", () => {
  it("maps id/displayName/description and floats the default model first", () => {
    const result = {
      data: [
        { id: "gpt-5.3-codex", displayName: "gpt-5.3-codex", description: "Codex model", hidden: false },
        { id: "gpt-5.5", displayName: "GPT-5.5", description: "Frontier model", hidden: false, isDefault: true },
      ],
    };

    const models = parseCodexModelList(result);

    // gpt-5.5 is the default and must be first so getDefaultModel() picks it.
    expect(models).toEqual([
      { value: "gpt-5.5", label: "GPT-5.5", description: "Frontier model", isDefault: true },
      { value: "gpt-5.3-codex", label: "gpt-5.3-codex", description: "Codex model", isDefault: false },
    ]);
  });

  it("filters out hidden models", () => {
    const result = {
      data: [
        { id: "gpt-5.5", displayName: "GPT-5.5", hidden: false },
        { id: "gpt-5-legacy", displayName: "Legacy", hidden: true },
      ],
    };

    const models = parseCodexModelList(result);

    expect(models.map((m) => m.value)).toEqual(["gpt-5.5"]);
  });

  it("falls back to id for label and empty string for missing description", () => {
    const result = { data: [{ id: "gpt-5.5" }] };

    const models = parseCodexModelList(result);

    expect(models[0]).toEqual({ value: "gpt-5.5", label: "gpt-5.5", description: "", isDefault: false });
  });

  it("uses `model` when `id` is absent", () => {
    const result = { data: [{ model: "gpt-5.4-mini", displayName: "GPT-5.4 Mini" }] };

    const models = parseCodexModelList(result);

    expect(models[0].value).toBe("gpt-5.4-mini");
  });

  it("skips entries without an id or model slug", () => {
    const result = { data: [{ displayName: "Nameless" }, { id: "gpt-5.5" }] };

    const models = parseCodexModelList(result);

    expect(models.map((m) => m.value)).toEqual(["gpt-5.5"]);
  });

  it("returns an empty array for malformed or missing payloads", () => {
    expect(parseCodexModelList(undefined)).toEqual([]);
    expect(parseCodexModelList(null)).toEqual([]);
    expect(parseCodexModelList({})).toEqual([]);
    expect(parseCodexModelList({ data: "not-an-array" })).toEqual([]);
    expect(parseCodexModelList({ data: [null, 42, "x"] })).toEqual([]);
  });
});
