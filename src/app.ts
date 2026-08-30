import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import { env } from '~/env'
import { namespaces } from '~/namespaces'
import { createStorage } from '~/storage'

type AppOptions = {
  storageRoot?: string
  baseUrl?: string
  seed?: number
}

export const createApp = ({
  storageRoot = env.STORAGE_ROOT,
  baseUrl = env.BASE_URL,
  seed,
}: AppOptions = {}) => {
  for (const namespace of Object.values(namespaces)) {
    mkdirSync(join(storageRoot, namespace.directory), { recursive: true })
  }

  const storeFile = createStorage({ storageRoot, seed })

  return new Elysia().post('/w/p', async ({ body, request }) => {
    if (
      !request.headers.get('content-type')?.startsWith('multipart/form-data')
    ) {
      return new Response('Unprocessable Entity\n', { status: 422 })
    }

    const entries =
      typeof body === 'object' && body !== null ? Object.entries(body) : []
    const [entry] = entries

    if (
      entries.length !== 1 ||
      entry?.[0] !== 'file' ||
      !(entry[1] instanceof File)
    ) {
      return new Response('Unprocessable Entity\n', { status: 422 })
    }

    const filename = await storeFile(namespaces.p, entry[1])
    const url = new URL(`/p/${filename}`, baseUrl)

    return new Response(`${url.href}\n`, {
      status: 201,
      headers: { 'content-type': 'text/plain' },
    })
  })
}
