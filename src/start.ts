import type { Fetch } from '~/preflight'
import { createApp } from '~/app'
import { createEnvironment } from '~/env'
import { runCloudflarePreflight } from '~/preflight'

type StartOptions = {
  fetch?: Fetch
}

export const start = async ({
  fetch: fetcher = globalThis.fetch,
}: StartOptions = {}) => {
  const config = createEnvironment(process.env)
  const cloudflareActive = config.CLOUDFLARE_API_TOKEN !== undefined

  console.log(`Cloudflare mode: ${cloudflareActive ? 'active' : 'inactive'}`)

  if (config.CLOUDFLARE_API_TOKEN) {
    await runCloudflarePreflight({
      accountId: config.CLOUDFLARE_ACCOUNT_ID,
      apiToken: config.CLOUDFLARE_API_TOKEN,
      baseUrl: config.BASE_URL,
      fetch: fetcher,
    })
  }

  return createApp({
    storageRoot: config.STORAGE_ROOT,
    baseUrl: config.BASE_URL,
    maxUploadBytes: config.MAX_UPLOAD_BYTES,
    logRequests: true,
  })
}
