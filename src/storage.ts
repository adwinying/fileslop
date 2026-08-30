import type { Namespace } from '~/namespaces'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { tryTo } from '~/utils'

const ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const SLUG_LENGTH = 7
const MAX_WRITE_ATTEMPTS = 5
const MAX_UNBIASED_BYTE = 248
const COMPOUND_EXTENSIONS = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst']

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
  const lowerName = name.toLowerCase()
  const compoundExtension = COMPOUND_EXTENSIONS.find((extension) =>
    lowerName.endsWith(extension),
  )

  if (compoundExtension !== undefined) return compoundExtension

  const separator = name.lastIndexOf('.')

  if (separator <= 0) return ''

  const suffix = name.slice(separator + 1).toLowerCase()
  return /^[a-z0-9]{1,10}$/.test(suffix) ? `.${suffix}` : ''
}

const isAlreadyExistsError = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'EEXIST'

const writeExclusively = async (path: string, contents: ArrayBuffer) => {
  const handle = await open(path, 'wx')

  try {
    await handle.writeFile(new Uint8Array(contents))
  } finally {
    await handle.close()
  }
}

export const createStorage = ({ storageRoot, seed }: StorageOptions) => {
  const generateSlug = createSlugGenerator(seed)

  return async (namespace: Namespace, file: File) => {
    const extension = deriveExtension(file.name)
    const contents = await file.arrayBuffer()

    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const filename = `${generateSlug()}${extension}`

      const [, error] = await tryTo(
        writeExclusively(
          join(storageRoot, namespace.directory, filename),
          contents,
        ),
      )

      if (error === null) return filename
      if (!isAlreadyExistsError(error)) throw error
    }

    throw new Error(`Could not store file after ${MAX_WRITE_ATTEMPTS} attempts`)
  }
}
