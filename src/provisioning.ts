import type { Fetch } from '~/preflight'
import { z } from 'zod'
import { tryTo } from '~/utils'

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4'
const CLOUDFLARE_REQUEST_TIMEOUT_MS = 10_000
const namespaces = ['r', 'rt'] as const
const readNamespaces = ['p', 'pt', 'r', 'rt'] as const

const apiErrorSchema = z.object({ message: z.string() })
const resultInfoSchema = z
  .object({ total_count: z.number().int().nonnegative().optional() })
  .optional()
const destinationSchema = z.object({
  type: z.string().optional(),
  uri: z.string().optional(),
})
const applicationSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  domain: z.string().optional(),
  destinations: z.array(destinationSchema).optional(),
  session_duration: z.string().optional(),
})
const policySchema = z.object({
  id: z.string(),
  name: z.string(),
  decision: z.string(),
  include: z.array(z.record(z.string(), z.unknown())),
})
const identityProviderSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
})
const identityProviderSchema = identityProviderSummarySchema.extend({
  config: z.record(z.string(), z.unknown()),
})
const tunnelSchema = z.object({
  id: z.string(),
  name: z.string(),
  config_src: z.string().optional(),
})
const ingressRuleSchema = z.looseObject({
  hostname: z.string().optional(),
  path: z.string().optional(),
  service: z.string(),
  originRequest: z.record(z.string(), z.unknown()).optional(),
})
const tunnelConfigurationSchema = z.object({
  // New tunnels return `config: null`.
  config: z
    .looseObject({
      ingress: z.array(ingressRuleSchema).optional(),
      originRequest: z.record(z.string(), z.unknown()).optional(),
    })
    .nullish(),
})
const zoneSchema = z.object({ id: z.string(), name: z.string() })
const dnsRecordSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string(),
  proxied: z.boolean().optional(),
  ttl: z.number().optional(),
  comment: z.string().optional(),
})

const responseSchema = <Result extends z.ZodType>(result: Result) =>
  z.object({
    success: z.literal(true),
    errors: z.array(apiErrorSchema).optional(),
    result,
    result_info: resultInfoSchema,
  })

const accountListSchema = responseSchema(
  z.array(z.object({ id: z.string(), name: z.string() })),
)
const applicationListSchema = responseSchema(z.array(applicationSchema))
const applicationSchemaResponse = responseSchema(applicationSchema)
const policyListSchema = responseSchema(z.array(policySchema))
const policySchemaResponse = responseSchema(policySchema)
const identityProviderListSchema = responseSchema(
  z.array(identityProviderSummarySchema),
)
const identityProviderSchemaResponse = responseSchema(identityProviderSchema)
const tunnelListSchema = responseSchema(z.array(tunnelSchema))
const tunnelSchemaResponse = responseSchema(tunnelSchema)
const tunnelTokenSchema = responseSchema(z.string().min(1))
const tunnelConfigurationSchemaResponse = responseSchema(
  tunnelConfigurationSchema,
)
const zoneListSchema = responseSchema(z.array(zoneSchema))
const dnsRecordListSchema = responseSchema(z.array(dnsRecordSchema))
const dnsRecordSchemaResponse = responseSchema(dnsRecordSchema)

type IdentityProvider = {
  name: string
  type: string
  config: Record<string, unknown>
}

type ProvisioningOptions = {
  accountId?: string
  apiToken: string
  baseUrl: string
  emailDomains?: string
  emails?: string
  fetch: Fetch
  identityProviders?: IdentityProvider[]
  port: number
  sessionDuration: string
}

type CloudflareRequestOptions<Schema extends z.ZodType> = {
  apiToken: string
  body?: unknown
  fetch: Fetch
  method: 'GET' | 'POST' | 'PUT'
  path: string
  schema: Schema
  task: string
  verbatimApiError?: boolean
}

type AccessRule =
  { email: { email: string } } | { email_domain: { domain: string } }

const splitValues = (value?: string) =>
  value
    ?.split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0) ?? []

const ownedApplicationName = (hostname: string, namespace: 'r' | 'rt') =>
  `fileslop:${hostname}:${namespace}`

const ownedPolicyName = (hostname: string, namespace: 'r' | 'rt') =>
  `${ownedApplicationName(hostname, namespace)}:allow`

const ownedIdentityProviderName = (hostname: string, name: string) =>
  `fileslop:${hostname}:idp:${name}`

const ownedTunnelName = (hostname: string) => `fileslop:${hostname}`

const parseCloudflareErrors = (body: unknown) => {
  const result = z.object({ errors: z.array(apiErrorSchema) }).safeParse(body)

  return result.success
    ? result.data.errors.map(({ message }) => message).join('; ')
    : undefined
}

const cloudflareRequest = async <Schema extends z.ZodType>({
  apiToken,
  body,
  fetch: fetcher,
  method,
  path,
  schema,
  task,
  verbatimApiError = false,
}: CloudflareRequestOptions<Schema>) => {
  const [response, requestError] = await tryTo(
    fetcher(`${CLOUDFLARE_API_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      signal: AbortSignal.timeout(CLOUDFLARE_REQUEST_TIMEOUT_MS),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

  if (requestError !== null) {
    throw new Error(`Cloudflare provisioning failed: ${task}: request failed`, {
      cause: requestError,
    })
  }

  const [responseBody, jsonError] = await tryTo(
    response.json() as Promise<unknown>,
  )

  if (jsonError !== null) {
    throw new Error(
      `Cloudflare provisioning failed: ${task}: invalid JSON response`,
      { cause: jsonError },
    )
  }

  if (!response.ok) {
    const cloudflareErrors = parseCloudflareErrors(responseBody)

    if (verbatimApiError && cloudflareErrors) {
      throw new Error(cloudflareErrors)
    }

    throw new Error(
      `Cloudflare provisioning failed: ${task}: ${
        cloudflareErrors || `Cloudflare returned ${response.status}`
      }`,
    )
  }

  const result = schema.safeParse(responseBody)

  if (!result.success) {
    throw new Error(
      `Cloudflare provisioning failed: ${task}: invalid Cloudflare response`,
      { cause: result.error },
    )
  }

  return result.data as z.output<Schema>
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    )

    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }

  return JSON.stringify(value) ?? 'undefined'
}

const desiredReadIngress = (hostname: string, port: number) =>
  readNamespaces.map((namespace) => ({
    hostname,
    path: `^/${namespace}(/.*)?$`,
    service: `http://localhost:${port}`,
  }))

const reconcileIngress = (
  current: z.infer<typeof ingressRuleSchema>[],
  hostname: string,
  port: number,
) => {
  const readRules = desiredReadIngress(hostname, port)
  const next = [...current]
  const terminalIndex = next.findIndex(
    (rule) => rule.hostname === undefined && rule.path === undefined,
  )
  let insertionIndex = terminalIndex === -1 ? next.length : terminalIndex

  for (const rule of readRules) {
    const ownedIndex = next.findIndex(
      (candidate) =>
        candidate.hostname === rule.hostname && candidate.path === rule.path,
    )

    if (ownedIndex === -1) {
      next.splice(insertionIndex, 0, rule)
      insertionIndex += 1
    } else if (canonicalJson(next[ownedIndex]) !== canonicalJson(rule)) {
      next[ownedIndex] = rule
    }
  }

  if (terminalIndex === -1) next.push({ service: 'http_status:404' })

  return next
}

const reconcileTunnel = async ({
  accountId,
  apiToken,
  fetch: fetcher,
  hostname,
  port,
}: {
  accountId: string
  apiToken: string
  fetch: Fetch
  hostname: string
  port: number
}) => {
  const tunnelsPath = `/accounts/${accountId}/cfd_tunnel`
  const tunnels = await cloudflareRequest({
    apiToken,
    fetch: fetcher,
    method: 'GET',
    path: `${tunnelsPath}?is_deleted=false&per_page=1000`,
    schema: tunnelListSchema,
    task: 'tunnel lookup',
  })
  assertCompleteList(
    tunnels.result.length,
    tunnels.result_info?.total_count,
    'tunnel lookup',
  )

  const name = ownedTunnelName(hostname)
  const ownedTunnels = tunnels.result.filter((tunnel) => tunnel.name === name)

  if (ownedTunnels.length > 1) {
    throw new Error(
      'Cloudflare provisioning failed: tunnel lookup: more than one owned tunnel exists',
    )
  }

  const current = ownedTunnels[0]
  const tunnel =
    current ??
    (
      await cloudflareRequest({
        apiToken,
        body: { name, config_src: 'cloudflare' },
        fetch: fetcher,
        method: 'POST',
        path: tunnelsPath,
        schema: tunnelSchemaResponse,
        task: 'tunnel creation',
      })
    ).result

  if (tunnel.config_src !== undefined && tunnel.config_src !== 'cloudflare') {
    throw new Error(
      'Cloudflare provisioning failed: tunnel lookup: the owned tunnel is not remotely managed',
    )
  }

  const configurationPath = `${tunnelsPath}/${tunnel.id}/configurations`
  const configuration = await cloudflareRequest({
    apiToken,
    fetch: fetcher,
    method: 'GET',
    path: configurationPath,
    schema: tunnelConfigurationSchemaResponse,
    task: 'tunnel ingress lookup',
  })
  const currentConfig = configuration.result.config ?? {}
  const currentIngress = currentConfig.ingress ?? []
  const ingress = reconcileIngress(currentIngress, hostname, port)

  if (canonicalJson(ingress) !== canonicalJson(currentIngress)) {
    await cloudflareRequest({
      apiToken,
      body: {
        config: {
          ...currentConfig,
          ingress,
        },
      },
      fetch: fetcher,
      method: 'PUT',
      path: configurationPath,
      schema: tunnelConfigurationSchemaResponse,
      task: 'tunnel ingress update',
    })
  }

  const token = await cloudflareRequest({
    apiToken,
    fetch: fetcher,
    method: 'GET',
    path: `${tunnelsPath}/${tunnel.id}/token`,
    schema: tunnelTokenSchema,
    task: 'tunnel token lookup',
  })

  return { id: tunnel.id, token: token.result }
}

const reconcileDnsRecord = async ({
  accountId,
  apiToken,
  fetch: fetcher,
  hostname,
  tunnelId,
}: {
  accountId: string
  apiToken: string
  fetch: Fetch
  hostname: string
  tunnelId: string
}) => {
  const zones = await cloudflareRequest({
    apiToken,
    fetch: fetcher,
    method: 'GET',
    path: `/zones?account.id=${encodeURIComponent(accountId)}&per_page=50`,
    schema: zoneListSchema,
    task: 'DNS zone lookup',
  })
  assertCompleteList(
    zones.result.length,
    zones.result_info?.total_count,
    'DNS zone lookup',
  )

  const matchingZones = zones.result
    .filter(
      (zone) => hostname === zone.name || hostname.endsWith(`.${zone.name}`),
    )
    .sort((left, right) => right.name.length - left.name.length)
  const zone = matchingZones[0]

  if (!zone) {
    throw new Error(
      `Cloudflare provisioning failed: DNS zone lookup: no zone contains ${hostname}`,
    )
  }

  const equallySpecificZones = matchingZones.filter(
    (candidate) => candidate.name.length === zone.name.length,
  )

  if (equallySpecificZones.length > 1) {
    throw new Error(
      `Cloudflare provisioning failed: DNS zone lookup: more than one zone contains ${hostname}`,
    )
  }

  const recordsPath = `/zones/${zone.id}/dns_records`
  const records = await cloudflareRequest({
    apiToken,
    fetch: fetcher,
    method: 'GET',
    path: `${recordsPath}?type=CNAME&name=${encodeURIComponent(hostname)}&per_page=1000`,
    schema: dnsRecordListSchema,
    task: 'tunnel DNS record lookup',
  })
  assertCompleteList(
    records.result.length,
    records.result_info?.total_count,
    'tunnel DNS record lookup',
  )

  const comment = ownedTunnelName(hostname)
  const ownedRecords = records.result.filter(
    (record) => record.name === hostname && record.comment === comment,
  )

  if (ownedRecords.length > 1) {
    throw new Error(
      'Cloudflare provisioning failed: tunnel DNS record lookup: more than one owned record exists',
    )
  }

  const desired = {
    type: 'CNAME',
    name: hostname,
    content: `${tunnelId}.cfargotunnel.com`,
    proxied: true,
    ttl: 1,
    comment,
  }
  const current = ownedRecords[0]

  if (!current) {
    await cloudflareRequest({
      apiToken,
      body: desired,
      fetch: fetcher,
      method: 'POST',
      path: recordsPath,
      schema: dnsRecordSchemaResponse,
      task: 'tunnel DNS record creation',
    })
  } else if (
    current.type !== desired.type ||
    current.content !== desired.content ||
    current.proxied !== desired.proxied ||
    current.ttl !== desired.ttl
  ) {
    await cloudflareRequest({
      apiToken,
      body: desired,
      fetch: fetcher,
      method: 'PUT',
      path: `${recordsPath}/${current.id}`,
      schema: dnsRecordSchemaResponse,
      task: 'tunnel DNS record update',
    })
  }
}

const reconcileIdentityProviders = async ({
  accountId,
  apiToken,
  fetch: fetcher,
  hostname,
  identityProviders,
}: {
  accountId: string
  apiToken: string
  fetch: Fetch
  hostname: string
  identityProviders: IdentityProvider[]
}) => {
  const path = `/accounts/${accountId}/access/identity_providers`
  const response = await cloudflareRequest({
    apiToken,
    fetch: fetcher,
    method: 'GET',
    path: `${path}?per_page=1000`,
    schema: identityProviderListSchema,
    task: 'identity provider lookup',
  })
  assertCompleteList(
    response.result.length,
    response.result_info?.total_count,
    'identity provider lookup',
  )

  // Cloudflare allows only one One-time PIN provider per account.
  const hasOneTimePin = response.result.some(
    ({ type }) => type === 'onetimepin',
  )
  const desiredProviders = hasOneTimePin
    ? identityProviders
    : [
        { name: 'One-time PIN', type: 'onetimepin', config: {} },
        ...identityProviders,
      ]

  for (const provider of desiredProviders) {
    const name = ownedIdentityProviderName(hostname, provider.name)
    const ownedProviders = response.result.filter(
      (candidate) => candidate.name === name,
    )

    if (ownedProviders.length > 1) {
      throw new Error(
        `Cloudflare provisioning failed: identity provider lookup: more than one owned provider exists for ${name}`,
      )
    }

    const desired = { ...provider, name }
    const current = ownedProviders[0]

    if (!current) {
      await cloudflareRequest({
        apiToken,
        body: desired,
        fetch: fetcher,
        method: 'POST',
        path,
        schema: identityProviderSchemaResponse,
        task: `${provider.name} identity provider creation`,
        verbatimApiError: true,
      })
      continue
    }

    const detail = await cloudflareRequest({
      apiToken,
      fetch: fetcher,
      method: 'GET',
      path: `${path}/${current.id}`,
      schema: identityProviderSchemaResponse,
      task: `${provider.name} identity provider lookup`,
    })

    if (
      detail.result.type !== desired.type ||
      canonicalJson(detail.result.config) !== canonicalJson(desired.config)
    ) {
      await cloudflareRequest({
        apiToken,
        body: desired,
        fetch: fetcher,
        method: 'PUT',
        path: `${path}/${current.id}`,
        schema: identityProviderSchemaResponse,
        task: `${provider.name} identity provider update`,
        verbatimApiError: true,
      })
    }
  }
}

const assertCompleteList = (
  resultLength: number,
  totalCount: number | undefined,
  task: string,
) => {
  if (totalCount !== undefined && totalCount > resultLength) {
    throw new Error(
      `Cloudflare provisioning failed: ${task}: list is incomplete`,
    )
  }
}

const discoverAccountId = async (apiToken: string, fetcher: Fetch) => {
  const response = await cloudflareRequest({
    apiToken,
    fetch: fetcher,
    method: 'GET',
    path: '/accounts?per_page=50',
    schema: accountListSchema,
    task: 'account discovery',
  })
  const totalCount = response.result_info?.total_count ?? response.result.length

  if (totalCount !== 1 || response.result.length !== 1) {
    throw new Error(
      `Cloudflare provisioning failed: account discovery: expected one visible account; set CLOUDFLARE_ACCOUNT_ID`,
    )
  }

  return response.result[0]!.id
}

const applicationBody = (
  hostname: string,
  namespace: 'r' | 'rt',
  sessionDuration: string,
) => ({
  name: ownedApplicationName(hostname, namespace),
  type: 'self_hosted',
  destinations: [{ type: 'public', uri: `${hostname}/${namespace}/*` }],
  session_duration: sessionDuration,
})

const policyBody = (
  hostname: string,
  namespace: 'r' | 'rt',
  include: AccessRule[],
) => ({
  name: ownedPolicyName(hostname, namespace),
  decision: 'allow',
  include,
})

const applicationMatches = (
  application: z.infer<typeof applicationSchema>,
  desired: ReturnType<typeof applicationBody>,
) =>
  application.type === desired.type &&
  application.session_duration === desired.session_duration &&
  application.destinations?.length === 1 &&
  application.destinations[0]?.type === desired.destinations[0].type &&
  application.destinations[0]?.uri === desired.destinations[0].uri

const ruleKey = (rule: Record<string, unknown>) => JSON.stringify(rule)

const policyMatches = (
  policy: z.infer<typeof policySchema>,
  desired: ReturnType<typeof policyBody>,
) => {
  const currentRules = policy.include.map(ruleKey).sort()
  const desiredRules = desired.include.map(ruleKey).sort()

  return (
    policy.decision === desired.decision &&
    currentRules.length === desiredRules.length &&
    currentRules.every((rule, index) => rule === desiredRules[index])
  )
}

const reconcilePolicy = async ({
  accountId,
  apiToken,
  applicationId,
  fetch: fetcher,
  hostname,
  include,
  namespace,
}: {
  accountId: string
  apiToken: string
  applicationId: string
  fetch: Fetch
  hostname: string
  include: AccessRule[]
  namespace: 'r' | 'rt'
}) => {
  const path = `/accounts/${accountId}/access/apps/${applicationId}/policies`
  const response = await cloudflareRequest({
    apiToken,
    fetch: fetcher,
    method: 'GET',
    path: `${path}?per_page=1000`,
    schema: policyListSchema,
    task: `${namespace} policy lookup`,
  })
  assertCompleteList(
    response.result.length,
    response.result_info?.total_count,
    `${namespace} policy lookup`,
  )

  const name = ownedPolicyName(hostname, namespace)
  const ownedPolicies = response.result.filter((policy) => policy.name === name)

  if (ownedPolicies.length > 1) {
    throw new Error(
      `Cloudflare provisioning failed: ${namespace} policy lookup: more than one owned policy exists`,
    )
  }

  const desired = policyBody(hostname, namespace, include)
  const current = ownedPolicies[0]

  if (!current) {
    await cloudflareRequest({
      apiToken,
      body: desired,
      fetch: fetcher,
      method: 'POST',
      path,
      schema: policySchemaResponse,
      task: `${namespace} policy creation`,
    })
  } else if (!policyMatches(current, desired)) {
    await cloudflareRequest({
      apiToken,
      body: desired,
      fetch: fetcher,
      method: 'PUT',
      path: `${path}/${current.id}`,
      schema: policySchemaResponse,
      task: `${namespace} policy update`,
    })
  }
}

export const runCloudflareProvisioning = async ({
  accountId,
  apiToken,
  baseUrl,
  emailDomains,
  emails,
  fetch: fetcher,
  identityProviders = [],
  port,
  sessionDuration,
}: ProvisioningOptions) => {
  const resolvedAccountId =
    accountId ?? (await discoverAccountId(apiToken, fetcher))
  const hostname = new URL(baseUrl).hostname
  const include: AccessRule[] = [
    ...splitValues(emails).map((email) => ({ email: { email } })),
    ...splitValues(emailDomains).map((domain) => ({
      email_domain: { domain: domain.replace(/^@/, '') },
    })),
  ]
  const applicationsPath = `/accounts/${resolvedAccountId}/access/apps`
  const response = await cloudflareRequest({
    apiToken,
    fetch: fetcher,
    method: 'GET',
    path: `${applicationsPath}?per_page=1000`,
    schema: applicationListSchema,
    task: 'Access application lookup',
  })
  assertCompleteList(
    response.result.length,
    response.result_info?.total_count,
    'Access application lookup',
  )

  for (const namespace of namespaces) {
    const name = ownedApplicationName(hostname, namespace)
    const ownedApplications = response.result.filter(
      (application) => application.name === name,
    )

    if (ownedApplications.length > 1) {
      throw new Error(
        `Cloudflare provisioning failed: ${namespace} application lookup: more than one owned application exists`,
      )
    }

    const desired = applicationBody(hostname, namespace, sessionDuration)
    const current = ownedApplications[0]
    let applicationId: string

    if (!current) {
      const created = await cloudflareRequest({
        apiToken,
        body: desired,
        fetch: fetcher,
        method: 'POST',
        path: applicationsPath,
        schema: applicationSchemaResponse,
        task: `${namespace} application creation`,
      })
      applicationId = created.result.id
    } else {
      applicationId = current.id

      if (!applicationMatches(current, desired)) {
        await cloudflareRequest({
          apiToken,
          body: desired,
          fetch: fetcher,
          method: 'PUT',
          path: `${applicationsPath}/${current.id}`,
          schema: applicationSchemaResponse,
          task: `${namespace} application update`,
        })
      }
    }

    await reconcilePolicy({
      accountId: resolvedAccountId,
      apiToken,
      applicationId,
      fetch: fetcher,
      hostname,
      include,
      namespace,
    })
  }

  await reconcileIdentityProviders({
    accountId: resolvedAccountId,
    apiToken,
    fetch: fetcher,
    hostname,
    identityProviders,
  })

  const tunnel = await reconcileTunnel({
    accountId: resolvedAccountId,
    apiToken,
    fetch: fetcher,
    hostname,
    port,
  })
  await reconcileDnsRecord({
    accountId: resolvedAccountId,
    apiToken,
    fetch: fetcher,
    hostname,
    tunnelId: tunnel.id,
  })

  return { tunnelToken: tunnel.token }
}
