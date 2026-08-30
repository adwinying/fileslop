import type { Stats } from 'node:fs'
import { env } from '~/env'

export type Namespace = {
  directory: string
  ttl: number | null
}

export const namespaces = {
  p: {
    directory: 'p',
    ttl: null,
  },
  pt: {
    directory: 'pt',
    ttl: env.TEMP_TTL,
  },
  r: {
    directory: 'r',
    ttl: null,
  },
  rt: {
    directory: 'rt',
    ttl: env.TEMP_TTL,
  },
} as const satisfies Record<string, Namespace>

export const isExpired = (namespace: Namespace, fileStats: Stats) =>
  namespace.ttl !== null && Date.now() - fileStats.mtimeMs > namespace.ttl
