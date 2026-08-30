import { unlinkSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'

process.env.BASE_URL = 'https://files.example'

const { createApp } = await import('~/app')

const temporaryDirectories: string[] = []

const createStorageRoot = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fileslop-'))
  temporaryDirectories.push(directory)
  return directory
}

const upload = (
  app: ReturnType<typeof createApp>,
  file: Blob,
  filename: string,
  host: string,
) => {
  const form = new FormData()
  form.set('file', file, filename)

  return app.handle(
    new Request(`https://${host}/w/p`, {
      method: 'POST',
      body: form,
    }),
  )
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('POST /w/p', () => {
  test('stores the file and returns its public URL', async () => {
    const storageRoot = await createStorageRoot()
    const app = createApp({
      storageRoot,
      baseUrl: 'https://slop.example/base/path',
      seed: 42,
    })
    const contents = new Uint8Array([255, 1, 2, 3])
    const sourcePath = join(storageRoot, 'source')
    await Bun.write(sourcePath, contents)

    const response = await upload(
      app,
      Bun.file(sourcePath),
      'report.PDF',
      'spoofed.example',
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(response.headers.get('cache-control')).toBe('no-store')

    const body = await response.text()
    expect(body).toMatch(/^https:\/\/slop\.example\/p\/[a-zA-Z0-9]{7}\.pdf\n$/)
    expect(body).not.toContain('spoofed.example')

    const filename = new URL(body.trim()).pathname.split('/').pop()
    expect(filename).toBeDefined()
    expect(
      new Uint8Array(await readFile(join(storageRoot, 'p', filename!))),
    ).toEqual(contents)
  })

  test('retries a slug collision without changing the existing file', async () => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot, seed: 42 })
    const existingPath = join(storageRoot, 'p', 'aogXozu.txt')
    await Bun.write(existingPath, 'existing')

    const response = await upload(
      app,
      new File(['uploaded'], 'report.txt'),
      'report.txt',
      'host.example',
    )

    expect(response.status).toBe(201)
    expect(await response.text()).toBe('https://files.example/p/bEd7x14.txt\n')
    expect(await readFile(existingPath, 'utf8')).toBe('existing')
    expect(await readFile(join(storageRoot, 'p', 'bEd7x14.txt'), 'utf8')).toBe(
      'uploaded',
    )
  })

  test('responds 500 after five slug collisions', async () => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot, seed: 42 })
    const occupiedSlugs = [
      'aogXozu',
      'bEd7x14',
      'bmI5jgI',
      'YmydkzV',
      'fRW34B6',
    ]
    await Promise.all(
      occupiedSlugs.map((slug) =>
        Bun.write(join(storageRoot, 'p', `${slug}.txt`), 'existing'),
      ),
    )

    const response = await upload(
      app,
      new File(['uploaded'], 'report.txt'),
      'report.txt',
      'host.example',
    )

    expect(response.status).toBe(500)
    expect(await readdir(join(storageRoot, 'p'))).toHaveLength(5)
  })

  test('stores concurrent uploads under distinct filenames', async () => {
    const storageRoot = await createStorageRoot()
    const firstApp = createApp({ storageRoot, seed: 42 })
    const secondApp = createApp({ storageRoot, seed: 42 })

    const [firstResponse, secondResponse] = await Promise.all([
      upload(
        firstApp,
        new File(['first'], 'report.txt'),
        'report.txt',
        'host.example',
      ),
      upload(
        secondApp,
        new File(['second'], 'report.txt'),
        'report.txt',
        'host.example',
      ),
    ])

    expect(firstResponse.status).toBe(201)
    expect(secondResponse.status).toBe(201)
    const urls = await Promise.all([
      firstResponse.text(),
      secondResponse.text(),
    ])
    expect(new Set(urls).size).toBe(2)
    const contents = await Promise.all(
      urls.map(async (url) => {
        const filename = new URL(url.trim()).pathname.split('/').pop()
        expect(filename).toBeDefined()
        return readFile(join(storageRoot, 'p', filename!), 'utf8')
      }),
    )
    expect(contents.sort()).toEqual(['first', 'second'])
  })

  test('preserves an allowed compound extension', async () => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot, seed: 42 })

    const response = await upload(
      app,
      new File(['archive'], 'archive.tar.gz'),
      'archive.tar.gz',
      'host.example',
    )

    expect(response.status).toBe(201)
    const body = await response.text()
    expect(body).toMatch(
      /^https:\/\/files\.example\/p\/[a-zA-Z0-9]{7}\.tar\.gz\n$/,
    )

    const filename = new URL(body.trim()).pathname.split('/').pop()
    expect(filename).toBeDefined()
    expect(await readFile(join(storageRoot, 'p', filename!), 'utf8')).toBe(
      'archive',
    )
  })

  test('does not treat a dotfile name as an extension', async () => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot, seed: 42 })

    const response = await upload(
      app,
      new File(['shell'], '.bashrc'),
      '.bashrc',
      'host.example',
    )

    expect(response.status).toBe(201)
    const body = await response.text()
    expect(body).toMatch(/^https:\/\/files\.example\/p\/[a-zA-Z0-9]{7}\n$/)

    const filename = new URL(body.trim()).pathname.split('/').pop()
    expect(filename).toBeDefined()
    expect(await readFile(join(storageRoot, 'p', filename!), 'utf8')).toBe(
      'shell',
    )
  })

  test.each([
    ['Makefile', ''],
    ['my.report.final.png', '.png'],
    ['document.abcdefghijk', ''],
    ['document.bad-suffix', ''],
  ])('derives the extension from %s', async (originalName, extension) => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot, seed: 42 })

    const response = await upload(
      app,
      new File(['contents'], originalName),
      originalName,
      'host.example',
    )

    expect(response.status).toBe(201)
    const body = await response.text()
    const escapedExtension = extension.replace('.', '\\.')
    expect(body).toMatch(
      new RegExp(
        `^https://files\\.example/p/[a-zA-Z0-9]{7}${escapedExtension}\\n$`,
      ),
    )

    const filename = new URL(body.trim()).pathname.split('/').pop()
    expect(filename).toBeDefined()
    expect(await readFile(join(storageRoot, 'p', filename!), 'utf8')).toBe(
      'contents',
    )
  })

  test('rejects missing, repeated, extra, and wrongly named fields', async () => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot, seed: 42 })

    const missing = new FormData()
    const repeated = new FormData()
    repeated.append('file', new File(['one'], 'one.txt'))
    repeated.append('file', new File(['two'], 'two.txt'))
    const extra = new FormData()
    extra.set('file', new File(['one'], 'one.txt'))
    extra.set('description', 'unexpected')
    const wrongName = new FormData()
    wrongName.set('upload', new File(['one'], 'one.txt'))

    for (const form of [missing, repeated, extra, wrongName]) {
      const response = await app.handle(
        new Request('https://host.example/w/p', {
          method: 'POST',
          body: form,
        }),
      )
      expect(response.status).toBe(422)
    }

    expect(await readdir(join(storageRoot, 'p'))).toEqual([])
  })

  test('rejects an oversized file before writing it', async () => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot, maxUploadBytes: 4, seed: 42 })

    const response = await upload(
      app,
      new File(['12345'], 'large.txt'),
      'large.txt',
      'host.example',
    )

    expect(response.status).toBe(413)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('Payload Too Large\n')
    expect(await readdir(join(storageRoot, 'p'))).toEqual([])
  })

  test('creates namespace directories when the app is built', async () => {
    const storageRoot = await createStorageRoot()

    createApp({ storageRoot, seed: 42 })

    expect((await stat(join(storageRoot, 'p'))).isDirectory()).toBe(true)
  })

  test('produces repeatable slugs only when seeded', async () => {
    const firstRoot = await createStorageRoot()
    const secondRoot = await createStorageRoot()
    const first = createApp({ storageRoot: firstRoot, seed: 123 })
    const second = createApp({ storageRoot: secondRoot, seed: 123 })
    const sourcePath = join(firstRoot, 'source')
    await Bun.write(sourcePath, 'same')
    const file = Bun.file(sourcePath)

    const firstUrl = await (
      await upload(first, file, 'same.txt', 'host.example')
    ).text()
    const secondResponse = await upload(
      second,
      file,
      'same.txt',
      'host.example',
    )
    const secondUrl = await secondResponse.text()

    expect(secondResponse.status).toBe(201)
    expect(firstUrl).toBe(secondUrl)
  })
})

describe('POST /w/pt', () => {
  test('stores the file in pt and returns its temporary URL', async () => {
    const storageRoot = await createStorageRoot()
    const app = createApp({
      storageRoot,
      baseUrl: 'https://slop.example/base/path',
      seed: 42,
    })
    const form = new FormData()
    form.set('file', new File(['temporary'], 'screenshot.png'))

    const response = await app.handle(
      new Request('https://spoofed.example/w/pt', {
        method: 'POST',
        body: form,
      }),
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('content-type')).toBe('text/plain')
    const body = await response.text()
    expect(body).toMatch(/^https:\/\/slop\.example\/pt\/[a-zA-Z0-9]{7}\.png\n$/)

    const filename = new URL(body.trim()).pathname.split('/').pop()
    expect(filename).toBeDefined()
    expect(await readFile(join(storageRoot, 'pt', filename!), 'utf8')).toBe(
      'temporary',
    )
    expect(await readdir(join(storageRoot, 'p'))).toEqual([])
  })
})

describe('GET /p/:filename', () => {
  test('returns the exact stored bytes', async () => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot })
    const contents = new Uint8Array([0, 255, 1, 2, 3])
    await Bun.write(join(storageRoot, 'p', 'aB3dE5g.bin'), contents)

    const response = await app.handle(
      new Request('https://files.example/p/aB3dE5g.bin'),
    )

    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(contents)
  })

  test('round trips bytes from the upload response URL', async () => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot, seed: 42 })
    const contents = new Uint8Array([255, 42, 1])
    const sourcePath = join(storageRoot, 'source')
    await Bun.write(sourcePath, contents)

    const uploadResponse = await upload(
      app,
      Bun.file(sourcePath),
      'image.png',
      'files.example',
    )
    expect(uploadResponse.status).toBe(201)
    const downloadResponse = await app.handle(
      new Request((await uploadResponse.text()).trim()),
    )

    expect(downloadResponse.status).toBe(200)
    expect(new Uint8Array(await downloadResponse.arrayBuffer())).toEqual(
      contents,
    )
  })

  test('sets the extension MIME type and disables caching', async () => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot })
    await Bun.write(join(storageRoot, 'p', 'aB3dE5g.png'), 'image')

    const response = await app.handle(
      new Request('https://files.example/p/aB3dE5g.png'),
    )

    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-disposition')).toBeNull()
    expect(response.headers.get('etag')).toBeNull()
    expect(response.headers.get('last-modified')).toBeNull()
  })

  test.each([
    ['aB3dE5g', 'application/octet-stream'],
    ['aB3dE5g.unknown', 'application/octet-stream'],
  ])('uses the fallback MIME type for %s', async (filename, contentType) => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot })
    await Bun.write(join(storageRoot, 'p', filename), 'contents')

    const response = await app.handle(
      new Request(`https://files.example/p/${filename}`),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(contentType)
  })

  test('serves a filename with an allowed compound extension', async () => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot })
    await Bun.write(join(storageRoot, 'p', 'aB3dE5g.tar.gz'), 'archive')

    const response = await app.handle(
      new Request('https://files.example/p/aB3dE5g.tar.gz'),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/gzip')
    expect(await response.text()).toBe('archive')
  })

  test.each([
    'missing',
    '..',
    'short.txt',
    'aB3dE5g%2Fsecret.txt',
    'aB3dE5g.bad-suffix',
  ])('returns the same non-cacheable miss for %s', async (filename) => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot })

    const response = await app.handle(
      new Request(`https://files.example/p/${filename}`),
    )

    expect(response.status).toBe(404)
    expect(await response.text()).toBe('Not Found\n')
    expect(response.headers.get('content-type')).toStartWith('text/plain')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  test('returns the same miss for an absent namespace directory and a non-file', async () => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot })
    await mkdir(join(storageRoot, 'p', 'aB3dE5g.txt'))

    const directoryResponse = await app.handle(
      new Request('https://files.example/p/aB3dE5g.txt'),
    )
    await rm(join(storageRoot, 'p'), { recursive: true })
    const absentResponse = await app.handle(
      new Request('https://files.example/p/aB3dE5g.txt'),
    )

    for (const response of [directoryResponse, absentResponse]) {
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('Not Found\n')
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
  })
})

describe('GET /pt/:filename', () => {
  test('returns a miss for an expired file without deleting it', async () => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot })
    const path = join(storageRoot, 'pt', 'aB3dE5g.txt')
    const ttl = (await import('~/namespaces')).namespaces.pt.ttl
    await Bun.write(path, 'expired')
    await utimes(path, 0, new Date(Date.now() - ttl - 10_000))

    const response = await app.handle(
      new Request('https://files.example/pt/aB3dE5g.txt'),
    )

    expect(response.status).toBe(404)
    expect(await response.text()).toBe('Not Found\n')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await stat(path)).isFile()).toBe(true)
  })

  test('serves a file just inside its TTL', async () => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot })
    const path = join(storageRoot, 'pt', 'aB3dE5g.txt')
    const ttl = (await import('~/namespaces')).namespaces.pt.ttl
    await Bun.write(path, 'temporary')
    await utimes(path, 0, new Date(Date.now() - ttl + 10_000))

    const response = await app.handle(
      new Request('https://files.example/pt/aB3dE5g.txt'),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('temporary')
  })

  test('serves a permanent file regardless of age', async () => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot })
    const path = join(storageRoot, 'p', 'aB3dE5g.txt')
    await Bun.write(path, 'permanent')
    await utimes(path, 0, 0)

    const response = await app.handle(
      new Request('https://files.example/p/aB3dE5g.txt'),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('permanent')
  })
})

describe('sweeper', () => {
  test('deletes expired temporary files and keeps newer and permanent files', async () => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot })
    const expiredPath = join(storageRoot, 'pt', 'expired.txt')
    const freshPath = join(storageRoot, 'pt', 'fresh.txt')
    const permanentPath = join(storageRoot, 'p', 'permanent.txt')
    const ttl = (await import('~/namespaces')).namespaces.pt.ttl
    const now = Date.now()
    await Promise.all([
      Bun.write(expiredPath, 'expired'),
      Bun.write(freshPath, 'fresh'),
      Bun.write(permanentPath, 'permanent'),
    ])
    await Promise.all([
      utimes(
        expiredPath,
        new Date(now - ttl - 10_000),
        new Date(now - ttl - 10_000),
      ),
      utimes(
        freshPath,
        new Date(now - ttl + 10_000),
        new Date(now - ttl + 10_000),
      ),
      utimes(permanentPath, 0, 0),
    ])

    await app.store.cron.sweeper.trigger()

    expect(await Bun.file(expiredPath).exists()).toBe(false)
    expect(await readFile(freshPath, 'utf8')).toBe('fresh')
    expect(await readFile(permanentPath, 'utf8')).toBe('permanent')
  })

  test.each(['empty', 'absent'])(
    'completes when a temporary namespace directory is %s',
    async (state) => {
      const storageRoot = await createStorageRoot()
      const app = createApp({ storageRoot })

      if (state === 'absent') {
        await rm(join(storageRoot, 'pt'), { recursive: true })
      }

      await expect(app.store.cron.sweeper.trigger()).resolves.toBeUndefined()
    },
  )

  test('logs per-entry errors and continues after a file is removed mid-pass', async () => {
    const storageRoot = await createStorageRoot()
    const app = createApp({ storageRoot })
    const blockedPath = join(storageRoot, 'pt', 'a-directory')
    const removedPath = join(storageRoot, 'pt', 'm-removed.txt')
    const expiredPath = join(storageRoot, 'pt', 'z-expired.txt')
    const ttl = (await import('~/namespaces')).namespaces.pt.ttl
    const expiredAt = Date.now() - ttl - 10_000
    await mkdir(blockedPath)
    await Promise.all([
      Bun.write(removedPath, 'removed'),
      Bun.write(expiredPath, 'expired'),
    ])
    await Promise.all([
      utimes(blockedPath, new Date(expiredAt), new Date(expiredAt)),
      utimes(removedPath, new Date(expiredAt), new Date(expiredAt)),
      utimes(expiredPath, new Date(expiredAt), new Date(expiredAt)),
    ])
    let removed = false
    const error = spyOn(console, 'error').mockImplementation(() => {
      if (!removed) {
        unlinkSync(removedPath)
        removed = true
      }
    })

    try {
      await app.store.cron.sweeper.trigger()

      expect(error).toHaveBeenCalledTimes(2)
      expect(error.mock.calls[1]?.[0]).toContain(removedPath)
      expect(await stat(blockedPath)).toBeDefined()
      expect(await Bun.file(removedPath).exists()).toBe(false)
      expect(await Bun.file(expiredPath).exists()).toBe(false)
    } finally {
      error.mockRestore()
    }
  })
})

describe('configuration', () => {
  test('fails at import time when BASE_URL is missing', async () => {
    // --env-file=/dev/null stops Bun from loading the repo's .env into the
    // spawned process, so it only sees the env passed below.
    const process = Bun.spawn(
      ['bun', '--env-file=/dev/null', '-e', "import './src/env.ts'"],
      {
        cwd: import.meta.dir.replace(/\/src$/, ''),
        env: {
          PATH: Bun.env.PATH ?? '',
        },
        stderr: 'pipe',
      },
    )

    expect(await process.exited).not.toBe(0)
    expect(await new Response(process.stderr).text()).toContain('BASE_URL')
  })

  test('rejects a non-HTTP BASE_URL at import time', async () => {
    const process = Bun.spawn(
      ['bun', '--env-file=/dev/null', '-e', "import './src/env.ts'"],
      {
        cwd: import.meta.dir.replace(/\/src$/, ''),
        env: {
          BASE_URL: 'mailto:ops@example.com',
          PATH: Bun.env.PATH ?? '',
        },
        stderr: 'pipe',
      },
    )

    expect(await process.exited).not.toBe(0)
    expect(await new Response(process.stderr).text()).toContain('BASE_URL')
  })

  test('applies configuration defaults', async () => {
    expect((await import('~/env')).env).toMatchObject({
      STORAGE_ROOT: './storage',
      BASE_URL: 'https://files.example',
      MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
      TEMP_TTL: 24 * 60 * 60 * 1000,
    })
  })
})

describe('namespaces', () => {
  test('declares p as a permanent namespace', async () => {
    expect((await import('~/namespaces')).namespaces.p).toEqual({
      directory: 'p',
      ttl: null,
    })
  })

  test('declares pt as a temporary namespace', async () => {
    expect((await import('~/namespaces')).namespaces.pt).toEqual({
      directory: 'pt',
      ttl: 24 * 60 * 60 * 1000,
    })
  })
})
