import { describe, it, expect } from "vitest";
import { childrenToPlainText } from "./children-text.js";

describe("childrenToPlainText", () => {
  it("returns an empty string for nullish and boolean nodes", () => {
    expect(childrenToPlainText(null)).toBe("");
    expect(childrenToPlainText(undefined)).toBe("");
    expect(childrenToPlainText(false)).toBe("");
  });

  it("passes through strings and stringifies numbers", () => {
    expect(childrenToPlainText("hello")).toBe("hello");
    expect(childrenToPlainText(42)).toBe("42");
  });

  // ReactMarkdown commonly hands a code renderer an array with one string.
  it("joins array children without a separator", () => {
    expect(childrenToPlainText(["a", "b", "c"])).toBe("abc");
  });

  // Syntax-highlighting plugins nest elements inside <code>; the copy payload
  // must still be the flattened source text.
  it("recurses into element children", () => {
    const el = { props: { children: ["const ", { props: { children: "x" } }, " = 1"] } };
    expect(childrenToPlainText(el)).toBe("const x = 1");
  });

  it("returns an empty string for objects that are not elements", () => {
    expect(childrenToPlainText({ foo: "bar" })).toBe("");
  });
});
