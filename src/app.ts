import { mkdirSync } from 'node:fs'
import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Patterns, cron } from '@elysiajs/cron'
import { Elysia, t } from 'elysia'
import { env } from '~/env'
import { isExpired, namespaces } from '~/namespaces'
import { createStorage, isValidStoredFilename } from '~/storage'
import { tryTo } from '~/utils'

type AppOptions = {
  storageRoot?: string
  baseUrl?: string
  maxUploadBytes?: number
  logRequests?: boolean
  seed?: number
}

const isOversizedUpload = (value: unknown, maxUploadBytes: number) => {
  if (typeof value !== 'object' || value === null || !('file' in value)) {
    return false
  }

  return value.file instanceof Blob && value.file.size > maxUploadBytes
}

const notFound = () =>
  new Response('Not Found\n', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  })

export const createApp = ({
  storageRoot = env.STORAGE_ROOT,
  baseUrl = env.BASE_URL,
  maxUploadBytes = env.MAX_UPLOAD_BYTES,
  logRequests = false,
  seed,
}: AppOptions = {}) => {
  for (const namespace of Object.values(namespaces)) {
    mkdirSync(join(storageRoot, namespace.directory), { recursive: true })
  }

  const storage = createStorage({ storageRoot, seed })
  const sweep = async () => {
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

        if (!isExpired(namespace, entryStats)) continue

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
      const filename = await storage.store(namespaces[namespaceName], body.file)
      const url = new URL(`/${namespaceName}/${filename}`, baseUrl)

      return new Response(`${url.href}\n`, {
        status: 201,
        headers: { 'content-type': 'text/plain' },
      })
    }
  const createReplaceHandler =
    (namespaceName: keyof typeof namespaces) =>
    async ({
      body,
      params,
    }: {
      body: { file: File }
      params: { filename: string }
    }) => {
      if (!isValidStoredFilename(params.filename)) return notFound()

      const result = await storage.replace(
        namespaces[namespaceName],
        params.filename,
        body.file,
      )

      if (result.status === 'not-found') return notFound()

      if (result.status === 'extension-mismatch') {
        const targetExtension = result.targetExtension || '(none)'
        const uploadedExtension = result.uploadedExtension || '(none)'

        return new Response(
          `Extension mismatch: target ${targetExtension}, uploaded ${uploadedExtension}\n`,
          {
            status: 409,
            headers: { 'content-type': 'text/plain' },
          },
        )
      }

      const url = new URL(`/${namespaceName}/${params.filename}`, baseUrl)

      return new Response(`${url.href}\n`, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    }
  const createReadHandler =
    (namespaceName: keyof typeof namespaces) =>
    async ({ params }: { params: { filename: string } }) => {
      if (!isValidStoredFilename(params.filename)) return notFound()

      const namespace = namespaces[namespaceName]
      const path = join(storageRoot, namespace.directory, params.filename)
      const file = Bun.file(path)
      const [fileStats, statError] = await tryTo(stat(path))

      if (statError !== null || !fileStats.isFile()) return notFound()
      if (isExpired(namespace, fileStats)) return notFound()

      // ADR-0002: preserve the stored file's extension-derived MIME type and
      // serve it inline rather than forcing a download.
      // Bun 1.3.9 serves the full file with 200 for Range requests. Range
      // handling stays delegated to Bun so a runtime upgrade can change it.
      return new Response(file, {
        headers: {
          'content-type': file.type || 'application/octet-stream',
        },
      })
    }

  return new Elysia({ normalize: false })
    .headers({ 'cache-control': 'no-store' })
    .derive(() => ({ startedAt: Date.now() }))
    .onAfterResponse(({ request, set, responseValue, startedAt }) => {
      if (!logRequests) return

      // Handlers return raw Responses, so `set.status` never sees their status.
      const status =
        responseValue instanceof Response ? responseValue.status : set.status
      const { pathname } = new URL(request.url)

      console.log(
        `${new Date(startedAt).toISOString()} ${request.method} ${pathname} ${status} ${Date.now() - startedAt}ms`,
      )
    })
    .use(
      cron({
        name: 'sweeper',
        pattern: Patterns.hourly(),
        run: sweep,
      }),
    )
    .onError(({ code, error }) => {
      if (code === 'NOT_FOUND') return notFound()

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
    .put('/w/p/:filename', createReplaceHandler('p'), { body: uploadBody })
    .put('/w/pt/:filename', createReplaceHandler('pt'), { body: uploadBody })
    .get('/p/:filename', createReadHandler('p'))
    .get('/pt/:filename', createReadHandler('pt'))
}
