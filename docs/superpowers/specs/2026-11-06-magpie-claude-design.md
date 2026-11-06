# Claude quota readings through Magpie

## Scope

Add Magpie as an external connection source for Claude only. Keep the Anthropic provider identity and existing account cards, cache coordination, encrypted vault backends, and notifications. Do not import Claude OAuth credentials, add Codex support, or change an existing deployment.

## Connection and identity

The user supplies a Magpie gateway base URL and gateway key, loads the supported Claude subscription accounts, and selects one. Prefer a read-only key. A restricted key must have Quotas enabled and allow `claude/*`. The application server must be allowed to reach the gateway. Keep the key in the encrypted vault and expose only display metadata to the browser.

Deduplicate by normalized gateway URL, `claude` provider, and Magpie's account `user` identifier. Reconnection must target the same identity, retaining its nickname and original connection date. Reject ambiguous duplicate identities and accounts without a stable user identifier.

## Readings

Automatic checks use `GET /v1/magpie/quotas?kept=1`. Manual refresh uses `GET /v1/magpie/quotas`, which can still return Magpie's cached reading. Map the `5 hours` and `7 days` windows' measured `used` percentages and `resetsAt` values, and preserve `readAt` as the quota sample time. Missing, invalid, and expired values stay unknown. Samples without a valid time or older than the existing five-minute freshness threshold are stale and do not trigger notifications.

## Boundaries

Reuse the existing authenticated, same-origin POST connection boundary and externally managed provider interface. Allow intentional loopback/LAN deployments, validate HTTP(S) URLs, disable outbound redirects, enforce deadlines and a response-size limit, and never reflect remote response bodies or keys in errors. Reject mixed Magpie/sub2api vault records and non-Claude Magpie records. Do not call upstream OAuth/profile or inference endpoints.

## Validation

Test the real connection route with mocked Magpie HTTP responses and a temporary encrypted vault: identity, account filtering, parsing, refresh/cache behavior, stale data, authentication/permission failures, malformed input, secret isolation, reconnection, and vault validation. Run the repository's required `npm test`, `npm run typecheck`, and `npm run build` in order. Review the completed change with `remote-magpie/codex-2/gpt-6-astra`, address findings, and open a PR against `wogong/how-much-ai`.
