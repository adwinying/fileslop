# Elysia with Bun runtime

## Getting Started

To get started with this template, simply paste this command into your terminal:

```bash
bun create elysia ./elysia-example
```

## Development

To start the development server run:

```bash
bun run dev
```

Open http://localhost:3000/ with your browser to see the result.

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
