import { mkdirSync } from 'node:fs'
import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Patterns, cron } from '@elysiajs/cron'
import { Elysia, t } from 'elysia'
import { env } from '~/env'
import { namespaces } from '~/namespaces'
import { createStorage } from '~/storage'
import { tryTo } from '~/utils'

type AppOptions = {
  storageRoot?: string
  baseUrl?: string
  maxUploadBytes?: number
  seed?: number
}

const isOversizedUpload = (value: unknown, maxUploadBytes: number) => {
  if (typeof value !== 'object' || value === null || !('file' in value)) {
    return false
  }

  return value.file instanceof Blob && value.file.size > maxUploadBytes
}

export const createApp = ({
  storageRoot = env.STORAGE_ROOT,
  baseUrl = env.BASE_URL,
  maxUploadBytes = env.MAX_UPLOAD_BYTES,
  seed,
}: AppOptions = {}) => {
  for (const namespace of Object.values(namespaces)) {
    mkdirSync(join(storageRoot, namespace.directory), { recursive: true })
  }

  const storeFile = createStorage({ storageRoot, seed })
  const sweep = async () => {
    const now = Date.now()

    for (const namespace of Object.values(namespaces)) {
      if (namespace.ttl === null) {
        continue
      }

      const directory = join(storageRoot, namespace.directory)
      const [entries, readdirError] = await tryTo(readdir(directory))

      if (readdirError !== null) {
        if ('code' in readdirError && readdirError.code === 'ENOENT') continue
        throw readdirError
      }

      for (const entry of entries.sort()) {
        const path = join(directory, entry)
        const [entryStats, statError] = await tryTo(stat(path))

        if (statError !== null) {
          console.error(`Failed to sweep ${path}`, statError)
          continue
        }

        if (now - entryStats.mtimeMs <= namespace.ttl) continue

        const [, unlinkError] = await tryTo(unlink(path))

        if (unlinkError !== null)
          console.error(`Failed to sweep ${path}`, unlinkError)
      }
    }
  }
  const uploadBody = t.Object(
    {
      file: t.File({ maxSize: maxUploadBytes }),
    },
    { additionalProperties: false },
  )
  const createUploadHandler =
    (namespaceName: keyof typeof namespaces) =>
    async ({ body }: { body: { file: File } }) => {
      const filename = await storeFile(namespaces[namespaceName], body.file)
      const url = new URL(`/${namespaceName}/${filename}`, baseUrl)

      return new Response(`${url.href}\n`, {
        status: 201,
        headers: { 'content-type': 'text/plain' },
      })
    }

  return new Elysia({ normalize: false })
    .use(
      cron({
        name: 'sweeper',
        pattern: Patterns.hourly(),
        run: sweep,
      }),
    )
    .onError(({ code, error }) => {
      if (
        code === 'VALIDATION' &&
        error.type === 'body' &&
        isOversizedUpload(error.value, maxUploadBytes)
      ) {
        return new Response('Payload Too Large\n', { status: 413 })
      }
    })
    .post('/w/p', createUploadHandler('p'), {
      body: uploadBody,
    })
    .post('/w/pt', createUploadHandler('pt'), { body: uploadBody })
}
