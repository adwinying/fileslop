import { VerificationError, verifyExternal, verifyInternal } from '~/verify'

const usage = `Usage:
  bun run verify:external <deployed-url>
  bun run verify:internal <origin-url>`
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

  throw new VerificationError(usage)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
