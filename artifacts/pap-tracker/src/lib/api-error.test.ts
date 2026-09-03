import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, ResponseParseError } from "@workspace/api-client-react";
import { getApiErrorCode, getErrorMessage, isUnauthorizedError } from "./api-error";

const request = { method: "GET", url: "/api/identity-groups/8/members/14/skill-plans" };

test("HTML server errors are not displayed as source code", () => {
  for (const status of [500, 502, 503]) {
    const error = new ApiError(new Response(null, { status }), "<!DOCTYPE html><html><body>Internal Server Error</body></html>", request);
    assert.doesNotMatch(getErrorMessage(error), /DOCTYPE|<html>|<body>/);
    assert.match(getErrorMessage(error), new RegExp(`HTTP ${status}`));
  }
});

test("response parse errors show a safe retry message", () => {
  const error = new ResponseParseError(new Response(), "<html>error</html>", new SyntaxError(), request);
  assert.doesNotMatch(getErrorMessage(error), /<html>|VITE_API_URL/);
  assert.match(getErrorMessage(error), /重试/);
});

test("structured authorization errors preserve their code without treating the admin as logged out", () => {
  const error = new ApiError(new Response(null, { status: 409 }), {
    error: "请成员本人重新授权，无需解绑角色", code: "SKILL_AUTHORIZATION_REQUIRED",
  }, request);
  assert.equal(getApiErrorCode(error), "SKILL_AUTHORIZATION_REQUIRED");
  assert.match(getErrorMessage(error), /请成员本人重新授权/);
  assert.equal(isUnauthorizedError(error), false);
});

test("normal JSON validation errors and login-required detection are unchanged", () => {
  const error = new ApiError(new Response(null, { status: 400 }), { error: "Invalid identity group" }, request);
  assert.equal(getErrorMessage(error), error.message);
  assert.equal(getApiErrorCode(error), undefined);
  assert.equal(getApiErrorCode(new Error("network")), undefined);
  assert.equal(isUnauthorizedError(new ApiError(new Response(null, { status: 401 }), null, request)), true);
});
