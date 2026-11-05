// Receives a report from the extension and files it as an issue in a private repository, so
// testers report with one click and without an account or an email address.
//
// The token lives here as a secret (GITHUB_TOKEN), never in the extension. Nothing is logged
// and the sender's IP is used only for the rate limit: it does not reach the issue. The contact
// email is optional and goes in the issue body, so the repository must stay private.

export const MAX_REPORT = 32_000;
export const MAX_COMMENT = 2_000;
export const MAX_CONTACT = 254;
const MAX_BODY = 64_000;
const GITHUB_API_VERSION = "2026-03-10";

function allowedOrigin(request, env) {
  const origin = request.headers.get("origin") ?? "";
  if (!origin.startsWith("chrome-extension://")) return null;
  const ids = (env.ALLOWED_EXTENSION_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return !ids.length || ids.includes(origin.slice("chrome-extension://".length)) ? origin : null;
}

/** Text inside a code fence: no Markdown, links or @mentions from the sender are rendered. */
function fenced(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

export function issueFrom({ report, comment, contact, code, version }) {
  const label = /^PN\d{3}$/.test(code ?? "") ? code : "Report";
  const from = /^[\w.+-]{1,32}$/.test(version ?? "") ? ` from ${version}` : "";
  const parts = [
    ...(contact ? ["**Contact**", fenced(contact)] : []),
    ...(comment ? ["**Comment**", fenced(comment)] : []),
  ];
  return { title: `[${label}] Tester report${from}`, body: [...parts, "**Report**", fenced(report)].join("\n\n") };
}

function validate(payload) {
  if (typeof payload?.report !== "string" || !payload.report.trim()) return "report is required";
  if (payload.report.length > MAX_REPORT) return "report is too long";
  const { comment } = payload;
  if (comment !== undefined && (typeof comment !== "string" || comment.length > MAX_COMMENT)) return "invalid comment";
  const { contact } = payload;
  if (contact !== undefined && (typeof contact !== "string" || contact.length > MAX_CONTACT
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact))) return "invalid contact";
  return null;
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    const headers = origin ? { "access-control-allow-origin": origin, vary: "origin" } : { vary: "origin" };
    const reply = (status, body = {}) => Response.json(body, { status, headers });

    if (!origin) return reply(403, { error: "origin not allowed" });
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...headers, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" },
      });
    }
    if (request.method !== "POST") return reply(405, { error: "POST only" });

    if (env.REPORT_LIMIT) {
      const address = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.REPORT_LIMIT.limit({ key: address });
      if (!success) return reply(429, { error: "too many reports" });
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY) return reply(413, { error: "too large" });
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return reply(400, { error: "invalid JSON" });
    }
    const invalid = validate(payload);
    if (invalid) return reply(400, { error: invalid });

    const response = await fetch(`https://api.github.com/repos/${env.REPORTS_REPO}/issues`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "content-type": "application/json",
        "user-agent": "printnomad-report-worker",
        "x-github-api-version": GITHUB_API_VERSION,
      },
      body: JSON.stringify(issueFrom(payload)),
    });
    return response.ok ? reply(201, { ok: true }) : reply(502, { error: "could not file the report" });
  },
};
