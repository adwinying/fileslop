import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'

process.env.BASE_URL = 'https://files.example'

const { createEnvironment } = await import('~/env')
const { start } = await import('~/start')

const temporaryDirectories: string[] = []
const hostname = 'files.example'

const application = (namespace: 'r' | 'rt') => ({
  id: `${namespace}-app`,
  name: `fileslop:${hostname}:${namespace}`,
  type: 'self_hosted',
  destinations: [{ type: 'public', uri: `${hostname}/${namespace}/*` }],
  session_duration: '24h',
})

const policy = (namespace: 'r' | 'rt') => ({
  id: `${namespace}-policy`,
  name: `fileslop:${hostname}:${namespace}:allow`,
  decision: 'allow',
  include: [{ email: { email: 'operator@example.com' } }],
})

const identityProvider = (
  name = 'One-time PIN',
  type = 'onetimepin',
  config: Record<string, unknown> = {},
) => ({
  id: `${type}-idp`,
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

const jsonResponse = (result: unknown) =>
  Response.json({ success: true, errors: [], messages: [], result })

const infrastructureResponse = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const url = input.toString()

  if (url.endsWith('/cfd_tunnel?is_deleted=false&per_page=1000')) {
    return jsonResponse([tunnel])
  }

  if (url.endsWith('/cfd_tunnel/tunnel-id/configurations')) {
    return jsonResponse({ config: { ingress } })
  }

  if (url.endsWith('/cfd_tunnel/tunnel-id/token')) {
    return jsonResponse('tunnel-token')
  }

  if (url.includes('/zones?')) {
    return jsonResponse([{ id: 'zone-id', name: 'example' }])
  }

  if (url.includes('/zones/zone-id/dns_records?')) {
    return jsonResponse([
      {
        id: 'dns-record-id',
        type: 'CNAME',
        name: hostname,
        content: 'tunnel-id.cfargotunnel.com',
        proxied: true,
        ttl: 1,
        comment: `fileslop:${hostname}`,
      },
    ])
  }

  if (init?.method === 'DELETE') throw new Error('Unexpected DELETE request')
}

const existingCloudflareFetch = () =>
  mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const infrastructure = infrastructureResponse(input, init)
    if (infrastructure) return infrastructure

    const url = input.toString()

    if (url.endsWith('/access/apps?per_page=1000')) {
      return jsonResponse([application('r'), application('rt')])
    }

    if (url.includes('/policies')) {
      return jsonResponse([
        url.includes('/r-app/') ? policy('r') : policy('rt'),
      ])
    }

    if (url.endsWith('/access/identity_providers?per_page=1000')) {
      return jsonResponse([identityProvider()])
    }

    if (url.endsWith('/access/identity_providers/onetimepin-idp')) {
      return jsonResponse(identityProvider())
    }

    throw new Error(`Unexpected request: ${url}`)
  })

const configureStartup = async (values: Record<string, string> = {}) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'fileslop-start-'))
  temporaryDirectories.push(storageRoot)
  process.env.STORAGE_ROOT = storageRoot
  delete process.env.CLOUDFLARE_API_TOKEN
  delete process.env.CLOUDFLARE_ACCOUNT_ID
  delete process.env.ACCESS_EMAILS
  delete process.env.ACCESS_EMAIL_DOMAINS
  delete process.env.ACCESS_IDPS
  Object.assign(process.env, values)
}

afterEach(async () => {
  mock.restore()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
  delete process.env.STORAGE_ROOT
  delete process.env.CLOUDFLARE_API_TOKEN
  delete process.env.CLOUDFLARE_ACCOUNT_ID
  delete process.env.ACCESS_EMAILS
  delete process.env.ACCESS_EMAIL_DOMAINS
  delete process.env.ACCESS_IDPS
})

describe('startup', () => {
  test('does not call Cloudflare without a token', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => undefined)
    const fetch = mock(() => {
      throw new Error('Cloudflare should not be called')
    })
    await configureStartup()

    await start({ fetch })

    expect(fetch).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('Cloudflare mode: inactive')
  })

  test('runs preflight before listening', async () => {
    spyOn(console, 'log').mockImplementation(() => undefined)
    spyOn(console, 'error').mockImplementation(() => undefined)
    const responses = [
      Response.json(
        { success: false, errors: [{ message: 'temporary outage' }] },
        { status: 503 },
      ),
      jsonResponse([application('r'), application('rt')]),
      jsonResponse([tunnel]),
      jsonResponse({
        config: {
          ingress: [
            ...ingress.slice(0, -1),
            {
              hostname,
              path: '^/w/p(/.*)?$',
              service: 'http://localhost:3000',
            },
            { service: 'http_status:404' },
          ],
        },
      }),
    ]
    const fetch = mock(async () => responses.shift()!)

    await configureStartup({
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      ACCESS_EMAILS: 'operator@example.com',
    })

    await expect(start({ fetch })).rejects.toThrow(
      'tunnel ingress check: /w/ is routed',
    )

    expect(fetch).toHaveBeenCalledTimes(4)
  })

  test('logs active Cloudflare mode once', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => undefined)
    spyOn(console, 'error').mockImplementation(() => undefined)
    const fetch = existingCloudflareFetch()

    await configureStartup({
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      ACCESS_EMAILS: 'operator@example.com',
    })

    const result = await start({ fetch })

    expect(
      log.mock.calls.filter(([message]) =>
        String(message).startsWith('Cloudflare mode:'),
      ),
    ).toEqual([['Cloudflare mode: active']])
    expect(result.tunnelToken).toBe('tunnel-token')
    expect(JSON.stringify(log.mock.calls)).not.toContain('tunnel-token')
  })

  test('runs preflight after provisioning fails', async () => {
    spyOn(console, 'log').mockImplementation(() => undefined)
    const error = spyOn(console, 'error').mockImplementation(() => undefined)
    const accessResponses = [
      Response.json(
        { success: false, errors: [{ message: 'temporary outage' }] },
        { status: 503 },
      ),
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result: [{ type: 'self_hosted', domain: 'files.example' }],
      }),
    ]
    const fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const infrastructure = infrastructureResponse(input, init)
      if (infrastructure) return infrastructure

      return accessResponses.shift()!
    })

    await configureStartup({
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      ACCESS_EMAILS: 'operator@example.com',
    })

    await start({ fetch })

    expect(fetch).toHaveBeenCalledTimes(4)
    expect(error).toHaveBeenCalledWith(
      'Cloudflare provisioning failed: Access application lookup: temporary outage',
    )
  })

  test('preflight accepts applications created by provisioning', async () => {
    spyOn(console, 'log').mockImplementation(() => undefined)
    const accessResponses = [
      [],
      application('r'),
      [],
      policy('r'),
      application('rt'),
      [],
      policy('rt'),
      [],
      identityProvider('One-time PIN', 'onetimepin', {}),
      identityProvider('Company SSO', 'oidc', { client_id: 'client-id' }),
      [application('r'), application('rt')],
    ].map((result) =>
      Response.json({ success: true, errors: [], messages: [], result }),
    )
    const fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const infrastructure = infrastructureResponse(input, init)
      if (infrastructure) return infrastructure

      return accessResponses.shift()!
    })

    await configureStartup({
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      ACCESS_EMAILS: 'operator@example.com',
      ACCESS_IDPS: JSON.stringify([
        {
          name: 'Company SSO',
          type: 'oidc',
          config: { client_id: 'client-id' },
        },
      ]),
    })

    await start({ fetch })

    expect(fetch).toHaveBeenCalledTimes(18)
  })

  test('rejects a token with no Access allowlist during validation', async () => {
    spyOn(console, 'error').mockImplementation(() => undefined)
    await configureStartup({ CLOUDFLARE_API_TOKEN: 'token' })

    await expect(start()).rejects.toThrow('Invalid environment variables')
  })

  test('parses the ACCESS_IDPS JSON envelope without changing config', () => {
    const config = {
      client_id: 'client-id',
      nested: { prompt: 'login' },
    }

    expect(
      createEnvironment({
        BASE_URL: 'https://files.example',
        ACCESS_IDPS: JSON.stringify([
          { name: 'Company SSO', type: 'oidc', config },
        ]),
      }).ACCESS_IDPS,
    ).toEqual([{ name: 'Company SSO', type: 'oidc', config }])
  })

  test('rejects malformed ACCESS_IDPS JSON', () => {
    spyOn(console, 'error').mockImplementation(() => undefined)

    expect(() =>
      createEnvironment({
        BASE_URL: 'https://files.example',
        ACCESS_IDPS: 'not-json',
      }),
    ).toThrow('Invalid environment variables')
  })
})
