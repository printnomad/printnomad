import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_REPORT, reportPayload, sendReport } from "../src/lib/report-send.ts";

test("a long report is cut to what the service accepts, and an empty comment is left out", () => {
  const payload = reportPayload({ report: "x".repeat(MAX_REPORT + 50), comment: "  ", version: "1" });
  assert.equal(payload.report.length, MAX_REPORT);
  assert.ok(payload.report.endsWith("(truncated)"));
  assert.equal(payload.comment, undefined);
});

test("the report is posted as JSON", async () => {
  const calls: [string, RequestInit][] = [];
  await sendReport("https://r.example", { report: "r", comment: " c ", code: "PN102", version: "1" },
    (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(null, { status: 201 });
    }) as typeof fetch);
  assert.equal(calls[0][0], "https://r.example");
  assert.deepEqual(JSON.parse(calls[0][1].body as string), { report: "r", comment: "c", code: "PN102", version: "1" });
});

test("a refused report rejects, so the user can copy it instead", async () => {
  await assert.rejects(sendReport("https://r.example", { report: "r", version: "1" },
    (async () => new Response(null, { status: 429 })) as typeof fetch), /429/);
});
