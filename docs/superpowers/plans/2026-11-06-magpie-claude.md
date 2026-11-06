# Magpie Claude Quotas Implementation Plan

> Execute inline in the current session; use the separately requested model for the final code review.

**Goal:** Connect Claude subscriptions through Magpie without transferring their upstream credentials.

**Architecture:** Introduce a Magpie external account descriptor and adapter, following the existing sub2api connection pattern. Normalize measured quota windows into the current usage format and carry their sample timestamps through existing cache and notification boundaries.

**Tech Stack:** Next.js, TypeScript, React, Node.js test runner; no new dependencies.

## Tasks

- [x] Add `lib/magpie-config.ts` URL/identity validation, `lib/magpie.ts` bounded authenticated HTTP reads and Claude adapter, and `app/api/connect/magpie/route.ts` guarded list/connect/reconnect operations.
- [x] Extend `lib/types.ts`, `lib/vault.ts`, `lib/providers/index.ts`, and `lib/browser-boundary.ts` to preserve an encrypted Magpie connection while keeping browser metadata credential-free.
- [x] Extend `lib/usage-service.ts`, `lib/format.ts`, and `lib/local-credential-heal.ts` for external credential ownership, manual refresh, sample freshness, and expired windows.
- [x] Add the existing-style Magpie form in `components/MagpieConnect.tsx`; update `components/AddAccountModal.tsx`, `components/AccountCard.tsx`, and `components/Dashboard.tsx` for connection/reconnection, source labels, and refresh behavior. Preserve existing visual patterns and responsive behavior.
- [x] Add integration tests in `lib/magpie.test.ts`, using only mocked endpoints, fake keys, and temporary vault directories. Verify encrypted persistence, coalescing, reconnection identity, unsupported providers, expired/missing readings, cache freshness, redirect rejection, bounded responses, and request guards.
- [x] Document setup and key permissions in `README.md`, `.env.example`, and `docs/SELF_HOSTING.md`.
- [x] Run `npm test`, then `npm run typecheck`, then `npm run build`; fix failures before final review.
- [x] Request code/security review using `remote-magpie/codex-2/gpt-6-astra`, address actionable findings, and rerun checks affected by fixes. Final verdict: APPROVE.
- [ ] Commit with the AI co-author trailer and open the requested PR.

## Validation results

- `npm test`: 355 tests, 354 passing, one existing environment-gated local CLI credential test skipped.
- `npm run typecheck`: passed.
- `npm run build`: passed, including the vault-trace assertion.
- Browser: isolated production build with mocked Magpie and a temporary vault; connect, measured 98%/13% bars, manual refresh, reload persistence, and 390px form layout verified.
- Review: configured `remote-magpie/codex-2/gpt-6-astra` reviewer approved after browser-vault validation and stale-notification fixes, then approved the final parser/test delta.
