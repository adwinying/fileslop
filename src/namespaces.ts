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
} as const satisfies Record<string, Namespace>
