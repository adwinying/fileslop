import type { Fetch } from '~/preflight'
import { describe, expect, mock, test } from 'bun:test'
import { runCloudflareProvisioning } from '~/provisioning'

const hostname = 'files.example'
const accountId = 'account-id'

const application = (namespace: 'r' | 'rt', id = `${namespace}-app`) => ({
  id,
  name: `fileslop:${hostname}:${namespace}`,
  type: 'self_hosted',
  destinations: [{ type: 'public', uri: `${hostname}/${namespace}/*` }],
  session_duration: '24h',
})

const policy = (
  namespace: 'r' | 'rt',
  include: unknown[] = [
    { email: { email: 'operator@example.com' } },
    { email_domain: { domain: 'example.org' } },
  ],
) => ({
  id: `${namespace}-policy`,
  name: `fileslop:${hostname}:${namespace}:allow`,
  decision: 'allow',
  include,
})

const identityProvider = (
  name = 'One-time PIN',
  type = 'onetimepin',
  config: Record<string, unknown> = {},
  id = `${type}-idp`,
) => ({
  id,
  name: `fileslop:${hostname}:idp:${name}`,
  type,
  config,
})

const jsonResponse = (result: unknown, totalCount?: number) =>
  Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(totalCount === undefined
      ? {}
      : { result_info: { total_count: totalCount } }),
  })

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

const provision = (fetcher: Fetch, overrides = {}) =>
  runCloudflareProvisioning({
    accountId,
    apiToken: 'token',
    baseUrl: `https://${hostname}/base`,
    emailDomains: '@example.org',
    emails: ' operator@example.com ',
    fetch: fetcher,
    sessionDuration: '24h',
    ...overrides,
  })

const requestBody = (request: { init?: RequestInit }) =>
  JSON.parse(String(request.init?.body)) as Record<string, unknown>

describe('Cloudflare Access provisioning', () => {
  test('creates only owned r and rt applications and allow policies', async () => {
    const { fetch, requests } = createFetch([
      jsonResponse([]),
      jsonResponse(application('r')),
      jsonResponse([]),
      jsonResponse(policy('r')),
      jsonResponse(application('rt')),
      jsonResponse([]),
      jsonResponse(policy('rt')),
      jsonResponse([]),
      jsonResponse(identityProvider()),
    ])

    await provision(fetch)

    const writes = requests.filter(
      ({ init }) => init?.method === 'POST' || init?.method === 'PUT',
    )
    const applicationWrites = writes.filter(({ input }) =>
      input.toString().endsWith('/access/apps'),
    )
    const policyWrites = writes.filter(({ input }) =>
      input.toString().endsWith('/policies'),
    )

    expect(applicationWrites.map(requestBody)).toEqual([
      {
        name: `fileslop:${hostname}:r`,
        type: 'self_hosted',
        destinations: [{ type: 'public', uri: `${hostname}/r/*` }],
        session_duration: '24h',
      },
      {
        name: `fileslop:${hostname}:rt`,
        type: 'self_hosted',
        destinations: [{ type: 'public', uri: `${hostname}/rt/*` }],
        session_duration: '24h',
      },
    ])
    expect(policyWrites.map(requestBody)).toEqual([
      {
        name: `fileslop:${hostname}:r:allow`,
        decision: 'allow',
        include: [
          { email: { email: 'operator@example.com' } },
          { email_domain: { domain: 'example.org' } },
        ],
      },
      {
        name: `fileslop:${hostname}:rt:allow`,
        decision: 'allow',
        include: [
          { email: { email: 'operator@example.com' } },
          { email_domain: { domain: 'example.org' } },
        ],
      },
    ])
    expect(requests.some(({ init }) => init?.method === 'DELETE')).toBe(false)
    expect(JSON.stringify(applicationWrites.map(requestBody))).not.toContain(
      `${hostname}/p`,
    )
    expect(writes.map(requestBody)).toContainEqual({
      name: `fileslop:${hostname}:idp:One-time PIN`,
      type: 'onetimepin',
      config: {},
    })
  })

  test('does not create a second set when provisioning runs again', async () => {
    const currentApplications = [application('r'), application('rt')]
    const { fetch, requests } = createFetch([
      jsonResponse([]),
      jsonResponse(application('r')),
      jsonResponse([]),
      jsonResponse(policy('r')),
      jsonResponse(application('rt')),
      jsonResponse([]),
      jsonResponse(policy('rt')),
      jsonResponse([]),
      jsonResponse(identityProvider()),
      jsonResponse(currentApplications),
      jsonResponse([policy('r')]),
      jsonResponse([policy('rt')]),
      jsonResponse([identityProvider()]),
      jsonResponse(identityProvider()),
    ])

    await provision(fetch)
    const firstRunRequestCount = requests.length
    await provision(fetch)

    expect(
      requests
        .slice(firstRunRequestCount)
        .every(({ init }) => init?.method === 'GET'),
    ).toBe(true)
    expect(requests.filter(({ init }) => init?.method === 'POST')).toHaveLength(
      5,
    )
  })

  test('reverts owned policy drift without targeting unrelated resources', async () => {
    const { fetch, requests } = createFetch([
      jsonResponse([
        {
          ...application('r'),
          id: 'owned-r-app',
        },
        application('rt', 'owned-rt-app'),
        {
          id: 'unowned-app',
          name: 'operator application',
          type: 'self_hosted',
          destinations: [{ type: 'public', uri: `${hostname}/private/*` }],
          session_duration: '1h',
        },
      ]),
      jsonResponse([
        {
          ...policy('r', [{ email: { email: 'dashboard@example.net' } }]),
          id: 'owned-r-policy',
        },
        {
          id: 'unowned-policy',
          name: 'operator policy',
          decision: 'allow',
          include: [{ everyone: {} }],
        },
      ]),
      jsonResponse(policy('r')),
      jsonResponse([policy('rt')]),
      jsonResponse([]),
      jsonResponse(identityProvider()),
    ])

    await provision(fetch)

    const write = requests.find(({ init }) => init?.method === 'PUT')
    expect(write?.input.toString()).toEndWith(
      '/access/apps/owned-r-app/policies/owned-r-policy',
    )
    expect(requestBody(write!)).toEqual({
      name: `fileslop:${hostname}:r:allow`,
      decision: 'allow',
      include: [
        { email: { email: 'operator@example.com' } },
        { email_domain: { domain: 'example.org' } },
      ],
    })
    expect(
      requests.map(({ input }) => input.toString()).join('\n'),
    ).not.toContain('unowned')
  })

  test('emptied configuration updates in place and never deletes', async () => {
    const { fetch, requests } = createFetch([
      jsonResponse([application('r'), application('rt')]),
      jsonResponse([policy('r')]),
      jsonResponse(policy('r', [])),
      jsonResponse([policy('rt')]),
      jsonResponse(policy('rt', [])),
      jsonResponse([]),
      jsonResponse(identityProvider()),
    ])

    await provision(fetch, { emailDomains: ' , ', emails: '' })

    expect(requests.some(({ init }) => init?.method === 'DELETE')).toBe(false)
    expect(
      requests
        .filter(({ init }) => init?.method === 'PUT')
        .map(requestBody)
        .every((body) => JSON.stringify(body.include) === '[]'),
    ).toBe(true)
  })

  test('creates One-time PIN and passes provider config through unchanged', async () => {
    const config = {
      client_secret: 'secret',
      client_id: 'client-id',
      nested: { prompt: 'login', claims: ['email', 'groups'] },
    }
    const { fetch, requests } = createFetch([
      jsonResponse([application('r'), application('rt')]),
      jsonResponse([policy('r')]),
      jsonResponse([policy('rt')]),
      jsonResponse([]),
      jsonResponse(identityProvider()),
      jsonResponse(identityProvider('Company SSO', 'oidc', config)),
    ])

    await provision(fetch, {
      identityProviders: [{ name: 'Company SSO', type: 'oidc', config }],
    })

    const providerWrites = requests
      .filter(({ input }) =>
        input.toString().includes('/access/identity_providers'),
      )
      .filter(({ init }) => init?.method === 'POST')
      .map(requestBody)

    expect(providerWrites).toEqual([
      {
        name: `fileslop:${hostname}:idp:One-time PIN`,
        type: 'onetimepin',
        config: {},
      },
      {
        name: `fileslop:${hostname}:idp:Company SSO`,
        type: 'oidc',
        config,
      },
    ])
    expect(providerWrites[1]?.config).toEqual(config)
  })

  test('reconciles owned provider drift and leaves removed providers alone', async () => {
    const desiredConfig = { client_id: 'configured' }
    const { fetch, requests } = createFetch([
      jsonResponse([application('r'), application('rt')]),
      jsonResponse([policy('r')]),
      jsonResponse([policy('rt')]),
      jsonResponse([
        identityProvider(),
        identityProvider('Company SSO', 'oidc', { client_id: 'dashboard' }),
        identityProvider('Removed SSO', 'github', { client_id: 'old' }),
        {
          id: 'unowned-idp',
          name: 'Operator provider',
          type: 'github',
        },
      ]),
      jsonResponse(identityProvider()),
      jsonResponse(
        identityProvider('Company SSO', 'oidc', { client_id: 'dashboard' }),
      ),
      jsonResponse(identityProvider('Company SSO', 'oidc', desiredConfig)),
    ])

    await provision(fetch, {
      identityProviders: [
        { name: 'Company SSO', type: 'oidc', config: desiredConfig },
      ],
    })

    const writes = requests.filter(
      ({ init }) => init?.method === 'POST' || init?.method === 'PUT',
    )
    expect(writes).toHaveLength(1)
    expect(writes[0]?.input.toString()).toEndWith(
      '/access/identity_providers/oidc-idp',
    )
    expect(requestBody(writes[0]!)).toEqual({
      name: `fileslop:${hostname}:idp:Company SSO`,
      type: 'oidc',
      config: desiredConfig,
    })
    expect(requests.some(({ init }) => init?.method === 'DELETE')).toBe(false)
    expect(
      requests.map(({ input }) => input.toString()).join('\n'),
    ).not.toContain('unowned-idp')
  })

  test('surfaces a rejected provider config verbatim', async () => {
    const cloudflareError = 'client_secret is invalid for this provider'
    const { fetch } = createFetch([
      jsonResponse([application('r'), application('rt')]),
      jsonResponse([policy('r')]),
      jsonResponse([policy('rt')]),
      jsonResponse([identityProvider()]),
      jsonResponse(identityProvider()),
      Response.json(
        {
          success: false,
          errors: [{ message: cloudflareError }],
          result: null,
        },
        { status: 400 },
      ),
    ])

    await expect(
      provision(fetch, {
        identityProviders: [
          { name: 'Broken SSO', type: 'oidc', config: { bad: true } },
        ],
      }),
    ).rejects.toThrow(new Error(cloudflareError))
  })
})
