# ADR-0003: Namespaces are rows in a configuration table

**Status:** Accepted

## Context

There are four namespaces across three verbs — twelve endpoints. They differ only in target directory, TTL, and access tier, and the access tier is not the application's concern (ADR-0001). Within the application, a namespace is therefore just a directory and an optional TTL.

Writing twelve near-identical handlers by hand invites drift, particularly around TTL, which is consumed in three separate places: the upload path, the sweeper, and the read-time expiry check.

## Decision

Namespaces are declared once as a configuration table keyed by namespace name, each row holding its directory and its TTL, with a permanent namespace expressed as a null TTL. Every consumer derives its behaviour from that table.

Routes are registered **explicitly**, one call per endpoint, over shared handler functions parameterised by namespace — not by iterating the table.

## Consequences

- Adding `r` and `rt` is two rows plus their route registrations.
- The sweeper skips permanent namespaces structurally, by testing for a null TTL, rather than by consulting an exclusion list a new namespace could be forgotten from.
- A TTL cannot drift between the three places that read it.
- Explicit registration is what preserves Elysia's **type-level route tree**. Registering routes in a loop (`reduce` over the table) collapses the accumulator's type and destroys per-route typing and Eden Treaty inference. The routes would still work at runtime, but the types would stop describing them. The repetition in the registration lines is the price of that, and it keeps route paths greppable.
