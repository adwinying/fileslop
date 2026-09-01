import { describe, expect, test } from 'bun:test'
import {
  VerificationError,
  verifyExternal,
  verifyInternal,
  verifyRoundTrip,
} from '~/verify'

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

  test('fails when a public namespace returns an unexpected status', async () => {
    const fetcher = async (input: RequestInfo | URL) => {
      const namespace = new URL(input.toString()).pathname.split('/')[1]

      return ['r', 'rt'].includes(namespace ?? '')
        ? accessChallenge()
        : new Response('Unavailable\n', { status: 503 })
    }

    await expect(
      verifyExternal({
        deployedUrl: 'https://files.example',
        fetcher,
      }),
    ).rejects.toThrow('GET /p/ returned unexpected status (503)')
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

describe('round-trip verification', () => {
  test('uploads and fetches back matching bytes', async () => {
    const requestedPaths: string[] = []
    let uploadedContents: ArrayBuffer | undefined
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      requestedPaths.push(url.pathname)

      if (url.pathname === '/w/p') {
        const form = init?.body as FormData
        const file = form.get('file') as File
        uploadedContents = await file.arrayBuffer()
        return new Response('http://origin.example:3000/p/abc1234.bin\n', {
          status: 201,
        })
      }

      return new Response(uploadedContents, { status: 200 })
    }

    await expect(
      verifyRoundTrip({
        originUrl: 'http://origin.example:3000',
        fetcher,
      }),
    ).resolves.toBe('passed')
    expect(requestedPaths).toEqual(['/w/p', '/p/abc1234.bin'])
  })

  test('fails when the upload fails', async () => {
    const fetcher = async () =>
      new Response('Storage failure\n', { status: 500 })

    await expect(
      verifyRoundTrip({
        originUrl: 'http://origin.example:3000',
        fetcher,
      }),
    ).rejects.toThrow('POST /w/p returned unexpected status (500)')
  })

  test('fails when the uploaded file is not found', async () => {
    let calls = 0
    const fetcher = async () => {
      calls += 1
      return calls === 1
        ? new Response('http://origin.example:3000/p/abc1234.bin\n', {
            status: 201,
          })
        : new Response('Not Found\n', { status: 404 })
    }

    await expect(
      verifyRoundTrip({
        originUrl: 'http://origin.example:3000',
        fetcher,
      }),
    ).rejects.toThrow('GET uploaded file returned unexpected status (404)')
  })

  test('fails when the downloaded bytes do not match', async () => {
    let calls = 0
    const fetcher = async () => {
      calls += 1
      return calls === 1
        ? new Response('http://origin.example:3000/p/abc1234.bin\n', {
            status: 201,
          })
        : new Response('different', { status: 200 })
    }

    await expect(
      verifyRoundTrip({
        originUrl: 'http://origin.example:3000',
        fetcher,
      }),
    ).rejects.toThrow('GET uploaded file returned different bytes')
  })

  test('fails when the origin is unreachable', async () => {
    const fetcher = async () => {
      throw new TypeError('Unable to connect')
    }

    await expect(
      verifyRoundTrip({
        originUrl: 'http://origin.example:3000',
        fetcher,
      }),
    ).rejects.toThrow('POST /w/p failed: Unable to connect')
  })
})
