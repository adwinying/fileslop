import { tryTo } from '~/utils'

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

type Logger = Pick<Console, 'log' | 'warn'>

type VerifyOptions = {
  fetcher?: Fetcher
  logger?: Logger
  timeoutMs?: number
}

type ExternalVerifyOptions = VerifyOptions & {
  deployedUrl: string
}

type InternalVerifyOptions = VerifyOptions & {
  originUrl: string
}

export class VerificationError extends Error {}

const namespaces = ['p', 'pt', 'r', 'rt'] as const
const probeFilename = 'verify00.txt'

const urlFor = (baseUrl: string, path: string) => new URL(path, baseUrl)

const request = (
  fetcher: Fetcher,
  url: URL,
  timeoutMs: number,
  init: RequestInit = {},
) =>
  fetcher(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    ...init,
  })

const isAccessChallenge = (response: Response) => {
  if (![301, 302, 303, 307, 308].includes(response.status)) return false

  const location = response.headers.get('location')
  if (location === null) return false

  const [url, error] = tryTo(() => new URL(location))
  if (error !== null) return false

  return (
    url.hostname.endsWith('.cloudflareaccess.com') &&
    url.pathname.startsWith('/cdn-cgi/access/login/')
  )
}

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export const verifyExternal = async ({
  deployedUrl,
  fetcher = fetch,
  logger = console,
  timeoutMs = 5_000,
}: ExternalVerifyOptions) => {
  for (const namespace of ['r', 'rt'] as const) {
    const response = await request(
      fetcher,
      urlFor(deployedUrl, `/${namespace}/${probeFilename}`),
      timeoutMs,
    )

    if (!isAccessChallenge(response)) {
      throw new VerificationError(
        `GET /${namespace}/ did not challenge for Cloudflare Access (${response.status})`,
      )
    }

    logger.log(`PASS GET /${namespace}/ challenges for Cloudflare Access`)
  }

  for (const namespace of ['p', 'pt'] as const) {
    const response = await request(
      fetcher,
      urlFor(deployedUrl, `/${namespace}/${probeFilename}`),
      timeoutMs,
    )

    if (isAccessChallenge(response)) {
      throw new VerificationError(
        `GET /${namespace}/ unexpectedly challenged for Cloudflare Access`,
      )
    }

    logger.log(
      `PASS GET /${namespace}/ does not challenge for Cloudflare Access`,
    )
  }

  const writeResponse = await request(
    fetcher,
    urlFor(deployedUrl, '/w/p'),
    timeoutMs,
    { method: 'POST', body: new FormData() },
  )

  if (writeResponse.status !== 404) {
    throw new VerificationError(
      `POST /w/p resolved through the tunnel (${writeResponse.status})`,
    )
  }

  logger.log('PASS /w/ does not resolve through the tunnel')

  return 'passed' as const
}

export const verifyInternal = async ({
  originUrl,
  fetcher = fetch,
  logger = console,
  timeoutMs = 5_000,
}: InternalVerifyOptions) => {
  const results = await Promise.all(
    namespaces.map(async (namespace) => {
      const [response, error] = await tryTo(
        request(fetcher, urlFor(originUrl, `/w/${namespace}`), timeoutMs, {
          method: 'POST',
          body: new FormData(),
        }),
      )

      return error === null
        ? ({ namespace, response } as const)
        : ({ namespace, error } as const)
    }),
  )
  const responses = results.filter((result) => 'response' in result)

  if (responses.length === 0) {
    logger.warn('SKIPPED Internal checks: tailnet origin is unreachable')
    return 'skipped' as const
  }

  for (const result of results) {
    if ('error' in result) {
      throw new VerificationError(
        `POST /w/${result.namespace} failed: ${describeError(result.error)}`,
      )
    }

    if (result.response.status !== 422) {
      throw new VerificationError(
        `POST /w/${result.namespace} did not reach the write handler (${result.response.status})`,
      )
    }

    logger.log(`PASS POST /w/${result.namespace} reaches the write handler`)
  }

  return 'passed' as const
}
