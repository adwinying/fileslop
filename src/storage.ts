import type { Namespace } from '~/namespaces'
import { join } from 'node:path'

const ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const SLUG_LENGTH = 7
const MAX_UNBIASED_BYTE = 248

type StorageOptions = {
  storageRoot: string
  seed?: number
}

const createSeededByteGenerator = (seed: number) => {
  let state = seed >>> 0

  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) & 0xff
  }
}

const createSecureByteGenerator = () => {
  const bytes = new Uint8Array(1)

  return () => {
    crypto.getRandomValues(bytes)
    return bytes[0] ?? 0
  }
}

const createSlugGenerator = (seed?: number) => {
  const nextByte =
    seed === undefined
      ? createSecureByteGenerator()
      : createSeededByteGenerator(seed)

  return () => {
    let slug = ''

    while (slug.length < SLUG_LENGTH) {
      const byte = nextByte()

      if (byte < MAX_UNBIASED_BYTE) {
        slug += ALPHABET[byte % ALPHABET.length]
      }
    }

    return slug
  }
}

const deriveExtension = (name: string) => {
  const separator = name.lastIndexOf('.')

  if (separator === -1) return ''

  const suffix = name.slice(separator + 1).toLowerCase()
  return /^[a-z0-9]{1,10}$/.test(suffix) ? `.${suffix}` : ''
}

export const createStorage = ({ storageRoot, seed }: StorageOptions) => {
  const generateSlug = createSlugGenerator(seed)

  return async (namespace: Namespace, file: File) => {
    const filename = `${generateSlug()}${deriveExtension(file.name)}`
    await Bun.write(join(storageRoot, namespace.directory, filename), file)
    return filename
  }
}
