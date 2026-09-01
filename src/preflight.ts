import { z } from 'zod'
import { tryTo } from '~/utils'

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4'
const CLOUDFLARE_REQUEST_TIMEOUT_MS = 10_000
const namespaces = ['r', 'rt'] as const

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
      id: z.string(),
      name: z.string(),
      type: z.string(),
      domain: z.string().optional(),
      destinations: z.array(destinationSchema).optional(),
    }),
  ),
  result_info: z
    .object({ total_count: z.number().int().nonnegative().optional() })
    .optional(),
})
const tunnelResponseSchema = z.object({
  success: z.literal(true),
  errors: z.array(apiErrorSchema),
  result: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      config_src: z.string().optional(),
    }),
  ),
  result_info: z
    .object({ total_count: z.number().int().nonnegative().optional() })
    .optional(),
})
const ingressRuleSchema = z.object({
  hostname: z.string().optional(),
  path: z.string().optional(),
  service: z.string(),
})
const tunnelConfigurationResponseSchema = z.object({
  success: z.literal(true),
  errors: z.array(apiErrorSchema),
  result: z.object({
    // New tunnels return `config: null`.
    config: z
      .object({ ingress: z.array(ingressRuleSchema).optional() })
      .nullish(),
  }),
})
const policyResponseSchema = z.object({
  success: z.literal(true),
  errors: z.array(apiErrorSchema),
  result: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      decision: z.string(),
      include: z.array(z.record(z.string(), z.unknown())),
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
  emailDomains?: string
  emails?: string
  fetch: Fetch
}

type Namespace = (typeof namespaces)[number]

type AccessRule =
  { email: { email: string } } | { email_domain: { domain: string } }

const splitValues = (value?: string) =>
  value
    ?.split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0) ?? []

const ownedApplicationName = (hostname: string, namespace: Namespace) =>
  `fileslop:${hostname}:${namespace}`

const ownedPolicyName = (hostname: string, namespace: Namespace) =>
  `${ownedApplicationName(hostname, namespace)}:allow`

const expectedRules = (
  emails?: string,
  emailDomains?: string,
): AccessRule[] => [
  ...splitValues(emails).map((email) => ({ email: { email } })),
  ...splitValues(emailDomains).map((domain) => ({
    email_domain: { domain: domain.replace(/^@/, '') },
  })),
]

const ruleKey = (rule: Record<string, unknown>) => JSON.stringify(rule)

const policyMatches = (
  policy: z.infer<typeof policyResponseSchema>['result'][number],
  name: string,
  include: AccessRule[],
) => {
  const currentRules = policy.include.map(ruleKey).sort()
  const expected = include.map(ruleKey).sort()

  return (
    policy.name === name &&
    policy.decision === 'allow' &&
    currentRules.length === expected.length &&
    currentRules.every((rule, index) => rule === expected[index])
  )
}

const hasEveryoneBypass = (
  policies: z.infer<typeof policyResponseSchema>['result'],
) =>
  policies.some(
    (policy) =>
      policy.decision === 'bypass' &&
      policy.include.some((rule) => 'everyone' in rule),
  )

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

const ingressHostnameMatches = (
  pattern: string | undefined,
  hostname: string,
) =>
  pattern === undefined ||
  new RegExp(`^${wildcardRegex(pattern, '[^.]*')}$`, 'i').test(hostname)

const ingressPathMatches = (pattern: string | undefined, path: string) => {
  if (pattern === undefined) return true

  const [regex, error] = tryTo(() => new RegExp(pattern))
  return error === null ? regex.test(path) : true
}

const routeFor = (
  ingress: z.infer<typeof ingressRuleSchema>[],
  hostname: string,
  path: string,
) =>
  ingress.find(
    (rule) =>
      ingressHostnameMatches(rule.hostname, hostname) &&
      ingressPathMatches(rule.path, path),
  )

const routesToOrigin = (rule: z.infer<typeof ingressRuleSchema> | undefined) =>
  rule !== undefined && !rule.service.startsWith('http_status:')

const getJson = async <Schema extends z.ZodType>(
  url: string,
  apiToken: string,
  fetcher: Fetch,
  schema: Schema,
  check: string,
) => {
  const [response, requestError] = await tryTo(
    fetcher(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(CLOUDFLARE_REQUEST_TIMEOUT_MS),
    }),
  )

  if (requestError !== null) {
    throw new Error(`Cloudflare preflight failed: ${check}: request failed`, {
      cause: requestError,
    })
  }

  if (!response.ok) {
    throw new Error(
      `Cloudflare preflight failed: ${check}: Cloudflare returned ${response.status}`,
    )
  }

  const [body, jsonError] = await tryTo(response.json() as Promise<unknown>)

  if (jsonError !== null) {
    throw new Error(
      `Cloudflare preflight failed: ${check}: invalid JSON response`,
      { cause: jsonError },
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
  emailDomains,
  emails,
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

  const hostname = new URL(baseUrl).hostname
  const applications = response.result
    .filter((application) => application.type === 'self_hosted')
    .map((application) => ({
      application,
      namespaces: namespaces.filter((namespace) =>
        getApplicationDestinations(application).some((destination) =>
          destinationCoversNamespace(destination, hostname, namespace),
        ),
      ),
    }))
    .filter(({ namespaces: coveredNamespaces }) => coveredNamespaces.length > 0)
  const uncovered = namespaces.filter(
    (namespace) =>
      !applications.some(({ namespaces: covered }) =>
        covered.includes(namespace),
      ),
  )

  if (uncovered.length > 0) {
    throw new Error(
      `Cloudflare preflight failed: Access application coverage check: ${uncovered.join(
        ' and ',
      )} ${uncovered.length === 1 ? 'is' : 'are'} unprotected on ${hostname}`,
    )
  }

  const include = expectedRules(emails, emailDomains)
  const validatedPolicies = new Set<Namespace>()

  for (const { application, namespaces: covered } of applications) {
    const policies = await getJson(
      `${CLOUDFLARE_API_URL}/accounts/${resolvedAccountId}/access/apps/${application.id}/policies?per_page=1000`,
      apiToken,
      fetcher,
      policyResponseSchema,
      'Access policy check',
    )

    if (
      policies.result_info?.total_count !== undefined &&
      policies.result_info.total_count > policies.result.length
    ) {
      throw new Error(
        'Cloudflare preflight failed: Access policy check: the policy list is incomplete',
      )
    }

    if (hasEveryoneBypass(policies.result)) {
      throw new Error(
        `Cloudflare preflight failed: Access policy check: an Everyone bypass covers ${covered.join(
          ' and ',
        )}`,
      )
    }

    for (const namespace of covered) {
      if (application.name !== ownedApplicationName(hostname, namespace)) {
        continue
      }

      const expectedName = ownedPolicyName(hostname, namespace)
      const ownedPolicies = policies.result.filter(
        (policy) => policy.name === expectedName,
      )

      if (
        policies.result.length !== 1 ||
        ownedPolicies.length !== 1 ||
        !policyMatches(ownedPolicies[0]!, expectedName, include)
      ) {
        throw new Error(
          `Cloudflare preflight failed: Access policy check: ${namespace} policy does not match configuration`,
        )
      }

      validatedPolicies.add(namespace)
    }
  }

  const missingPolicies = namespaces.filter(
    (namespace) => !validatedPolicies.has(namespace),
  )

  if (missingPolicies.length > 0) {
    throw new Error(
      `Cloudflare preflight failed: Access policy check: expected one owned application and policy for ${missingPolicies.join(
        ' and ',
      )}`,
    )
  }

  const tunnelName = `fileslop:${hostname}`
  const tunnels = await getJson(
    `${CLOUDFLARE_API_URL}/accounts/${resolvedAccountId}/cfd_tunnel?is_deleted=false&per_page=1000`,
    apiToken,
    fetcher,
    tunnelResponseSchema,
    'tunnel ingress check',
  )

  if (
    tunnels.result_info?.total_count !== undefined &&
    tunnels.result_info.total_count > tunnels.result.length
  ) {
    throw new Error(
      'Cloudflare preflight failed: tunnel ingress check: the tunnel list is incomplete',
    )
  }

  const ownedTunnels = tunnels.result.filter(
    (tunnel) => tunnel.name === tunnelName,
  )

  if (ownedTunnels.length !== 1) {
    throw new Error(
      `Cloudflare preflight failed: tunnel ingress check: expected one owned tunnel for ${hostname}`,
    )
  }

  const tunnel = ownedTunnels[0]!

  if (tunnel.config_src !== undefined && tunnel.config_src !== 'cloudflare') {
    throw new Error(
      'Cloudflare preflight failed: tunnel ingress check: the owned tunnel is not remotely managed',
    )
  }

  const configuration = await getJson(
    `${CLOUDFLARE_API_URL}/accounts/${resolvedAccountId}/cfd_tunnel/${tunnel.id}/configurations`,
    apiToken,
    fetcher,
    tunnelConfigurationResponseSchema,
    'tunnel ingress check',
  )
  const ingress = configuration.result.config?.ingress ?? []
  const unroutedReads = (['p', 'pt', 'r', 'rt'] as const).filter(
    (namespace) =>
      !routesToOrigin(routeFor(ingress, hostname, `/${namespace}/file`)),
  )

  if (unroutedReads.length > 0) {
    throw new Error(
      `Cloudflare preflight failed: tunnel ingress check: ${unroutedReads.join(
        ' and ',
      )} ${unroutedReads.length === 1 ? 'is' : 'are'} not routed on ${hostname}`,
    )
  }

  const safeReadPaths = new Set(
    (['p', 'pt', 'r', 'rt'] as const).map(
      (namespace) => `^/${namespace}(/.*)?$`,
    ),
  )
  const unsafeOriginRule = ingress.find(
    (rule) =>
      routesToOrigin(rule) &&
      ingressHostnameMatches(rule.hostname, hostname) &&
      (rule.path === undefined || !safeReadPaths.has(rule.path)),
  )

  if (unsafeOriginRule) {
    throw new Error(
      `Cloudflare preflight failed: tunnel ingress check: /w/ is routed on ${hostname}`,
    )
  }
}
