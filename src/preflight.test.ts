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
      jsonResponse([
        {
          type: 'self_hosted',
          destinations: [
            { type: 'public', uri: 'files.example/r/*' },
            { type: 'public', uri: 'files.example/rt/*' },
          ],
        },
      ]),
    ])

    await runCloudflarePreflight({
      apiToken: 'token',
      baseUrl: 'https://files.example/base',
      fetch,
    })

    expect(requests.map(({ input }) => input.toString())).toEqual([
      'https://api.cloudflare.com/client/v4/accounts?per_page=50',
      'https://api.cloudflare.com/client/v4/accounts/account-id/access/apps?per_page=1000',
    ])
    expect(requests.every(({ init }) => init?.method === 'GET')).toBe(true)
    expect(
      requests.every(
        ({ init }) =>
          (init?.headers as Record<string, string>).authorization ===
          'Bearer token',
      ),
    ).toBe(true)
  })

  test('uses an explicit account without listing accounts', async () => {
    const { fetch, requests } = createFetch([
      jsonResponse([{ type: 'self_hosted', domain: 'files.example' }]),
    ])

    await runCloudflarePreflight({
      accountId: 'configured-account',
      apiToken: 'token',
      baseUrl: 'https://files.example',
      fetch,
    })

    expect(requests).toHaveLength(1)
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
        fetch,
      }),
    ).rejects.toThrow(
      'account discovery check: the token can see more than one account; set CLOUDFLARE_ACCOUNT_ID',
    )
    expect(requests).toHaveLength(1)
  })

  test('names the uncovered restricted namespace', async () => {
    const { fetch } = createFetch([
      jsonResponse([{ type: 'self_hosted', domain: 'files.example/r/*' }]),
    ])

    await expect(
      runCloudflarePreflight({
        accountId: 'account-id',
        apiToken: 'token',
        baseUrl: 'https://files.example',
        fetch,
      }),
    ).rejects.toThrow(
      'Access application coverage check: rt is unprotected on files.example',
    )
  })
})
