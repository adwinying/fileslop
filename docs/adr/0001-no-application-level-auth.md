# ADR-0001: No application-level authentication

**Status:** Accepted, amended — the original decision filtered methods with a WAF custom rule. That rule was never deployed; tunnel ingress now omits the write paths entirely, which fails closed rather than open.

## Context

fileslop needs two access tiers: `p`/`pt` readable by anyone, `r`/`rt` readable only by authenticated users. Writes are only ever performed by agents the operator controls.

Cloudflare Access can scope an application by hostname and path, with wildcards. It has **no HTTP method condition** — method filtering lives in Gateway HTTP policies or WAF custom rules, not in Access policies.

This matters because the write/read split is drawn by method, not by resource. Under the originally sketched layout, `PUT /p/:filename` and `GET /p/:filename` occupied the same path. Any rule making `/p/*` publicly readable would also have made it publicly writable, and Access could not tell the two apart.

Running writes and reads on separate hostnames would solve this and would fail closed, but the operator does not want to maintain two hostnames.

## Decision

The application performs **no authentication or authorisation of any kind**. It does not read `CF-Access-Jwt-Assertion` and does not distinguish callers.

Access control is entirely infrastructural, and is made expressible by moving every write under a single `/w/` prefix:

- `/w/*` — writes. Reachable only from the tailnet.
- everything else — reads. Fronted by Cloudflare.

Cloudflare Access applications are created for `/r/*` and `/rt/*` only. `/p/*` and `/pt/*` are left uncovered rather than given a public Bypass policy; an uncovered path is unprotected by default, which is simpler and has fewer ways to misconfigure.

The tunnel is configured to route only the read paths. `/w/*` has no ingress rule and never resolves through it, so writes are unreachable from the internet rather than filtered there.

## Consequences

- Adding a namespace requires no new access rules. `/w/*` already covers its writes.
- The single `/w/` prefix does not depend on how Access resolves prefix-vs-exact path matching, a question the documentation does not settle clearly. A disjoint prefix is correct either way.
- **This configuration fails closed**, for the same reason two hostnames would: writes are unreachable because nothing routes to them, not because a rule rejects them. An ingress config that omits `/w/*` cannot be partially deleted into an exposed state the way a method-filtering rule can.
- **The origin must be unreachable except through the tunnel.** Since the application authenticates nobody, a direct origin request bypasses Access entirely and returns restricted files. Run `cloudflared` with no inbound public port.
- Agents fetching `/r/:filename` need Access **service tokens** (`CF-Access-Client-Id` / `CF-Access-Client-Secret`). Browser SSO does not work for `curl`.
- Anyone who reaches the process can write to it. The deployment must never expose the listening port beyond the tailnet.
- The Cloudflare configuration this decision depends on is created and checked by fileslop itself — see ADR-0004. That does not change the decision here: the application still authenticates nobody at request time.
