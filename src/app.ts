import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Elysia, t } from 'elysia'
import { env } from '~/env'
import { namespaces } from '~/namespaces'
import { createStorage } from '~/storage'

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

  return new Elysia({ normalize: false })
    .onError(({ code, error }) => {
      if (
        code === 'VALIDATION' &&
        error.type === 'body' &&
        isOversizedUpload(error.value, maxUploadBytes)
      ) {
        return new Response('Payload Too Large\n', { status: 413 })
      }
    })
    .post(
      '/w/p',
      async ({ body }) => {
        const filename = await storeFile(namespaces.p, body.file)
        const url = new URL(`/p/${filename}`, baseUrl)

        return new Response(`${url.href}\n`, {
          status: 201,
          headers: { 'content-type': 'text/plain' },
        })
      },
      {
        body: t.Object(
          {
            file: t.File({ maxSize: maxUploadBytes }),
          },
          { additionalProperties: false },
        ),
      },
    )
}
