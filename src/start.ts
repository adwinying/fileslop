import type { Fetch } from '~/preflight'
import { createApp } from '~/app'
import { createEnvironment } from '~/env'
import { runCloudflarePreflight } from '~/preflight'
import { runCloudflareProvisioning } from '~/provisioning'
import { tryTo } from '~/utils'

type StartOptions = {
  fetch?: Fetch
}

export const start = async ({
  fetch: fetcher = globalThis.fetch,
}: StartOptions = {}) => {
  const config = createEnvironment(process.env)
  const cloudflareActive = config.CLOUDFLARE_API_TOKEN !== undefined
  let tunnelToken: string | undefined

  console.log(`Cloudflare mode: ${cloudflareActive ? 'active' : 'inactive'}`)

  if (config.CLOUDFLARE_API_TOKEN) {
    const [provisioning, provisioningError] = await tryTo(
      runCloudflareProvisioning({
        accountId: config.CLOUDFLARE_ACCOUNT_ID,
        apiToken: config.CLOUDFLARE_API_TOKEN,
        baseUrl: config.BASE_URL,
        emailDomains: config.ACCESS_EMAIL_DOMAINS,
        emails: config.ACCESS_EMAILS,
        fetch: fetcher,
        identityProviders: config.ACCESS_IDPS,
        sessionDuration: config.ACCESS_SESSION_DURATION,
      }),
    )

    if (provisioningError === null) {
      tunnelToken = provisioning.tunnelToken
    } else {
      console.error(provisioningError.message)
    }

    await runCloudflarePreflight({
      accountId: config.CLOUDFLARE_ACCOUNT_ID,
      apiToken: config.CLOUDFLARE_API_TOKEN,
      baseUrl: config.BASE_URL,
      fetch: fetcher,
    })
  }

  return {
    app: createApp({
      storageRoot: config.STORAGE_ROOT,
      baseUrl: config.BASE_URL,
      maxUploadBytes: config.MAX_UPLOAD_BYTES,
      logRequests: true,
    }),
    tunnelToken,
  }
}
