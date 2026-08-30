export type Namespace = {
  directory: string
  ttl: number | null
}

export const namespaces = {
  p: {
    directory: 'p',
    ttl: null,
  },
} as const satisfies Record<string, Namespace>
