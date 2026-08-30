import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

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

describe('configuration', () => {
  test('fails at import time when BASE_URL is missing', async () => {
    const process = Bun.spawn(['bun', '-e', "import './src/env.ts'"], {
      cwd: import.meta.dir.replace(/\/src$/, ''),
      env: {
        PATH: Bun.env.PATH ?? '',
      },
      stderr: 'pipe',
    })

    expect(await process.exited).not.toBe(0)
    expect(await new Response(process.stderr).text()).toContain('BASE_URL')
  })

  test('applies configuration defaults', async () => {
    expect((await import('~/env')).env).toMatchObject({
      STORAGE_ROOT: './storage',
      BASE_URL: 'https://files.example',
      MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
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
})
