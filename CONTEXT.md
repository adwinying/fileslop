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

Because it is measured from mtime, overwriting a file restarts its TTL. This is intended: an overwrite is a fresh file that kept its name. It follows that a file which has expired but not yet been swept can be overwritten back into existence.

### Sweeper

The scheduled job that deletes files past their TTL. Runs hourly.

## Configuration

All validated with t3env + zod.

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `STORAGE_ROOT` | `./storage` | Root directory for stored files |
| `BASE_URL` | none (required) | Origin used to build returned URLs |
| `MAX_UPLOAD_BYTES` | 100 MiB | Upload size cap |
| `TEMP_TTL` | 24h | TTL for temporary namespaces |
