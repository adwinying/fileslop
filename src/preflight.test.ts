import { describe, expect, mock, test } from 'bun:test'
import { runCloudflarePreflight } from '~/preflight'

const jsonResponse = (result: unknown, resultInfo?: unknown) =>
  Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo ? { result_info: resultInfo } : {}),
  })

const tunnel = {
  id: 'tunnel-id',
  name: 'fileslop:files.example',
  config_src: 'cloudflare',
}

const application = (namespace: 'r' | 'rt', id = `${namespace}-app`) => ({
  id,
  name: `fileslop:files.example:${namespace}`,
  type: 'self_hosted',
  destinations: [{ type: 'public', uri: `files.example/${namespace}/*` }],
})

const policy = (
  namespace: 'r' | 'rt',
  overrides: Record<string, unknown> = {},
) => ({
  id: `${namespace}-policy`,
  name: `fileslop:files.example:${namespace}:allow`,
  decision: 'allow',
  include: [{ email: { email: 'operator@example.com' } }],
  ...overrides,
})

const safeIngress = [
  ...(['p', 'pt', 'r', 'rt'] as const).map((namespace) => ({
    hostname: 'files.example',
    path: `^/${namespace}(/.*)?$`,
    service: 'http://localhost:3000',
  })),
  { service: 'http_status:404' },
]

const createFetch = (responses: Response[]) => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
  const fetcher = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init })
    const response = responses.shift()
    if (!response) throw new Error('Unexpected request')
    return response
  })

  return { fetch: fetcher, requests }
}

describe('Cloudflare preflight', () => {
  test('discovers one account and accepts Access coverage for r and rt', async () => {
    const { fetch, requests } = createFetch([
      jsonResponse([{ id: 'account-id', name: 'Personal' }], {
        total_count: 1,
      }),
      jsonResponse([application('r'), application('rt')]),
      jsonResponse([policy('r')]),
      jsonResponse([policy('rt')]),
      jsonResponse([tunnel]),
      jsonResponse({ config: { ingress: safeIngress } }),
    ])

    await runCloudflarePreflight({
      apiToken: 'token',
      baseUrl: 'https://files.example/base',
      emails: 'operator@example.com',
      fetch,
    })

    expect(requests.map(({ input }) => input.toString())).toEqual([
      'https://api.cloudflare.com/client/v4/accounts?per_page=50',
      'https://api.cloudflare.com/client/v4/accounts/account-id/access/apps?per_page=1000',
      'https://api.cloudflare.com/client/v4/accounts/account-id/access/apps/r-app/policies?per_page=1000',
      'https://api.cloudflare.com/client/v4/accounts/account-id/access/apps/rt-app/policies?per_page=1000',
      'https://api.cloudflare.com/client/v4/accounts/account-id/cfd_tunnel?is_deleted=false&per_page=1000',
      'https://api.cloudflare.com/client/v4/accounts/account-id/cfd_tunnel/tunnel-id/configurations',
    ])
    expect(requests.every(({ init }) => init?.method === 'GET')).toBe(true)
    expect(
      requests.every(
        ({ init }) =>
          (init?.headers as Record<string, string>).authorization ===
          'Bearer token',
      ),
    ).toBe(true)
    expect(
      requests.every(({ init }) => init?.signal instanceof AbortSignal),
    ).toBe(true)
  })

  test('uses an explicit account without listing accounts', async () => {
    const { fetch, requests } = createFetch([
      jsonResponse([application('r'), application('rt')]),
      jsonResponse([policy('r')]),
      jsonResponse([policy('rt')]),
      jsonResponse([tunnel]),
      jsonResponse({ config: { ingress: safeIngress } }),
    ])

    await runCloudflarePreflight({
      accountId: 'configured-account',
      apiToken: 'token',
      baseUrl: 'https://files.example',
      emails: 'operator@example.com',
      fetch,
    })

    expect(requests).toHaveLength(5)
    expect(requests[0]?.input.toString()).toContain(
      '/accounts/configured-account/access/apps',
    )
  })

  test('rejects ambiguous account discovery', async () => {
    const { fetch, requests } = createFetch([
      jsonResponse(
        [
          { id: 'first', name: 'First' },
          { id: 'second', name: 'Second' },
        ],
        { total_count: 2 },
      ),
    ])

    await expect(
      runCloudflarePreflight({
        apiToken: 'token',
        baseUrl: 'https://files.example',
        emails: 'operator@example.com',
        fetch,
      }),
    ).rejects.toThrow(
      'account discovery check: the token can see more than one account; set CLOUDFLARE_ACCOUNT_ID',
    )
    expect(requests).toHaveLength(1)
  })

  test('names the uncovered restricted namespace', async () => {
    const { fetch } = createFetch([jsonResponse([application('r')])])

    await expect(
      runCloudflarePreflight({
        accountId: 'account-id',
        apiToken: 'token',
        baseUrl: 'https://files.example',
        emails: 'operator@example.com',
        fetch,
      }),
    ).rejects.toThrow(
      'Access application coverage check: rt is unprotected on files.example',
    )
  })

  test('rejects ingress that routes the write prefix', async () => {
    const { fetch } = createFetch([
      jsonResponse([application('r'), application('rt')]),
      jsonResponse([policy('r')]),
      jsonResponse([policy('rt')]),
      jsonResponse([tunnel]),
      jsonResponse({
        config: {
          ingress: [
            ...safeIngress.slice(0, -1),
            {
              hostname: 'files.example',
              path: '^/w/p(/.*)?$',
              service: 'http://localhost:3000',
            },
            { service: 'http_status:404' },
          ],
        },
      }),
    ])

    await expect(
      runCloudflarePreflight({
        accountId: 'account-id',
        apiToken: 'token',
        baseUrl: 'https://files.example',
        emails: 'operator@example.com',
        fetch,
      }),
    ).rejects.toThrow('tunnel ingress check: /w/ is routed on files.example')
  })

  test('rejects an owned policy that does not match the allowlist', async () => {
    const { fetch } = createFetch([
      jsonResponse([application('r'), application('rt')]),
      jsonResponse([
        policy('r', {
          include: [{ email: { email: 'someone@example.net' } }],
        }),
      ]),
    ])

    await expect(
      runCloudflarePreflight({
        accountId: 'account-id',
        apiToken: 'token',
        baseUrl: 'https://files.example',
        emails: 'operator@example.com',
        fetch,
      }),
    ).rejects.toThrow(
      'Access policy check: r policy does not match configuration',
    )
  })

  test('rejects a covering application with an Everyone bypass', async () => {
    const broadApplication = {
      id: 'broad-app',
      name: 'operator application',
      type: 'self_hosted',
      domain: 'files.example',
    }
    const { fetch } = createFetch([
      jsonResponse([application('r'), application('rt'), broadApplication]),
      jsonResponse([policy('r')]),
      jsonResponse([policy('rt')]),
      jsonResponse([
        {
          id: 'bypass-policy',
          name: 'Public bypass',
          decision: 'bypass',
          include: [{ everyone: {} }],
        },
      ]),
    ])

    await expect(
      runCloudflarePreflight({
        accountId: 'account-id',
        apiToken: 'token',
        baseUrl: 'https://files.example',
        emails: 'operator@example.com',
        fetch,
      }),
    ).rejects.toThrow('Access policy check: an Everyone bypass covers r and rt')
  })
})
