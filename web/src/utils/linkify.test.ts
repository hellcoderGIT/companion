import { describe, it, expect } from "vitest";
import { linkify, hasLink } from "./linkify.js";

describe("linkify", () => {
  it("returns an empty array for empty input", () => {
    expect(linkify("")).toEqual([]);
  });

  it("returns a single text segment when there is no URL", () => {
    expect(linkify("npm run dev")).toEqual([{ type: "text", value: "npm run dev" }]);
  });

  // The motivating case: an inline code span that is nothing but a PR URL.
  it("turns a bare URL into a single link segment", () => {
    const url = "https://bitbucket.example.local/projects/MCDEV/repos/defaultcollection/pull-requests/6517";
    expect(linkify(url)).toEqual([{ type: "link", value: url, href: url }]);
  });

  it("splits surrounding prose from the URL", () => {
    expect(linkify("see https://example.com now")).toEqual([
      { type: "text", value: "see " },
      { type: "link", value: "https://example.com", href: "https://example.com" },
      { type: "text", value: " now" },
    ]);
  });

  it("finds multiple URLs in one string", () => {
    const segs = linkify("https://a.example https://b.example");
    expect(segs.filter((s) => s.type === "link").map((s) => s.value)).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  // Sentence punctuation abutting a URL belongs to the prose, not the href —
  // otherwise the trailing period 404s.
  it("does not swallow trailing sentence punctuation", () => {
    expect(linkify("open https://example.com/a.")).toEqual([
      { type: "text", value: "open " },
      { type: "link", value: "https://example.com/a", href: "https://example.com/a" },
      { type: "text", value: "." },
    ]);
  });

  // ...but a paren the URL itself opened must survive (wiki-style links).
  it("keeps balanced closing parens inside the URL", () => {
    const url = "https://en.wikipedia.org/wiki/Foo_(bar)";
    expect(linkify(url)).toEqual([{ type: "link", value: url, href: url }]);
  });

  it("gives back an unbalanced closing paren", () => {
    expect(linkify("(https://example.com)")).toEqual([
      { type: "text", value: "(" },
      { type: "link", value: "https://example.com", href: "https://example.com" },
      { type: "text", value: ")" },
    ]);
  });

  it("supports http as well as https", () => {
    expect(linkify("http://localhost:3456/api")[0]).toMatchObject({ type: "link" });
  });

  // Deliberately conservative: host-shaped strings without a scheme are far
  // more likely to be filenames or package names inside inline code.
  it("ignores scheme-less host-like text", () => {
    expect(linkify("package.json and www.example.com")).toEqual([
      { type: "text", value: "package.json and www.example.com" },
    ]);
  });

  // A scheme with no host is not linkable; it must survive as plain text
  // rather than becoming an empty anchor.
  it("treats a bare scheme as text", () => {
    expect(linkify("https://")).toEqual([{ type: "text", value: "https://" }]);
  });

  it("preserves the original string when segments are concatenated", () => {
    const input = "a https://x.example/y, b (https://z.example) c";
    expect(linkify(input).map((s) => s.value).join("")).toBe(input);
  });

  // The regex is module-level with the /g flag, so a stale lastIndex would make
  // the second call skip matches. This guards that reset.
  it("is stable across repeated calls", () => {
    const input = "https://example.com/one";
    expect(linkify(input)).toEqual(linkify(input));
  });
});

describe("hasLink", () => {
  it("detects a URL", () => {
    expect(hasLink("go to https://example.com")).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(hasLink("just some words")).toBe(false);
  });
});
