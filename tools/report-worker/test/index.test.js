import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import worker, { issueFrom, MAX_COMMENT, MAX_REPORT } from "../src/index.js";

const ORIGIN = "chrome-extension://abc";
const ENV = { REPORTS_REPO: "printnomad/reports", GITHUB_TOKEN: "secret", ALLOWED_EXTENSION_IDS: "" };
const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

function post(body, { origin = ORIGIN, method = "POST", ip } = {}) {
  const headers = { "content-type": "application/json", ...(origin ? { origin } : {}), ...(ip ? { "cf-connecting-ip": ip } : {}) };
  return new Request("https://reports.example/", { method, headers, body: method === "POST" ? body : undefined });
}

function fakeGitHub(status = 201) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", { status });
  };
  return calls;
}

test("a report becomes an issue in the configured repository", async () => {
  const calls = fakeGitHub();
  const res = await worker.fetch(post(JSON.stringify({ report: "✗ [PN401] x", comment: "hi", code: "PN401", version: "0.1.0" })), ENV);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(calls[0].url, "https://api.github.com/repos/printnomad/reports/issues");
  assert.equal(calls[0].init.headers.authorization, "Bearer secret");
  const issue = JSON.parse(calls[0].init.body);
  assert.equal(issue.title, "[PN401] Tester report from 0.1.0");
  assert.match(issue.body, /hi/);
  assert.match(issue.body, /PN401/);
});

test("the sender's text cannot inject Markdown or a title", () => {
  const issue = issueFrom({ report: "``` @someone [x](http://evil)", comment: "````\n@me", code: "PN401\n# hacked", version: "<img>" });
  assert.equal(issue.title, "[Report] Tester report");
  assert.ok(issue.body.includes("````text\n``` @someone"));   // fence longer than any in the text
  assert.ok(issue.body.includes("`````text\n````\n@me"));
});

test("an optional contact email goes in the body, never in the title", () => {
  const issue = issueFrom({ report: "r", contact: "a@b.co", code: "PN401" });
  assert.ok(!issue.title.includes("a@b.co"));
  assert.match(issue.body, /\*\*Contact\*\*\n\n```text\na@b\.co\n```/);
  assert.ok(!issueFrom({ report: "r" }).body.includes("Contact"));
});

test("only the extension can send", async () => {
  const calls = fakeGitHub();
  const body = JSON.stringify({ report: "x" });
  assert.equal((await worker.fetch(post(body, { origin: "https://evil.example" }), ENV)).status, 403);
  assert.equal((await worker.fetch(post(body, { origin: null }), ENV)).status, 403);
  const onlyOne = { ...ENV, ALLOWED_EXTENSION_IDS: "other, more" };
  assert.equal((await worker.fetch(post(body), onlyOne)).status, 403);
  assert.equal((await worker.fetch(post(body, { origin: "chrome-extension://more" }), onlyOne)).status, 201);
  assert.equal(calls.length, 1);
});

test("the browser's preflight is answered", async () => {
  const res = await worker.fetch(post(null, { method: "OPTIONS" }), ENV);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-headers"), "content-type");
});

for (const [name, body, status] of [
  ["not JSON", "{oops", 400],
  ["no report", JSON.stringify({ comment: "x" }), 400],
  ["empty report", JSON.stringify({ report: "  " }), 400],
  ["long report", JSON.stringify({ report: "x".repeat(MAX_REPORT + 1) }), 400],
  ["long comment", JSON.stringify({ report: "x", comment: "y".repeat(MAX_COMMENT + 1) }), 400],
  ["huge body", "x".repeat(70_000), 413],
  ["contact that is not an email", JSON.stringify({ report: "x", contact: "not an email" }), 400],
  ["contact too long", JSON.stringify({ report: "x", contact: `${"a".repeat(255)}@b.co` }), 400],
]) {
  test(`rejected without calling GitHub: ${name}`, async () => {
    const calls = fakeGitHub();
    assert.equal((await worker.fetch(post(body), ENV)).status, status);
    assert.equal(calls.length, 0);
  });
}

test("the rate limit is per address", async () => {
  const calls = fakeGitHub();
  const keys = [];
  const env = { ...ENV, REPORT_LIMIT: { limit: async ({ key }) => (keys.push(key), { success: false }) } };
  assert.equal((await worker.fetch(post(JSON.stringify({ report: "x" }), { ip: "1.2.3.4" }), env)).status, 429);
  assert.deepEqual(keys, ["1.2.3.4"]);
  assert.equal(calls.length, 0);
});

test("a GitHub failure is reported without its details", async () => {
  fakeGitHub(401);
  const res = await worker.fetch(post(JSON.stringify({ report: "x" })), ENV);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "could not file the report" });
});
