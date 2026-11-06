import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { browserMutationFailure, readJsonObject, requestBodyFailure } from "@/lib/request-body";
import { normalizeMagpieUrl, validMagpieUser } from "@/lib/magpie-config";
import { connectMagpieAccount, listMagpieAccounts, MagpieError } from "@/lib/magpie";
import { persistStoredAccount } from "@/lib/connect-account";
import { loadAccounts } from "@/lib/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Credentials travel in the guarded POST body, never in URLs or successful responses.
export async function POST(req: Request) {
  const guard = browserMutationFailure(req);
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const userId = await requireUser(req);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req);
  } catch (error) {
    const failure = requestBodyFailure(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }
  let baseUrl: string;
  try {
    baseUrl = normalizeMagpieUrl(body.baseUrl);
  } catch {
    return NextResponse.json({ error: "Enter an HTTP(S) Magpie URL without credentials, query, or fragment." }, { status: 400 });
  }
  if (typeof body.gatewayKey !== "string" || !body.gatewayKey.trim() || body.gatewayKey.length > 16 * 1024 || /[\r\n]/.test(body.gatewayKey)) {
    return NextResponse.json({ error: "A Magpie gateway key is required." }, { status: 400 });
  }
  const key = body.gatewayKey.trim();
  const headers = { "Cache-Control": "no-store" };
  try {
    if (body.action === "list") {
      return NextResponse.json({ accounts: await listMagpieAccounts(baseUrl, key) }, { headers });
    }
    if (body.action !== "connect" || !validMagpieUser(body.user)) {
      return NextResponse.json({ error: "Choose a Claude account from Magpie." }, { status: 400 });
    }
    const existing = await loadAccounts(userId);
    if (body.expectedAccountId !== undefined && (typeof body.expectedAccountId !== "string" || !existing.some(a => a.id === body.expectedAccountId && a.magpie))) {
      return NextResponse.json({ error: "The Magpie account to reconnect was not found." }, { status: 409 });
    }
    const account = await connectMagpieAccount(baseUrl, key, body.user);
    if (body.expectedAccountId !== undefined && account.id !== body.expectedAccountId) {
      return NextResponse.json({ error: "Select the same Magpie gateway and Claude account to reconnect." }, { status: 409 });
    }
    const result = await persistStoredAccount(userId, account);
    return NextResponse.json({ ok: true, ...result }, { headers });
  } catch (error) {
    if (error instanceof MagpieError) {
      const status = [401, 403, 404, 422, 429].includes(error.status) ? error.status : 502;
      return NextResponse.json({ error: error.message }, { status, headers });
    }
    return NextResponse.json({ error: "Couldn't connect Magpie or save its encrypted key. Check the gateway and vault configuration." }, { status: 500, headers });
  }
}
