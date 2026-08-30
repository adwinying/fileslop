# ADR-0002: Serve stored files as-is

**Status:** Accepted

## Context

Files in `p`/`pt` are publicly readable from the same origin that serves the rest of fileslop. If an uploaded `.html` or `.svg` is served back with a matching `Content-Type`, that is stored XSS on the origin.

The usual mitigations are an upload-time extension blocklist or allowlist, or a read-time neutral `Content-Type` with `Content-Disposition: attachment`.

Both cost something real here: the operator wants uploaded files to be usable at their URL, which `Content-Disposition: attachment` defeats.

## Decision

Files are stored and served exactly as uploaded. No extension blocklist at write time, no forced `Content-Disposition` at read time. The `Content-Type` is derived from the stored extension.

The upload endpoints are deliberately permissive about extensions as a result. Extension handling exists to make URLs useful, never as a security control.

## Consequences

- The threat model this normally guards against does not apply: **only operator-controlled agents can write**, because writes are tailnet-only (ADR-0001). Untrusted upload is not a scenario fileslop is in.
- That makes ADR-0001 load-bearing for this decision. If writes ever become reachable by an untrusted party, this ADR must be revisited in the same change — not afterwards.
- fileslop should be hosted on an origin that carries nothing else. A stored XSS here should not have cookies or a session for anything of value.
- The read endpoints must cite this ADR, so a future reader understands the permissive `Content-Type` is a decision and not an oversight.
