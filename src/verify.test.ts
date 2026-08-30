import { describe, expect, test } from 'bun:test'
import { VerificationError, verifyExternal, verifyInternal } from '~/verify'

const accessChallenge = () =>
  new Response(null, {
    status: 302,
    headers: {
      location:
        'https://files.cloudflareaccess.com/cdn-cgi/access/login/app-id',
    },
  })

const createLogger = () => {
  const logs: string[] = []
  const warnings: string[] = []

  return {
    logs,
    warnings,
    logger: {
      log: (message: string) => logs.push(message),
      warn: (message: string) => warnings.push(message),
    },
  }
}

const externalFetcher = async (input: RequestInfo | URL) => {
  const url = new URL(input.toString())

  if (['r', 'rt'].includes(url.pathname.split('/')[1] ?? '')) {
    return accessChallenge()
  }

  return new Response('Not Found\n', { status: 404 })
}

describe('external verification', () => {
  test('checks access and write routing', async () => {
    await expect(
      verifyExternal({
        deployedUrl: 'https://files.example',
        fetcher: externalFetcher,
      }),
    ).resolves.toBe('passed')
  })

  test('fails when a restricted namespace does not challenge', async () => {
    const fetcher = async () => new Response('Not Found\n', { status: 404 })

    await expect(
      verifyExternal({
        deployedUrl: 'https://files.example',
        fetcher,
      }),
    ).rejects.toThrow('GET /r/ did not challenge for Cloudflare Access (404)')
  })

  test('fails when the write prefix reaches an HTTP service', async () => {
    const routedFetcher = async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())

      if (url.pathname === '/w/p') return new Response(null, { status: 422 })
      return externalFetcher(input)
    }

    await expect(
      verifyExternal({
        deployedUrl: 'https://files.example',
        fetcher: routedFetcher,
      }),
    ).rejects.toThrow('POST /w/p resolved through the tunnel (422)')
  })
})

describe('internal verification', () => {
  test('checks every write handler without storing a file', async () => {
    const requestedPaths: string[] = []
    const fetcher = async (input: RequestInfo | URL) => {
      requestedPaths.push(new URL(input.toString()).pathname)
      return new Response(null, { status: 422 })
    }

    await expect(
      verifyInternal({
        originUrl: 'http://origin.example:3000',
        fetcher,
      }),
    ).resolves.toBe('passed')
    expect(requestedPaths).toEqual(['/w/p', '/w/pt', '/w/r', '/w/rt'])
  })

  test('skips loudly when the tailnet origin is unreachable', async () => {
    const { logger, warnings } = createLogger()
    const fetcher = async () => {
      throw new TypeError('Unable to connect')
    }

    await expect(
      verifyInternal({
        originUrl: 'http://origin.example:3000',
        fetcher,
        logger,
      }),
    ).resolves.toBe('skipped')
    expect(warnings).toEqual([
      'SKIPPED Internal checks: tailnet origin is unreachable',
    ])
  })

  test('fails on partial tailnet connectivity', async () => {
    let calls = 0
    const fetcher = async () => {
      calls += 1
      if (calls === 4) throw new TypeError('Connection lost')
      return new Response(null, { status: 422 })
    }

    await expect(
      verifyInternal({
        originUrl: 'http://origin.example:3000',
        fetcher,
      }),
    ).rejects.toBeInstanceOf(VerificationError)
  })
})
