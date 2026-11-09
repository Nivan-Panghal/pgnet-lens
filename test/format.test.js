import test from "node:test";
import assert from "node:assert/strict";
import { redactHeaders, redactUrl, isLocalUrl, truncate, renderTable } from "../src/format.js";

test("secret headers are hidden, others kept", () => {
  const out = redactHeaders({
    Authorization: "Bearer abc",
    "X-Api-Key": "k",
    apikey: "k2",
    Cookie: "a=b",
    "Content-Type": "application/json",
  });
  assert.equal(out.Authorization, "[hidden]");
  assert.equal(out["X-Api-Key"], "[hidden]");
  assert.equal(out.apikey, "[hidden]");
  assert.equal(out.Cookie, "[hidden]");
  assert.equal(out["Content-Type"], "application/json");
});

test("redactHeaders tolerates null and non-objects", () => {
  assert.equal(redactHeaders(null), null);
  assert.equal(redactHeaders(undefined), null);
});

test("secrets in web addresses are hidden", () => {
  const out = redactUrl("https://user:pw@example.com/hook?token=abc&page=2");
  assert.ok(!out.includes("abc"));
  assert.ok(!out.includes(":pw@"));
  assert.ok(out.includes("page=2"));
});

test("redactUrl leaves non-URLs alone", () => {
  assert.equal(redactUrl("not a url"), "not a url");
  assert.equal(redactUrl(null), null);
});

test("local addresses are detected", () => {
  assert.equal(isLocalUrl("http://localhost:3000/x"), true);
  assert.equal(isLocalUrl("http://127.0.0.1/x"), true);
  assert.equal(isLocalUrl("http://host.docker.internal:8000"), true);
  assert.equal(isLocalUrl("https://example.com"), false);
  assert.equal(isLocalUrl("nonsense"), false);
});

test("truncate cuts long text", () => {
  assert.equal(truncate("abcdef", 4), "abc…");
  assert.equal(truncate("abc", 4), "abc");
});

test("renderTable lines up columns", () => {
  const text = renderTable([{ a: "1", b: "long value" }], [
    { key: "a", title: "A", max: 5 },
    { key: "b", title: "B", max: 5 },
  ]);
  assert.match(text, /A\s+B/);
  assert.match(text, /long…/);
});

test("CORS headers are not mistaken for secrets", () => {
  const out = redactHeaders({
    "access-control-allow-credentials": "true",
    "Set-Cookie": "a=b",
  });
  assert.equal(out["access-control-allow-credentials"], "true");
  assert.equal(out["Set-Cookie"], "[hidden]");
});