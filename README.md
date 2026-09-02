# fileslop

A self-hosted file drop for agents, built with Bun and Elysia.

## Container deployment

Pull the current image from GHCR:

```bash
docker pull ghcr.io/adwinying/fileslop:latest
```

Every push to `main` publishes two multi-architecture tags:

- `latest` points to the most recent build.
- `sha-<short>` identifies one commit and does not move, for example
  `sha-a1b2c3d`.

GHCR creates the package as private on its first publish. Before anyone else can
pull it without authentication, open the package settings on GitHub, choose
**Change visibility**, and make the package public. This is a one-time change.

The image pins cloudflared to the same version as `mise.toml`. To build locally
or test a cloudflared upgrade:

```bash
docker build --build-arg CLOUDFLARED_VERSION=2026.8.3 --tag fileslop .
```

Create a storage directory, make it writable by the image's uid and gid 10001,
then bind-mount it at `/storage`:

```bash
mkdir -p storage
sudo chown 10001:10001 storage
docker run --rm \
  --publish 127.0.0.1:3000:3000 \
  --env BASE_URL=http://localhost:3000 \
  --mount type=bind,source="$PWD/storage",target=/storage \
  ghcr.io/adwinying/fileslop:latest
```

The bind mount keeps uploaded files when the container is replaced. A mounted
directory that uid 10001 cannot write makes startup fail when fileslop creates
its namespace directories.

The image runs as uid and gid 10001. Use Docker's `--user` option when the host
directory belongs to another account:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --publish 127.0.0.1:3000:3000 \
  --env BASE_URL=http://localhost:3000 \
  --mount type=bind,source="$PWD/storage",target=/storage \
  ghcr.io/adwinying/fileslop:latest
```

Pass the Cloudflare variables described below to run provisioning and the
managed tunnel. Do not publish the container port in that mode. The write paths
must only be reachable through the tailnet, as required by ADR-0001.

## Cloudflare setup

fileslop can provision its own Cloudflare Tunnel, DNS record, Access
applications, policies, and identity providers. Two steps remain manual:

1. Add the domain to Cloudflare and point its nameservers at Cloudflare.
2. Create a [Cloudflare API token](https://dash.cloudflare.com/profile/api-tokens)
   with these permissions:
   - Account | Cloudflare Tunnel | Edit
   - Account | Access: Apps and Policies | Edit
   - Account | Access: Organizations, Identity Providers, and Groups | Edit
   - Zone | DNS | Edit
   - Zone | Zone | Read

Scope the token to the single account and zone used by fileslop. Set
`CLOUDFLARE_ACCOUNT_ID` when the token can access more than one account.

The process keeps this write-scoped token for its lifetime. If fileslop is
compromised, the attacker can also change the Access applications protecting
it. Use the narrowest account and zone scopes available.

Install Bun and `cloudflared` from `mise.toml`, set the environment, then start
fileslop:

```bash
mise install
export BASE_URL=https://files.example
export CLOUDFLARE_API_TOKEN=replace-me
export ACCESS_EMAILS=operator@example.com
bun run src/index.ts
```

On first boot, fileslop:

1. Creates or updates the `r` and `rt` Access applications and their allow
   policies.
2. Reuses the account's One-time PIN or creates one, then adds the identity
   providers from `ACCESS_IDPS`.
3. Creates or updates a remotely managed tunnel, its read-only ingress, and a
   proxied DNS record for the `BASE_URL` hostname.
4. Runs preflight, starts the HTTP server, then starts `cloudflared` with the
   tunnel token in its environment.

Provisioning owns resources whose names start with `fileslop:<hostname>`. It
does not modify unrelated resources and never deletes resources. Without
`CLOUDFLARE_API_TOKEN`, all Cloudflare work is disabled.

After provisioning, preflight checks that `r` and `rt` are covered by Access,
all read namespaces are routed, and `/w/` is not routed through the tunnel. A
failed preflight stops startup. It cannot tell whether clients can reach the
origin directly, bypassing the tunnel. Run the
[deployment verification](#verify-a-deployment) to cover that gap.

### Environment

| Variable                  | Required                                                 | Default         | Purpose                                                                          |
| ------------------------- | -------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------- |
| `BASE_URL`                | Yes                                                      | None            | Public HTTP or HTTPS origin used in returned URLs and Cloudflare resource names. |
| `STORAGE_ROOT`            | No                                                       | `./storage`     | Root directory for stored files.                                                 |
| `MAX_UPLOAD_BYTES`        | No                                                       | `104857600`     | Maximum upload size in bytes.                                                    |
| `TEMP_TTL`                | No                                                       | `86400000`      | Lifetime of temporary files in milliseconds.                                     |
| `CLOUDFLARE_API_TOKEN`    | No                                                       | None            | Enables Cloudflare provisioning, preflight, and the managed tunnel.              |
| `CLOUDFLARE_ACCOUNT_ID`   | No                                                       | Auto-discovered | Account to use. Required when the token can see more than one account.           |
| `ACCESS_EMAILS`           | In Cloudflare mode, unless `ACCESS_EMAIL_DOMAINS` is set | None            | Comma-separated email allowlist for `r` and `rt`.                                |
| `ACCESS_EMAIL_DOMAINS`    | In Cloudflare mode, unless `ACCESS_EMAILS` is set        | None            | Comma-separated domain allowlist. A leading `@` is optional.                     |
| `ACCESS_SESSION_DURATION` | No                                                       | `24h`           | Cloudflare Access session duration.                                              |
| `ACCESS_IDPS`             | No                                                       | `[]`            | JSON array of extra Cloudflare identity providers.                               |

At least one of `ACCESS_EMAILS` or `ACCESS_EMAIL_DOMAINS` is required when
`CLOUDFLARE_API_TOKEN` is set. fileslop also refuses to provision when it cannot
identify one account, find a containing DNS zone, uniquely identify its owned
resources, or use its tunnel as a remotely managed tunnel.

### GitHub and Google login

`ACCESS_IDPS` passes each provider's `type` and `config` to Cloudflare without
provider-specific translation. Replace the OAuth credentials in one of these
copy-paste examples.

GitHub:

```bash
export ACCESS_IDPS='[{"config":{"client_id":"<your client id>","client_secret":"<your client secret>"},"type":"github","name":"my example idp"}]'
```

Google:

```bash
export ACCESS_IDPS='[{"config":{"client_id":"<your client id>","client_secret":"<your client secret>"},"type":"google","name":"my example idp"}]'
```

To enable both, put both objects in the same JSON array. fileslop prefixes each
name with `fileslop:<hostname>:idp:` when it creates the provider.

## Development

Install the tools from `mise.toml`, then start the development server:

```bash
mise install
bun run dev
```

## Verify a deployment

Run the external checks from outside the tailnet:

```bash
bun run verify:external https://files.example
```

Run the write-path checks from a tailnet-connected machine:

```bash
bun run verify:internal http://fileslop.tailnet:3000
```

`.github/workflows/verify.yml` exposes the same checks as a reusable workflow.
Both jobs use GitHub-hosted runners. The internal job joins the tailnet with
`tailscale/github-action`, `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, and the
`tag:ci` device tag. Set `DEPLOYED_URL` and `ORIGIN_URL` as repository variables;
the workflow needs no run-time inputs.
