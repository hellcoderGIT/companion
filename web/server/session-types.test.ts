import { describe, it, expect } from "vitest";
import { isAuthErrorResult, looksLikeAuthErrorText, AUTH_EXPIRED_MESSAGE } from "./session-types.js";

// These guard the auth-failure detection shared by the server (skip auto-relaunch
// + surface a re-login banner) and the client (error bubble). The key edge case
// is that the CLI reports auth failures with is_error:true but an EMPTY errors[]
// array — the human text lives in `result` / `api_error_status`.
describe("isAuthErrorResult", () => {
  it("detects a 401 via api_error_status even when result text is absent", () => {
    expect(isAuthErrorResult({ is_error: true, api_error_status: 401 })).toBe(true);
  });

  it("detects a 403 via api_error_status", () => {
    expect(isAuthErrorResult({ is_error: true, api_error_status: 403 })).toBe(true);
  });

  it("detects the real CLI auth message via result text (no errors[], no status)", () => {
    expect(
      isAuthErrorResult({
        is_error: true,
        result: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      }),
    ).toBe(true);
  });

  it("detects 'please run /login' guidance", () => {
    expect(
      isAuthErrorResult({ is_error: true, result: "Session ended. Please run /login to continue." }),
    ).toBe(true);
  });

  it("detects an expired-credentials phrase in errors[]", () => {
    expect(
      isAuthErrorResult({ is_error: true, errors: ["oauth token expired, please re-authenticate"] }),
    ).toBe(true);
  });

  it("is false when is_error is not set, even with a 401 status", () => {
    // A non-error result should never be treated as an auth failure.
    expect(isAuthErrorResult({ is_error: false, api_error_status: 401 })).toBe(false);
  });

  it("is false for an ordinary (non-auth) error", () => {
    expect(
      isAuthErrorResult({ is_error: true, result: "Tool execution failed: ENOENT" }),
    ).toBe(false);
  });

  it("does not misfire on a 4011 substring (word-boundary guarded)", () => {
    // Ensure the \b401\b match doesn't fire on numbers that merely contain 401.
    expect(isAuthErrorResult({ is_error: true, result: "processed 4011 records" })).toBe(false);
  });

  it("exposes user-facing re-login guidance", () => {
    expect(AUTH_EXPIRED_MESSAGE).toMatch(/claude login/i);
  });

  // Regression: a bare 401/403/"unauthorized" appearing in unrelated error text
  // must NOT be read as an auth failure. Misclassifying a recoverable crash as
  // auth suppresses auto-relaunch and leaves the session dead — a new hang.
  // These mirror real CLI stderr/result noise (stack-trace line numbers, tool
  // exit codes, file-permission messages).
  it.each([
    "TypeError: at Object.<anonymous> (/app/dist/index.js:403:15)",
    "test failed at line 401",
    "The command exited with code 401",
    "unauthorized to delete this file",
    "RangeError [ERR_OUT_OF_RANGE]: offset 403 is out of range",
    "processed 4011 records",
  ])("does NOT classify non-auth text as auth: %s", (text) => {
    expect(looksLikeAuthErrorText(text)).toBe(false);
    expect(isAuthErrorResult({ is_error: true, result: text })).toBe(false);
  });

  // ...but a status code paired with the auth word, or an explicit auth phrase,
  // is still recognized.
  it.each([
    "API Error: 401 Unauthorized",
    "403 Forbidden",
    "Invalid authentication credentials",
    "Please run /login",
    "oauth token expired",
  ])("still classifies genuine auth text as auth: %s", (text) => {
    expect(looksLikeAuthErrorText(text)).toBe(true);
  });
});
