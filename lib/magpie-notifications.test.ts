import assert from "node:assert/strict";
import { after, test } from "node:test";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AccountUsageResult } from "./usage-service.ts";
import type { StoredNotifyState } from "./notify-store.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = { result: {} as AccountUsageResult, saved: [] as StoredNotifyState[], deliveries: 0 };
const globals = globalThis as typeof globalThis & { magpieCronFixture?: typeof fixture };
globals.magpieCronFixture = fixture;
const accountId = "magpie-claude-test";
const previous: StoredNotifyState = {
  key: `${accountId}::five_hour`, accountId, limitKey: "five_hour",
  lastResetsAt: new Date(Date.now() + 600000).toISOString(), peakPct: 70, warned: false,
};
const modules: Record<string, string> = {
  "@/lib/vault": `export const loadAccounts = async () => [{id:${JSON.stringify(accountId)},email:'claude@example.test',magpie:{baseUrl:'http://magpie.example.test',user:'claude@example.test'}}];`,
  "@/lib/sub2api": "export const syncSub2ApiAccounts = async () => ({added:0});",
  "@/lib/usage-service": "export const getAccountUsage = async () => globalThis.magpieCronFixture.result;",
  "@/lib/notify-store": `
    export const notifyStorageReady = () => true;
    export const claimNotificationRun = async () => ({acquired:true,leaseUntil:Date.now()+60000});
    export const renewNotificationRun = async () => true;
    export const releaseNotificationRun = async () => true;
    export const loadConfig = async () => ({recovery:true,warning:true,everyReset:false,warnThreshold:90,recoveryThreshold:80});
    export const loadStates = async () => [${JSON.stringify(previous)}];
    export const saveStates = async (_user, states) => { globalThis.magpieCronFixture.saved = states; };
  `,
  "@/lib/notify": `export const dispatch = async (_user,events) => {
    globalThis.magpieCronFixture.deliveries += events.length;
    return {channels:[],attempted:[],failures:[],delivered:true,telegram:false,webhook:false,push:{sent:0,removed:0,failed:0}};
  };`,
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (modules[specifier]) return { url: `data:text/javascript;base64,${Buffer.from(modules[specifier]).toString("base64")}`, shortCircuit: true };
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith("@/")) return nextResolve(pathToFileURL(path.join(root, `${specifier.slice(2)}.ts`)).href, context);
    if (/^\.\.?\//.test(specifier) && context.parentURL?.startsWith(pathToFileURL(root).href) && !context.parentURL.includes("/node_modules/") && !path.extname(new URL(specifier, context.parentURL).pathname)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});
const { POST } = await import("../app/api/cron/check/route.ts");
const oldSecret = process.env.CRON_SECRET;
process.env.CRON_SECRET = "test-magpie-cron-secret";
after(() => {
  if (oldSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = oldSecret;
  delete globals.magpieCronFixture;
  hooks.deregister();
});

async function run(stale: boolean, sampledAt: string | null, expired = false) {
  fixture.saved = []; fixture.deliveries = 0;
  fixture.result = {
    status: stale ? "stale" : "ready", stale, profile: null, fetchedAt: Date.now(), cooldownUntil: 0,
    usage: {
      snapshot: { source: "magpie", sampledAt },
      five_hour: { utilization: 98, resets_at: expired ? new Date(Date.now() - 1).toISOString() : previous.lastResetsAt },
    },
  };
  const response = await POST(new Request("http://localhost/api/cron/check", { method: "POST", headers: { "x-cron-secret": process.env.CRON_SECRET! } }));
  assert.equal(response.status, 200);
  return response.json();
}

test("cron skips stale, unknown, future-dated and expired Magpie samples without erasing history", async () => {
  for (const sample of [new Date(Date.now() - 3600000).toISOString(), null, new Date(Date.now() + 3600000).toISOString()]) {
    for (const expired of [false, true]) {
      const result = await run(true, sample, expired);
      assert.equal(result.checked, 1); assert.equal(result.events, 0);
      assert.equal(fixture.deliveries, 0); assert.deepEqual(fixture.saved, [previous]);
    }
  }
});

test("cron still emits a warning for a fresh measured Magpie sample", async () => {
  const result = await run(false, new Date().toISOString());
  assert.equal(result.events, 1);
  assert.equal(fixture.deliveries, 1);
  assert.equal(fixture.saved[0].warned, true);
});
