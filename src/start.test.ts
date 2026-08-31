import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'

process.env.BASE_URL = 'https://files.example'

const { createEnvironment } = await import('~/env')
const { start } = await import('~/start')

const temporaryDirectories: string[] = []

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
    const fetch = mock(async () =>
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result: [{ type: 'self_hosted', domain: 'files.example/r/*' }],
      }),
    )

    await configureStartup({
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      ACCESS_EMAILS: 'operator@example.com',
    })

    await expect(start({ fetch })).rejects.toThrow(
      'Access application coverage check',
    )

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('logs active Cloudflare mode once', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => undefined)
    const fetch = mock(async () =>
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result: [{ type: 'self_hosted', domain: 'files.example' }],
      }),
    )

    await configureStartup({
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      ACCESS_EMAIL_DOMAINS: 'example.com',
    })

    await start({ fetch })

    expect(
      log.mock.calls.filter(([message]) =>
        String(message).startsWith('Cloudflare mode:'),
      ),
    ).toEqual([['Cloudflare mode: active']])
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
