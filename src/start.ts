import type { Fetch } from '~/preflight'
import { createApp } from '~/app'
import { createEnvironment } from '~/env'
import { runCloudflarePreflight } from '~/preflight'
import { runCloudflareProvisioning } from '~/provisioning'
import { tryTo } from '~/utils'

export type StartOptions = {
  fetch?: Fetch
  listen?: Listen
  port?: number
  spawn?: Spawn
}

type Listen = (app: ReturnType<typeof createApp>, port: number) => void

export type Spawn = (
  command: string[],
  options: {
    env: Record<string, string | undefined>
    stderr: 'inherit'
    stdout: 'inherit'
    onExit: (exitCode: number | null) => void
  },
) => unknown

const spawnProcess: Spawn = (command, options) =>
  Bun.spawn(command, {
    env: options.env,
    stderr: options.stderr,
    stdout: options.stdout,
    onExit: (_process, exitCode) => options.onExit(exitCode),
  })

const listen: Listen = (app, port) => app.listen(port)

export const start = async ({
  fetch: fetcher = globalThis.fetch,
  listen: startListening = listen,
  port = 3000,
  spawn = spawnProcess,
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

  const app = createApp({
    storageRoot: config.STORAGE_ROOT,
    baseUrl: config.BASE_URL,
    maxUploadBytes: config.MAX_UPLOAD_BYTES,
    logRequests: true,
  })

  startListening(app, port)

  console.log(`fileslop is listening on ${app.server?.url}`)

  if (tunnelToken) {
    spawn(['cloudflared', 'tunnel', '--no-autoupdate', 'run'], {
      env: { ...process.env, TUNNEL_TOKEN: tunnelToken },
      stderr: 'inherit',
      stdout: 'inherit',
      onExit: (exitCode) => process.exit(exitCode ?? 1),
    })
  }

  return { app }
}
