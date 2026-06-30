/**
 * Credentials layer — zero-trust credential isolation for spawned agents.
 *
 *   credentialProxy.ts — CredentialBroker (mint/revoke/check vouchers) +
 *                        startCredentialProxy (local key-swapping HTTP proxy)
 *
 * The host starts ONE proxy per process, then mints a per-launch voucher for each
 * agent it spawns and injects the proxy URL + voucher file (never the real key)
 * via `cliTransport`'s credential mode.
 */
export * from "./credentialProxy.js";
