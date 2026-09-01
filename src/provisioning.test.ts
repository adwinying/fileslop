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

const tunnel = {
  id: 'tunnel-id',
  name: `fileslop:${hostname}`,
  config_src: 'cloudflare',
}

const ingress = [
  ...(['p', 'pt', 'r', 'rt'] as const).map((namespace) => ({
    hostname,
    path: `^/${namespace}(/.*)?$`,
    service: 'http://localhost:3000',
  })),
  { service: 'http_status:404' },
]

const dnsRecord = {
  id: 'dns-record-id',
  type: 'CNAME',
  name: hostname,
  content: `${tunnel.id}.cfargotunnel.com`,
  proxied: true,
  ttl: 1,
  comment: `fileslop:${hostname}`,
}

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

const createInfrastructure = (exists = true, initialIngress = ingress) => {
  let currentTunnel = exists ? tunnel : undefined
  let currentIngress: typeof ingress | undefined = exists
    ? initialIngress
    : undefined
  let currentRecord = exists ? dnsRecord : undefined

  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString()
    const method = init?.method

    if (url.endsWith('/cfd_tunnel?is_deleted=false&per_page=1000')) {
      return jsonResponse(currentTunnel ? [currentTunnel] : [])
    }

    if (url.endsWith('/cfd_tunnel') && method === 'POST') {
      currentTunnel = tunnel
      return jsonResponse(tunnel)
    }

    if (url.endsWith('/cfd_tunnel/tunnel-id/configurations')) {
      if (method === 'PUT') {
        currentIngress = (
          JSON.parse(String(init?.body)) as {
            config: { ingress: typeof ingress }
          }
        ).config.ingress
      }

      return jsonResponse(
        currentIngress === undefined
          ? { config: null }
          : { config: { ingress: currentIngress } },
      )
    }

    if (url.endsWith('/cfd_tunnel/tunnel-id/token')) {
      return jsonResponse('tunnel-token')
    }

    if (url.includes('/zones?')) {
      return jsonResponse([{ id: 'zone-id', name: 'example' }])
    }

    if (url.includes('/zones/zone-id/dns_records?')) {
      return jsonResponse(currentRecord ? [currentRecord] : [])
    }

    if (url.endsWith('/zones/zone-id/dns_records') && method === 'POST') {
      currentRecord = {
        ...dnsRecord,
        ...(JSON.parse(String(init?.body)) as Omit<typeof dnsRecord, 'id'>),
      }
      return jsonResponse(currentRecord)
    }
  }
}

const createFetch = (
  responses: Response[],
  infrastructure = createInfrastructure(),
) => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
  const fetcher = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init })
    const infrastructureResponse = infrastructure(input, init)
    if (infrastructureResponse) return infrastructureResponse
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
    port: 3000,
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
    expect(
      requests.every(({ init }) => init?.signal instanceof AbortSignal),
    ).toBe(true)
    expect(JSON.stringify(applicationWrites.map(requestBody))).not.toContain(
      `${hostname}/p`,
    )
    expect(writes.map(requestBody)).toContainEqual({
      name: `fileslop:${hostname}:idp:One-time PIN`,
      type: 'onetimepin',
      config: {},
    })
  })

  test('creates one remote tunnel, safe ingress, and its DNS record', async () => {
    const { fetch, requests } = createFetch(
      [
        jsonResponse([]),
        jsonResponse(application('r')),
        jsonResponse([]),
        jsonResponse(policy('r')),
        jsonResponse(application('rt')),
        jsonResponse([]),
        jsonResponse(policy('rt')),
        jsonResponse([]),
        jsonResponse(identityProvider()),
        jsonResponse([application('r'), application('rt')]),
        jsonResponse([policy('r')]),
        jsonResponse([policy('rt')]),
        jsonResponse([identityProvider()]),
        jsonResponse(identityProvider()),
      ],
      createInfrastructure(false),
    )

    const result = await provision(fetch)
    const secondResult = await provision(fetch)
    const tunnelCreate = requests.find(
      ({ input, init }) =>
        input.toString().endsWith('/cfd_tunnel') && init?.method === 'POST',
    )
    const ingressUpdate = requests.find(
      ({ input, init }) =>
        input.toString().endsWith('/configurations') && init?.method === 'PUT',
    )
    const dnsCreate = requests.find(
      ({ input, init }) =>
        input.toString().endsWith('/dns_records') && init?.method === 'POST',
    )

    expect(result).toEqual({ tunnelToken: 'tunnel-token' })
    expect(secondResult).toEqual({ tunnelToken: 'tunnel-token' })
    expect(requestBody(tunnelCreate!)).toEqual({
      name: `fileslop:${hostname}`,
      config_src: 'cloudflare',
    })
    expect(requestBody(ingressUpdate!)).toEqual({ config: { ingress } })
    expect(requestBody(dnsCreate!)).toEqual({
      type: 'CNAME',
      name: hostname,
      content: 'tunnel-id.cfargotunnel.com',
      proxied: true,
      ttl: 1,
      comment: `fileslop:${hostname}`,
    })

    const emittedIngress = (
      requestBody(ingressUpdate!).config as { ingress: typeof ingress }
    ).ingress
    const originRules = emittedIngress.filter(
      (rule) => !rule.service.startsWith('http_status:'),
    )
    const writePaths = [
      '/w/',
      ...(['p', 'pt', 'r', 'rt'] as const).flatMap((namespace) => [
        `/w/${namespace}`,
        `/w/${namespace}/file`,
      ]),
    ]
    expect(
      originRules.some((rule) =>
        writePaths.some(
          (path) => !('path' in rule) || new RegExp(rule.path).test(path),
        ),
      ),
    ).toBe(false)
    expect(requests.some(({ init }) => init?.method === 'DELETE')).toBe(false)
    expect(
      requests.filter(
        ({ input, init }) =>
          input.toString().endsWith('/cfd_tunnel') && init?.method === 'POST',
      ),
    ).toHaveLength(1)
    expect(
      requests.filter(
        ({ input, init }) =>
          input.toString().endsWith('/dns_records') && init?.method === 'POST',
      ),
    ).toHaveLength(1)
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

  test('adds read ingress without deleting an existing rule', async () => {
    const operatorRule = {
      hostname: 'operator.example',
      path: '^/status$',
      service: 'http://localhost:4000',
    }
    const { fetch, requests } = createFetch(
      [
        jsonResponse([application('r'), application('rt')]),
        jsonResponse([policy('r')]),
        jsonResponse([policy('rt')]),
        jsonResponse([identityProvider()]),
        jsonResponse(identityProvider()),
      ],
      createInfrastructure(true, [
        operatorRule,
        { service: 'http_status:404' },
      ]),
    )

    await provision(fetch)

    const update = requests.find(
      ({ input, init }) =>
        input.toString().endsWith('/configurations') && init?.method === 'PUT',
    )
    const updatedIngress = (
      requestBody(update!).config as { ingress: unknown[] }
    ).ingress

    expect(updatedIngress).toContainEqual(operatorRule)
    expect(requests.some(({ init }) => init?.method === 'DELETE')).toBe(false)
  })

  test('preserves unknown tunnel configuration fields', async () => {
    const currentIngress = [
      {
        hostname: 'operator.example',
        service: 'http://localhost:4000',
        custom: { value: true },
      },
      { service: 'http_status:404' },
    ]
    const configuration = {
      ingress: currentIngress,
      'warp-routing': { enabled: true },
    }
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const baseInfrastructure = createInfrastructure()
    const infrastructure = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()

      if (url.endsWith('/cfd_tunnel/tunnel-id/configurations')) {
        requests.push({ input, init })
        return jsonResponse({ config: configuration })
      }

      return baseInfrastructure(input, init)
    }
    const { fetch } = createFetch(
      [
        jsonResponse([application('r'), application('rt')]),
        jsonResponse([policy('r')]),
        jsonResponse([policy('rt')]),
        jsonResponse([identityProvider()]),
        jsonResponse(identityProvider()),
      ],
      infrastructure,
    )

    await provision(fetch)

    const update = requests.find(({ init }) => init?.method === 'PUT')
    const updatedConfig = requestBody(update!).config as Record<string, unknown>

    expect(updatedConfig['warp-routing']).toEqual({ enabled: true })
    expect((updatedConfig.ingress as unknown[])[0]).toEqual(currentIngress[0])
  })

  test('routes ingress to the configured server port', async () => {
    const { fetch, requests } = createFetch([
      jsonResponse([application('r'), application('rt')]),
      jsonResponse([policy('r')]),
      jsonResponse([policy('rt')]),
      jsonResponse([identityProvider()]),
      jsonResponse(identityProvider()),
    ])

    await provision(fetch, { port: 4000 })

    const update = requests.find(
      ({ input, init }) =>
        input.toString().endsWith('/configurations') && init?.method === 'PUT',
    )
    const updatedIngress = (
      requestBody(update!).config as { ingress: typeof ingress }
    ).ingress

    expect(
      updatedIngress
        .slice(0, 4)
        .every((rule) => rule.service === 'http://localhost:4000'),
    ).toBe(true)
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

  test("uses the account's One-time PIN without creating another", async () => {
    const { fetch, requests } = createFetch([
      jsonResponse([application('r'), application('rt')]),
      jsonResponse([policy('r')]),
      jsonResponse([policy('rt')]),
      jsonResponse([
        {
          id: 'account-otp',
          name: 'One-time PIN',
          type: 'onetimepin',
          config: {},
        },
      ]),
    ])

    await provision(fetch)

    const providerRequests = requests.filter(({ input }) =>
      input.toString().includes('/access/identity_providers'),
    )

    expect(providerRequests).toHaveLength(1)
    expect(providerRequests[0]?.init?.method).toBe('GET')
  })

  test('surfaces a rejected provider config verbatim', async () => {
    const cloudflareError = 'client_secret is invalid for this provider'
    const { fetch } = createFetch([
      jsonResponse([application('r'), application('rt')]),
      jsonResponse([policy('r')]),
      jsonResponse([policy('rt')]),
      jsonResponse([identityProvider()]),
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
