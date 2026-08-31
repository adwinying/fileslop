# ADR-0004: fileslop provisions its own Cloudflare configuration

**Status:** Accepted.

## Context

ADR-0001 puts every access control in infrastructure: Cloudflare Access applications over `/r/*` and `/rt/*`, and tunnel ingress that never routes `/w/*`. It states the design but nothing states the steps, so a deployment is correct only if the operator visits the Cloudflare dashboard and gets a sequence of manual actions right. A mistake there fails silently and serves every restricted file to anyone.

Almost all of it turns out to be reachable from the Cloudflare API: tunnels and their ingress, Access applications and policies, and identity providers — including One-time PIN, which needs no external OAuth application. What cannot be automated is creating the API token and pointing a domain's nameservers at Cloudflare.

## Decision

fileslop provisions and checks its own Cloudflare configuration on startup, given an API token.

- **Provisioning** reconciles: the operator's configuration is the source of truth and a dashboard edit is drift that the next boot pulls back. It is bounded by ownership — it only touches resources it created, identified by name convention, and it never deletes.
- **Preflight** then re-reads the configuration and refuses to start the process if `r`/`rt` are not covered or if ingress routes `/w/`.
- Both are inert without a token, so local development and public-only deployments need no Cloudflare account.
- fileslop supervises `cloudflared` as a child process, receiving the tunnel token over the environment, so that a single container is a complete deployment.

**This does not weaken ADR-0001.** fileslop still authenticates nobody and still reads no `CF-Access-Jwt-Assertion`. It configures the thing that authenticates; it does not become that thing.

## Consequences

- **The process holds a write-scoped Cloudflare token.** Compromising fileslop means compromising the Access application that protects it, and whatever else the token's scope reaches. This is the price of the deployment being one command, and it is a real reduction in isolation: previously the process held no credentials at all.
- **A wrong value now propagates.** A typo in the allowed emails rewrites the live policy on the next restart. Widening fails safe (nobody matches); narrowing locks the operator out until they fix the config or edit the dashboard. Ownership and never-delete bound the damage to fileslop's own resources.
- Provisioning failure is not fatal — preflight is the authority on whether the configuration is correct, so a Cloudflare outage cannot take down an already-correct deployment.
- **Preflight cannot see reachability.** It reads what Cloudflare has been told, not what the internet can reach. An origin exposed directly, bypassing the tunnel, passes preflight. `bun run verify:external` and `bun run verify:internal` check the deployed access boundaries from outside the process.
