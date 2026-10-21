// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";

// The hook/fetcher sit between the pickers and GET /backends/:id/models.
// api is mocked so each test controls what the server "returns".
const mockGetBackendModels = vi.hoisted(() => vi.fn());
vi.mock("../api.js", () => ({ api: { getBackendModels: mockGetBackendModels } }));

import { fetchBackendModelOptions, useBackendModels } from "./use-backend-models.js";
import { CLAUDE_MODELS, CODEX_MODELS } from "./backends.js";

beforeEach(() => {
  mockGetBackendModels.mockReset();
});

describe("fetchBackendModelOptions", () => {
  it("converts the live list to picker options", async () => {
    mockGetBackendModels.mockResolvedValue([{ value: "claude-new-1", label: "New 1", description: "", efforts: ["low"] }]);
    expect(await fetchBackendModelOptions("claude")).toEqual([
      { value: "claude-new-1", label: "New 1", icon: "", efforts: ["low"] },
    ]);
    expect(mockGetBackendModels).toHaveBeenCalledWith("claude");
  });

  // Every failure mode resolves to null (→ static fallback) and never rejects,
  // including a synchronous throw / undefined return from the api layer.
  it("resolves null on empty list, rejection, or a non-promise return", async () => {
    mockGetBackendModels.mockResolvedValue([]);
    expect(await fetchBackendModelOptions("claude")).toBeNull();
    mockGetBackendModels.mockRejectedValue(new Error("404"));
    expect(await fetchBackendModelOptions("claude")).toBeNull();
    mockGetBackendModels.mockReturnValue(undefined);
    expect(await fetchBackendModelOptions("codex")).toBeNull();
    mockGetBackendModels.mockImplementation(() => { throw new Error("sync"); });
    expect(await fetchBackendModelOptions("codex")).toBeNull();
  });
});

describe("useBackendModels", () => {
  // Renders the static list immediately (no loading gap), then swaps in the
  // live list once it arrives.
  it("returns the static fallback first, then the live list", async () => {
    mockGetBackendModels.mockResolvedValue([{ value: "claude-new-1", label: "New 1", description: "" }]);
    const { result } = renderHook(() => useBackendModels("claude"));
    expect(result.current).toBe(CLAUDE_MODELS);
    await waitFor(() => expect(result.current.map((m) => m.value)).toEqual(["claude-new-1"]));
  });

  it("keeps the static list when the live fetch fails", async () => {
    mockGetBackendModels.mockRejectedValue(new Error("404"));
    const { result } = renderHook(() => useBackendModels("codex"));
    await waitFor(() => expect(mockGetBackendModels).toHaveBeenCalled());
    expect(result.current).toBe(CODEX_MODELS);
  });

  // Switching backend must not show the previous backend's live list while
  // the new one is loading.
  it("falls back to the new backend's static list on backend switch", async () => {
    mockGetBackendModels.mockImplementation(async (b: string) =>
      b === "claude" ? [{ value: "claude-new-1", label: "New 1", description: "" }] : new Promise(() => {}));
    const { result, rerender } = renderHook(({ b }) => useBackendModels(b), { initialProps: { b: "claude" as "claude" | "codex" } });
    await waitFor(() => expect(result.current[0].value).toBe("claude-new-1"));
    rerender({ b: "codex" });
    expect(result.current).toBe(CODEX_MODELS);
  });
});
