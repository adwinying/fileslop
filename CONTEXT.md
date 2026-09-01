# CONTEXT

fileslop is a self-hosted file drop running on Bun + Elysia. Agents POST a file, get a URL back, and fetch it later. It does nothing else.

## Glossary

### Namespace

The unit that partitions storage. There are four — `p`, `pt`, `r`, `rt` — the cross product of visibility (public / restricted) and retention (permanent / temporary).

| Namespace | Reads as | Visibility | Retention |
| --------- | -------- | ---------- | --------- |
| `p` | public | anyone can fetch | indefinite |
| `pt` | public temporary | anyone can fetch | deleted after TTL |
| `r` | restricted | Cloudflare Access auth required | indefinite |
| `rt` | restricted temporary | Cloudflare Access auth required | deleted after TTL |

A namespace name is also its directory name on disk (`$STORAGE_ROOT/p/`, etc).

### Slug

The 7-character identifier the server mints at upload time, drawn from the 62-character alphanumeric alphabet (`a-zA-Z0-9`). A stored filename is a slug plus an extension. The client's original filename never contributes to the slug.

### Extension

The suffix derived from the uploaded file's name, including the leading `.`. When nothing valid can be derived, it is empty and the file is stored with no extension.

### Write path / read path

Every write (POST, PUT) lives under `/w/`. Every read (GET) lives directly under its namespace. This split is the only boundary access control is drawn on — see ADR-0001.

```
POST /w/p          PUT /w/p/:filename          GET /p/:filename
POST /w/pt         PUT /w/pt/:filename         GET /pt/:filename
POST /w/r          PUT /w/r/:filename          GET /r/:filename
POST /w/rt         PUT /w/rt/:filename         GET /rt/:filename
```

### TTL

How long a file in a temporary namespace (`pt`, `rt`) survives. Measured from the file's mtime. There is no sidecar metadata and no database.

Because it is measured from mtime, overwriting a file restarts its TTL. This is intended: an overwrite is a fresh file that kept its name.

### Expired

A file is expired once it is older than its namespace's TTL. Expiry is what ends a file's life, not the sweep that follows it: an expired file is treated as absent by every endpoint, whether or not it is still on disk. It cannot be read, and it cannot be overwritten back into existence.

### Sweeper

The scheduled job that reclaims the disk space of expired files. Runs hourly. It is not what makes a file expire — it only catches up with expiry that has already happened.

### Provisioning

Creating and updating the Cloudflare resources that ADR-0001 relies on: the tunnel, its ingress, the Access applications covering `r`/`rt`, their policies, and the identity providers. It reconciles: the operator's configuration is the source of truth, and a dashboard edit is drift that the next run pulls back.

Reconciliation is bounded by ownership. Provisioning only touches resources fileslop created, and it never deletes — narrowing the allowed emails rewrites a policy rather than removing an application.

Access applications are named `fileslop:<hostname>:r` and `fileslop:<hostname>:rt`; their policies append `:allow`. These names mark the resources Provisioning owns.

### Preflight

The read-only check that runs on every startup, asking whether the Cloudflare *configuration* is correct: an Access application covers `r` and `rt`, its policy carries the expected rules, and the tunnel ingress has no route to `/w/`. It reads the Cloudflare API and never writes. A failed preflight stops the process from starting.

Preflight cannot observe reachability. It sees what Cloudflare has been told, not what the internet can reach — that is Verify's job.

### Verify

The check that runs from outside the process, after deployment, asking whether the observed *behaviour* is correct: `/r/` challenges for Access, `/p/` does not, `/w/` does not resolve, and the origin is not reachable except through the tunnel.

Verify needs a vantage point Preflight does not have. The origin-reachability check in particular is meaningless from inside the process, and is the only check that catches an origin exposed alongside a correct Cloudflare configuration.

## Configuration

All validated with t3env + zod.

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `STORAGE_ROOT` | `./storage` | Root directory for stored files |
| `BASE_URL` | none (required) | Origin used to build returned URLs |
| `MAX_UPLOAD_BYTES` | 100 MiB | Upload size cap |
| `TEMP_TTL` | 24h | TTL for temporary namespaces |
| `CLOUDFLARE_API_TOKEN` | none | Enables Provisioning and Preflight. Absent means neither runs |
| `CLOUDFLARE_ACCOUNT_ID` | discovered | Only needed when the token can see more than one account |
| `ACCESS_EMAILS` | none | Comma-separated allowlist for the restricted namespaces |
| `ACCESS_EMAIL_DOMAINS` | none | Comma-separated `@example.com` suffixes, allowed alongside `ACCESS_EMAILS` |
| `ACCESS_SESSION_DURATION` | 24h | How long an Access login lasts before re-authenticating |
| `ACCESS_IDPS` | One-time PIN | Additional identity providers, passed to Cloudflare unmodified |

fileslop reuses the account's One-time PIN when present. The hostname for the Access applications and the DNS record is derived from `BASE_URL` rather than configured separately. With a token present, at least one of `ACCESS_EMAILS` or `ACCESS_EMAIL_DOMAINS` must be set, or the policy would admit nobody.
