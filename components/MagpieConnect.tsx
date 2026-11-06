"use client";

import { useEffect, useRef, useState } from "react";
import type { MagpieAccountInfo } from "@/lib/magpie";

export function MagpieConnect({ expectedAccountId, onBusyChange, onConnected }: {
  expectedAccountId?: string;
  onBusyChange: (busy: boolean) => void;
  onConnected: (info: { email: string; plan?: string; label?: string }) => void;
}) {
  const [baseUrl, setBaseUrl] = useState("");
  const [gatewayKey, setGatewayKey] = useState("");
  const [accounts, setAccounts] = useState<MagpieAccountInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function submit(action: "list" | "connect", user?: string) {
    if (controller.current) return;
    const attempt = new AbortController();
    controller.current = attempt;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const response = await fetch("/api/connect/magpie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, baseUrl, gatewayKey, user, expectedAccountId }),
        signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(30_000)]),
      });
      const data = await response.json();
      if (attempt.signal.aborted) return;
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Couldn't connect Magpie.");
      if (action === "list") setAccounts(data.accounts);
      else {
        setGatewayKey("");
        onConnected(data);
      }
    } catch (error) {
      if (!attempt.signal.aborted) setError(error instanceof Error ? error.message : "Couldn't reach Magpie.");
    } finally {
      controller.current = null;
      if (!attempt.signal.aborted) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }

  const inputClass = "mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-ivory focus:border-coral/60 focus:outline-none";
  return (
    <div className="mt-5 space-y-4">
      <p className="text-xs leading-relaxed text-muted">
        Read Claude subscription limits from Magpie. Your Claude login stays on the Magpie machine.
        Use HTTPS outside a trusted local network.
      </p>
      <label className="block text-sm text-ivory">
        Magpie gateway URL
        <input type="url" value={baseUrl} disabled={busy} placeholder="http://localhost:3425"
          onChange={e => { setBaseUrl(e.target.value); setAccounts(null); }} className={inputClass} autoComplete="off" />
      </label>
      <label className="block text-sm text-ivory">
        Gateway key
        <input type="password" value={gatewayKey} disabled={busy} autoComplete="off" spellCheck={false}
          onChange={e => { setGatewayKey(e.target.value); setAccounts(null); }} className={inputClass} />
      </label>
      <p className="text-xs leading-relaxed text-muted">
        Prefer a read-only Magpie key. Restricted keys need Quotas enabled and access to all Claude models.
        The key is stored in the encrypted server vault.
      </p>
      <button type="button" disabled={busy || !baseUrl.trim() || !gatewayKey.trim()} onClick={() => void submit("list")}
        className="accent-btn min-h-11 w-full rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50">
        {busy ? "Working…" : "Load Claude accounts"}
      </button>
      {accounts && (
        <div className="space-y-2">
          <p className="text-xs text-muted">{expectedAccountId ? "Select the same Claude account to reconnect." : "Choose a Claude account to monitor."}</p>
          {accounts.length === 0 && <p className="text-sm text-muted">No Claude subscription accounts were returned. Check the Claude login and quota permissions in Magpie.</p>}
          {accounts.map(account => (
            <button key={account.user} type="button" disabled={busy} onClick={() => void submit("connect", account.user)}
              className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-border p-3 text-left text-sm text-ivory enabled:hover:bg-surface-hover disabled:opacity-50">
              <span className="min-w-0 break-words">{account.user}<span className="block text-xs text-muted">{account.name} · {account.plan}</span></span>
              <span className="shrink-0">{expectedAccountId ? "Reconnect" : "Connect"}</span>
            </button>
          ))}
        </div>
      )}
      {error && <p role="alert" className="text-sm text-[#ff9c95]">{error}</p>}
    </div>
  );
}
