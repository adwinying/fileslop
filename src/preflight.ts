import { z } from 'zod'

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4'

const apiErrorSchema = z.object({ message: z.string() })
const accountResponseSchema = z.object({
  success: z.literal(true),
  errors: z.array(apiErrorSchema),
  result: z.array(z.object({ id: z.string(), name: z.string() })),
  result_info: z
    .object({ total_count: z.number().int().nonnegative().optional() })
    .optional(),
})
const destinationSchema = z.object({
  type: z.string().optional(),
  uri: z.string().optional(),
})
const applicationResponseSchema = z.object({
  success: z.literal(true),
  errors: z.array(apiErrorSchema),
  result: z.array(
    z.object({
      type: z.string(),
      domain: z.string().optional(),
      destinations: z.array(destinationSchema).optional(),
    }),
  ),
  result_info: z
    .object({ total_count: z.number().int().nonnegative().optional() })
    .optional(),
})

export type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

type PreflightOptions = {
  accountId?: string
  apiToken: string
  baseUrl: string
  fetch: Fetch
}

const escapeRegex = (value: string) =>
  value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')

const wildcardRegex = (value: string, wildcard: string) =>
  value.split('*').map(escapeRegex).join(wildcard)

const destinationCoversNamespace = (
  destination: string,
  hostname: string,
  namespace: 'r' | 'rt',
) => {
  const withoutProtocol = destination.replace(/^https?:\/\//, '')
  const slashIndex = withoutProtocol.indexOf('/')
  const hostnamePattern =
    slashIndex === -1 ? withoutProtocol : withoutProtocol.slice(0, slashIndex)
  const pathPattern = slashIndex === -1 ? '' : withoutProtocol.slice(slashIndex)
  const hostnameRegex = new RegExp(
    `^${wildcardRegex(hostnamePattern, '[^.]*')}$`,
    'i',
  )

  if (!hostnameRegex.test(hostname)) return false

  const namespacePath = `/${namespace}`

  return [
    '',
    '/',
    '/*',
    namespacePath,
    `${namespacePath}/`,
    `${namespacePath}*`,
    `${namespacePath}/*`,
  ].includes(pathPattern)
}

const getApplicationDestinations = (
  application: z.infer<typeof applicationResponseSchema>['result'][number],
) => {
  if (application.destinations !== undefined) {
    return application.destinations.flatMap((destination) =>
      (destination.type === undefined || destination.type === 'public') &&
      destination.uri
        ? [destination.uri]
        : [],
    )
  }

  return application.domain ? [application.domain] : []
}

const getJson = async <Schema extends z.ZodType>(
  url: string,
  apiToken: string,
  fetcher: Fetch,
  schema: Schema,
  check: string,
) => {
  let response: Response

  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiToken}` },
    })
  } catch (error) {
    throw new Error(`Cloudflare preflight failed: ${check}: request failed`, {
      cause: error,
    })
  }

  if (!response.ok) {
    throw new Error(
      `Cloudflare preflight failed: ${check}: Cloudflare returned ${response.status}`,
    )
  }

  let body: unknown

  try {
    body = await response.json()
  } catch (error) {
    throw new Error(
      `Cloudflare preflight failed: ${check}: invalid JSON response`,
      { cause: error },
    )
  }

  const result = schema.safeParse(body)

  if (!result.success) {
    throw new Error(
      `Cloudflare preflight failed: ${check}: invalid Cloudflare response`,
      { cause: result.error },
    )
  }

  return result.data as z.output<Schema>
}

const discoverAccountId = async (apiToken: string, fetcher: Fetch) => {
  const response = await getJson(
    `${CLOUDFLARE_API_URL}/accounts?per_page=50`,
    apiToken,
    fetcher,
    accountResponseSchema,
    'account discovery check',
  )
  const totalCount = response.result_info?.total_count ?? response.result.length

  if (totalCount === 0) {
    throw new Error(
      'Cloudflare preflight failed: account discovery check: the token can see no accounts',
    )
  }

  if (totalCount > 1 || response.result.length > 1) {
    throw new Error(
      'Cloudflare preflight failed: account discovery check: the token can see more than one account; set CLOUDFLARE_ACCOUNT_ID',
    )
  }

  const account = response.result[0]

  if (!account) {
    throw new Error(
      'Cloudflare preflight failed: account discovery check: the account response was empty',
    )
  }

  return account.id
}

export const runCloudflarePreflight = async ({
  accountId,
  apiToken,
  baseUrl,
  fetch: fetcher,
}: PreflightOptions) => {
  const resolvedAccountId =
    accountId ?? (await discoverAccountId(apiToken, fetcher))
  const response = await getJson(
    `${CLOUDFLARE_API_URL}/accounts/${resolvedAccountId}/access/apps?per_page=1000`,
    apiToken,
    fetcher,
    applicationResponseSchema,
    'Access application coverage check',
  )

  if (
    response.result_info?.total_count !== undefined &&
    response.result_info.total_count > response.result.length
  ) {
    throw new Error(
      'Cloudflare preflight failed: Access application coverage check: the application list is incomplete',
    )
  }

  const destinations = response.result
    .filter((application) => application.type === 'self_hosted')
    .flatMap(getApplicationDestinations)
  const hostname = new URL(baseUrl).hostname
  const namespaces = ['r', 'rt'] as const
  const uncovered = namespaces.filter(
    (namespace) =>
      !destinations.some((destination) =>
        destinationCoversNamespace(destination, hostname, namespace),
      ),
  )

  if (uncovered.length > 0) {
    throw new Error(
      `Cloudflare preflight failed: Access application coverage check: ${uncovered.join(
        ' and ',
      )} ${uncovered.length === 1 ? 'is' : 'are'} unprotected on ${hostname}`,
    )
  }
}
