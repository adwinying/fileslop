import { tryTo } from '~/utils'
import {
  VerificationError,
  verifyExternal,
  verifyInternal,
  verifyRoundTrip,
} from '~/verify'

const usage = `Usage:
  bun run verify:external <deployed-url>
  bun run verify:internal <origin-url>
  bun run verify:round-trip <origin-url>`
const logger = {
  log: console.log,
  warn: (message: string) =>
    console.warn(
      process.env.GITHUB_ACTIONS === 'true' ? `::warning::${message}` : message,
    ),
}

const main = async () => {
  const [mode, ...args] = Bun.argv.slice(2)

  if (mode === 'external' && args.length === 1) {
    await verifyExternal({
      deployedUrl: args[0],
      logger,
    })
    return
  }

  if (mode === 'internal' && args.length === 1) {
    await verifyInternal({ originUrl: args[0], logger })
    return
  }

  if (mode === 'round-trip' && args.length === 1) {
    await verifyRoundTrip({ originUrl: args[0], logger })
    return
  }

  throw new VerificationError(usage)
}

const [, error] = await tryTo(main())

if (error !== null) {
  console.error(error.message)
  process.exitCode = 1
}
