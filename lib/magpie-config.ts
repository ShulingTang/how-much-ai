// LAN and loopback gateways are intentional in this self-hosted application.
export function normalizeMagpieUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid Magpie URL.");
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP(S) Magpie URL without credentials, query, or fragment.");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}`;
}

export function validMagpieUser(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512 && value === value.trim() && !/[\r\n\0]/.test(value);
}
