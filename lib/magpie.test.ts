import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { promises as fs } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith("@/")) return nextResolve(pathToFileURL(path.join(root, `${specifier.slice(2)}.ts`)).href, context);
    if (/^\.\.?\//.test(specifier) && context.parentURL?.startsWith(pathToFileURL(root).href) && !context.parentURL.includes("/node_modules/") && !path.extname(new URL(specifier, context.parentURL).pathname)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hma-magpie-test-"));
for (const key of ["APP_PASSWORD", "AUTH_SECRET", "CONVEX_URL", "NEXT_PUBLIC_CONVEX_URL", "VAULT_ACCESS_SECRET", "KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) delete process.env[key];
process.env.VAULT_DATA_DIR = dataDir;
process.env.VAULT_ENCRYPTION_SECRET = "magpie-test-only-encryption-secret";
const { POST } = await import("../app/api/connect/magpie/route.ts");
const { loadAccounts, saveAccounts, parseStoredAccounts } = await import("./vault.ts");
const { getAccountUsage, clearAccountUsageState } = await import("./usage-service.ts");
const { toBrowserAccount, toBrowserUsageResponse } = await import("./browser-boundary.ts");
const { magpieAccountId, normalizeMagpieQuota } = await import("./magpie.ts");
const { normalizeMagpieUrl } = await import("./magpie-config.ts");
const { extractBars } = await import("./format.ts");
const baseUrl = "http://magpie.example.test:3425";
const gatewayKey = "test-magpie-gateway-key";
let cards: Record<string, unknown>[];
let calls: string[];
let status = 200;
function request(body: Record<string, unknown>, headers = {}) {
  return new Request("http://localhost/api/connect/magpie", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ baseUrl, gatewayKey, ...body }),
  });
}
async function connect(user = "claude@example.test") {
  const response = await POST(request({ action: "connect", user }));
  assert.equal(response.status, 200, await response.clone().text());
  return response;
}
beforeEach(async () => {
  cards = [{
    provider: "claude", kind: "subscription", name: "Claude Code", plan: "pro", user: "claude@example.test",
    readAt: new Date().toISOString(),
    windows: [
      { name: "5 hours", used: 98, remaining: 2, resetsAt: new Date(Date.now() + 600000).toISOString() },
      { name: "7 days", used: 13, remaining: 87, resetsAt: new Date(Date.now() + 86400000).toISOString() },
    ],
    access_token: "upstream-secret-never-return",
  }];
  status = 200;
  calls = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input); calls.push(url);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${gatewayKey}`);
    assert.ok(url === `${baseUrl}/v1/magpie/quotas?kept=1` || url === `${baseUrl}/v1/magpie/quotas`);
    return new Response(status === 200 ? JSON.stringify({ object: "list", data: cards }) : "remote-secret-never-return", { status });
  }) as typeof fetch;
  for (const account of await loadAccounts("default")) await clearAccountUsageState("default", account.id);
  await saveAccounts("default", []);
});
after(async () => {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
  await fs.rm(dataDir, { recursive: true, force: true });
  hooks.deregister();
});

test("list exposes Claude subscription metadata only, never keys or upstream credentials", async () => {
  cards.push({ ...cards[0], provider: "codex", user: "codex@example.test" }, { ...cards[0], kind: "balance" }, { ...cards[0], user: "" });
  const response = await POST(request({ action: "list" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { accounts: [{ user: "claude@example.test", name: "Claude Code", plan: "Pro" }] });
  assert.equal((await loadAccounts("default")).length, 0);
});

test("connect encrypts the gateway key and duplicate connections preserve labels", async () => {
  const response = await connect();
  assert.ok(!(await response.text()).includes(gatewayKey));
  let [account] = await loadAccounts("default");
  assert.deepEqual(account.magpie, { baseUrl, user: "claude@example.test" });
  assert.equal(account.tokens.accessToken, gatewayKey);
  assert.equal(account.tokens.refreshToken, null);
  assert.ok(!JSON.stringify(account).includes("upstream-secret"));
  assert.ok(!(await fs.readFile(path.join(dataDir, "vault.enc"), "utf8")).includes(gatewayKey));
  const dto = toBrowserAccount(account);
  assert.equal(dto.source, "magpie");
  assert.ok(!JSON.stringify(dto).includes(gatewayKey) && !JSON.stringify(dto).includes(baseUrl));
  await saveAccounts("default", [{ ...account, label: "My Claude", addedAt: 123 }]);
  await connect();
  [account] = await loadAccounts("default");
  assert.equal(account.label, "My Claude");
  assert.equal(account.addedAt, 123);
});

test("passive reads coalesce, normalize both windows, and never call Claude OAuth/profile", async () => {
  await connect();
  const [account] = await loadAccounts("default"); calls = [];
  const [result] = await Promise.all([getAccountUsage("default", account), getAccountUsage("default", account)]);
  assert.equal(calls.length, 1);
  assert.equal(result.usage?.five_hour?.utilization, 98);
  assert.equal(result.usage?.seven_day?.utilization, 13);
  assert.equal(result.usage?.snapshot?.source, "magpie");
  assert.equal(result.profile, null);
  assert.equal(result.stale, false);
  assert.ok(!JSON.stringify(toBrowserUsageResponse(result)).includes("upstream-secret"));
  await getAccountUsage("default", account);
  assert.equal(calls.length, 1);
});

test("manual refresh bypasses passive cache while sharing the existing lease", async () => {
  await connect();
  const [account] = await loadAccounts("default");
  await getAccountUsage("default", account); calls = [];
  await Promise.all([getAccountUsage("default", account, { activeRefresh: true }), getAccountUsage("default", account, { activeRefresh: true })]);
  assert.deepEqual(calls, [`${baseUrl}/v1/magpie/quotas`]);
  await getAccountUsage("default", account, { activeRefresh: true });
  assert.equal(calls.length, 1);
});

test("old, future, and undated samples stay stale on cache hits", async () => {
  for (const readAt of [new Date(Date.now() - 3600000).toISOString(), new Date(Date.now() + 3600000).toISOString(), undefined]) {
    cards[0].readAt = readAt;
    await connect(); const [account] = await loadAccounts("default");
    assert.equal((await getAccountUsage("default", account)).stale, true);
    assert.equal((await getAccountUsage("default", account)).stale, true);
  }
});

test("missing, invalid, and expired windows are unknown; measured zero is retained", () => {
  const now = Date.now();
  for (const used of [undefined, null, "98", -1, 101]) {
    assert.equal(normalizeMagpieQuota({ windows: [{ name: "5 hours", used, remaining: 100 }] }, now).five_hour, undefined);
  }
  assert.equal(normalizeMagpieQuota({ windows: [{ name: "5 hours", used: 90, resetsAt: new Date(now - 1).toISOString() }] }, now).five_hour, undefined);
  const usage = normalizeMagpieQuota({ windows: [{ name: "5 hours", used: 0, resetsAt: new Date(now + 1000).toISOString() }] }, now);
  assert.equal(usage.five_hour?.utilization, 0);
  assert.equal(extractBars(usage, now).length, 1);
  assert.equal(extractBars(usage, now + 1000).length, 0);
});

test("identity is gateway-specific and reconnection cannot replace a different account", async () => {
  await connect(); const [account] = await loadAccounts("default");
  assert.notEqual(magpieAccountId(baseUrl, "claude@example.test"), magpieAccountId("https://other.example.test", "claude@example.test"));
  cards.push({ ...cards[0], user: "other@example.test" });
  const response = await POST(request({ action: "connect", user: "other@example.test", expectedAccountId: account.id }));
  assert.equal(response.status, 409);
  assert.equal((await loadAccounts("default")).length, 1);
  const same = await POST(request({ action: "connect", user: "claude@example.test", expectedAccountId: account.id }));
  assert.equal(same.status, 200);
});

test("removed and ambiguous Claude identities fail without selecting another account", async () => {
  await connect(); const [account] = await loadAccounts("default");
  cards[0].provider = "codex";
  const result = await getAccountUsage("default", account);
  assert.equal(result.status, "error");
  cards = [{ provider: "claude", kind: "subscription", user: "duplicate@example.test" }, { provider: "claude", kind: "subscription", user: "duplicate@example.test" }];
  assert.equal((await POST(request({ action: "connect", user: "duplicate@example.test" }))).status, 422);
});

test("authentication and quota-permission errors require reconnect without rotating credentials", async () => {
  for (const code of [401, 403]) {
    status = 200; await connect(); const [account] = await loadAccounts("default");
    status = code; calls = [];
    const result = await getAccountUsage("default", account);
    assert.equal(result.status, "reauth");
    assert.match(result.error ?? "", /Magpie/);
    assert.equal(calls.length, 1);
    await getAccountUsage("default", account); assert.equal(calls.length, 1);
  }
});

test("connection errors are sanitized and quota permission errors are actionable", async () => {
  for (const code of [401, 403, 404, 429, 500]) {
    status = code;
    const response = await POST(request({ action: "list" }));
    assert.equal(response.status, code === 500 ? 502 : code);
    const text = await response.text();
    assert.ok(!text.includes(gatewayKey) && !text.includes("remote-secret"));
    if (code === 403) assert.match(text, /Quotas/);
  }
});

test("URL validation supports LAN and reverse-proxy prefixes and rejects credential-bearing URLs", () => {
  assert.equal(normalizeMagpieUrl("http://127.0.0.1:3425/v1/"), "http://127.0.0.1:3425");
  assert.equal(normalizeMagpieUrl("https://example.test/magpie/"), "https://example.test/magpie");
  for (const value of ["ftp://host", "https://user:key@host", "https://host?key=secret", "https://host/#key", "", null]) assert.throws(() => normalizeMagpieUrl(value));
});

test("request guards reject cross-origin, invalid JSON, bad keys, and missing users", async () => {
  assert.equal((await POST(request({ action: "list" }, { Origin: "https://attacker.example" }))).status, 403);
  assert.equal((await POST(new Request("http://localhost/api/connect/magpie", { method: "POST", headers: { "Content-Type": "application/json" }, body: "null" }))).status, 400);
  for (const body of [{ gatewayKey: "" }, { gatewayKey: "bad\r\nkey" }, { baseUrl: "https://user:key@example.test" }, { action: "connect", user: "" }, { action: "connect", user: "unknown" }]) {
    const response = await POST(request({ action: "connect", ...body }));
    assert.ok([400, 422].includes(response.status));
  }
});

test("vault validation rejects mixed external sources and non-Claude Magpie records", async () => {
  await connect(); const [account] = await loadAccounts("default");
  assert.deepEqual(parseStoredAccounts([account])[0].magpie, account.magpie);
  for (const bad of [
    { ...account, sub2api: { baseUrl, accountId: 1 } },
    { ...account, provider: "openai" },
    { ...account, magpie: { baseUrl: "https://user:secret@host", user: "a" } },
    { ...account, magpie: { baseUrl, user: "" } },
    { ...account, credentialKind: "rotating", tokens: { ...account.tokens, refreshToken: "not-upstream" } },
  ]) assert.throws(() => parseStoredAccounts([bad]));
});

test("malformed and oversized upstream responses never reflect response contents", async () => {
  for (const response of ["invalid secret JSON", JSON.stringify({ data: {} }), " ".repeat(2 * 1024 * 1024 + 1)]) {
    globalThis.fetch = (async () => new Response(response)) as typeof fetch;
    const result = await POST(request({ action: "list" }));
    assert.equal(result.status, 502);
    assert.ok(!(await result.text()).includes("secret JSON"));
  }
});

test("redirect/abort/network rejections are sanitized instead of leaking transport details", async () => {
  for (const name of ["TypeError", "AbortError", "TimeoutError"]) {
    globalThis.fetch = (async () => { const error = new Error(`redirect to remote-secret with ${gatewayKey}`); error.name = name; throw error; }) as typeof fetch;
    const response = await POST(request({ action: "list" }));
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.ok(!text.includes("remote-secret") && !text.includes(gatewayKey));
  }
});

test("ambiguous duplicate windows stay unknown and malformed reset clocks are not invented", () => {
  const duplicate = normalizeMagpieQuota({ windows: [
    { name: "5 hours", used: 10 }, { name: "5 hours", used: 90 }, { name: "5 hours", used: 80 },
  ] });
  assert.equal(duplicate.five_hour, undefined);
  const invalidReset = normalizeMagpieQuota({ windows: [{ name: "7 days", used: 13, resetsAt: "not-a-clock" }] });
  assert.deepEqual(invalidReset.seven_day, { utilization: 13, resets_at: null });
});

test("password-protected installations require a session before listing Magpie accounts", async () => {
  process.env.APP_PASSWORD = "magpie-test-password";
  try {
    const response = await POST(request({ action: "list" }));
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
  } finally {
    delete process.env.APP_PASSWORD;
  }
});
