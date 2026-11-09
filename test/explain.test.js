import test from "node:test";
import assert from "node:assert/strict";
import { explain } from "../src/explain.js";

test("200 is a success", () => {
  const r = explain({ status: 200 });
  assert.equal(r.tone, "ok");
  assert.equal(r.label, "Worked");
});

test("500 is a server error", () => {
  const r = explain({ status: 500 });
  assert.equal(r.tone, "fail");
  assert.equal(r.label, "Server error");
});

test("timeout is recognised from the flag", () => {
  const r = explain({ timedOut: true, error: "Timeout of 2000 ms reached." });
  assert.equal(r.label, "Timed out");
});

test("unknown host is explained", () => {
  const r = explain({ error: "Could not resolve hostname" });
  assert.equal(r.label, "Cannot find server");
});

test("connection refused on localhost adds the localhost hint", () => {
  const r = explain({ error: "Couldn't connect to server", url: "http://localhost:3000/hook" });
  assert.equal(r.label, "Connection refused");
  assert.match(r.text, /localhost/);
});

test("no localhost hint for a normal address", () => {
  const r = explain({ error: "Couldn't connect to server", url: "https://example.com/hook" });
  assert.doesNotMatch(r.text, /localhost/);
});

test("missing reply is reported as such", () => {
  const r = explain({ hasResponse: false });
  assert.equal(r.label, "No reply saved");
});

test("unknown error text is passed through", () => {
  const r = explain({ error: "something odd" });
  assert.equal(r.label, "Could not send");
  assert.match(r.text, /something odd/);
});

test("common client errors have plain labels", () => {
  assert.equal(explain({ status: 401 }).label, "Not logged in");
  assert.equal(explain({ status: 404 }).label, "Address not found");
  assert.equal(explain({ status: 429 }).label, "Too many requests");
  assert.equal(explain({ status: 418 }).label, "Rejected (418)");
});