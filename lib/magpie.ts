import { createHash } from "node:crypto";
import { normalizeMagpieUrl, validMagpieUser } from "./magpie-config";
import { ProviderError, type Provider } from "./providers/types";
import type { StoredAccount, UsageData } from "./types";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

export interface MagpieAccountInfo {
  user: string;
  name: string;
  plan: string;
}

export class MagpieError extends ProviderError {}

async function readQuotas(baseUrl: string, key: string, kept: boolean): Promise<JsonObject[]> {
  let response: Response;
  try {
    response = await fetch(`${normalizeMagpieUrl(baseUrl)}/v1/magpie/quotas${kept ? "?kept=1" : ""}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new MagpieError("Couldn't reach Magpie. Check its URL, allowed addresses, and network access; redirects are not followed.", 502);
  }
  if (!response.ok) {
    await response.body?.cancel();
    const message = response.status === 401
      ? "Magpie rejected the gateway key. Reconnect with a current gateway key."
      : response.status === 403
        ? "Magpie denied quota access. Enable Quotas for this gateway key and allow claude/*, or use a read-only key. Check the gateway's allowed addresses too."
        : response.status === 404
          ? "The Magpie quota endpoint was not found. Check the base URL and Magpie version."
          : `Magpie returned HTTP ${response.status}.`;
    throw new MagpieError(message, response.status);
  }
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const result = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!Array.isArray(result.data)) throw new Error();
    return result.data.map(object);
  } catch {
    throw new MagpieError("Magpie returned an unsupported or oversized quota response.", 502);
  }
}

function info(card: JsonObject): MagpieAccountInfo | null {
  if (card.provider !== "claude" || card.kind !== "subscription" || !validMagpieUser(card.user)) return null;
  const name = typeof card.name === "string" && card.name.trim() ? card.name.trim().slice(0, 200) : "Claude Code";
  const rawPlan = typeof card.plan === "string" ? card.plan.trim().slice(0, 100) : "";
  const plan = rawPlan ? rawPlan.replace(/^./, c => c.toUpperCase()) : "Claude";
  return { user: card.user, name, plan };
}

export async function listMagpieAccounts(baseUrl: string, key: string): Promise<MagpieAccountInfo[]> {
  const cards = await readQuotas(baseUrl, key, true);
  const accounts = cards.map(info).filter((item): item is MagpieAccountInfo => item !== null);
  if (new Set(accounts.map(a => a.user)).size !== accounts.length) {
    throw new MagpieError("Magpie returned duplicate Claude account identities. Resolve them in Magpie before connecting.", 422);
  }
  return accounts;
}

export function magpieAccountId(baseUrl: string, user: string): string {
  return `magpie-${createHash("sha256").update(`${normalizeMagpieUrl(baseUrl)}\0claude\0${user}`).digest("hex")}`;
}

async function readAccount(baseUrl: string, key: string, user: string, kept: boolean) {
  const cards = (await readQuotas(baseUrl, key, kept)).filter(card => info(card)?.user === user);
  if (cards.length !== 1) {
    throw new MagpieError("The selected Claude account is missing or ambiguous in Magpie. Check its login and this key's quota permissions.", 422);
  }
  return { card: cards[0], account: info(cards[0])! };
}

export async function connectMagpieAccount(baseUrl: string, key: string, user: string): Promise<StoredAccount> {
  const { account } = await readAccount(baseUrl, key, user, true);
  return {
    id: magpieAccountId(baseUrl, user),
    email: account.user,
    fullName: account.name,
    plan: account.plan,
    addedAt: Date.now(),
    credentialKind: "long_lived",
    magpie: { baseUrl: normalizeMagpieUrl(baseUrl), user },
    tokens: { accessToken: key, refreshToken: null, expiresAt: 0 },
  };
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export function normalizeMagpieQuota(card: JsonObject, now = Date.now()): UsageData {
  const usage: UsageData = { snapshot: { source: "magpie", sampledAt: timestamp(card.readAt) } };
  if (!Array.isArray(card.windows)) return usage;
  const seen = new Set<string>();
  for (const raw of card.windows) {
    const window = object(raw);
    const bucket = window.name === "5 hours" ? "five_hour" : window.name === "7 days" ? "seven_day" : null;
    if (!bucket) continue;
    if (seen.has(bucket)) {
      delete usage[bucket];
      continue;
    }
    seen.add(bucket);
    if (typeof window.used !== "number" || !Number.isFinite(window.used) || window.used < 0 || window.used > 100) continue;
    const resetsAt = timestamp(window.resetsAt);
    if (resetsAt && Date.parse(resetsAt) <= now) continue;
    usage[bucket] = { utilization: window.used, resets_at: resetsAt };
  }
  return usage;
}

export function magpieProvider(provider: Provider, connection: NonNullable<StoredAccount["magpie"]>): Provider {
  return {
    id: provider.id,
    label: provider.label,
    supportsOAuth: false,
    managesCredentialsExternally: true,
    async refresh() { throw new MagpieError("Reconnect Magpie to replace its gateway key.", 401); },
    async resolveIdentity(tokens) {
      const { account } = await readAccount(connection.baseUrl, tokens.accessToken, connection.user, true);
      return { id: magpieAccountId(connection.baseUrl, connection.user), email: account.user, fullName: account.name, plan: account.plan };
    },
    async fetchUsage(tokens, opts) {
      const { card } = await readAccount(connection.baseUrl, tokens.accessToken, connection.user, !opts?.activeRefresh);
      const usage = normalizeMagpieQuota(card);
      if (opts?.activeRefresh) usage.snapshot!.refreshCompletedAt = Date.now();
      return usage;
    },
  };
}
