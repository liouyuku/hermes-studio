import { Readable } from 'stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mkdirMock = vi.hoisted(() => vi.fn())
const writeFileMock = vi.hoisted(() => vi.fn())

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  return {
    ...actual,
    mkdir: mkdirMock,
    writeFile: writeFileMock,
  }
})

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: vi.fn(() => 'default'),
}))

vi.mock('../../packages/server/src/services/hermes/upload-paths', () => ({
  getProfileUploadDir: vi.fn((profile: string) => `/tmp/hermes-web-ui/upload/${profile}`),
  isInProfileUploadDir: vi.fn((filePath: string, profile: string) => {
    const dir = `/tmp/hermes-web-ui/upload/${profile}`
    const norm = String(filePath).replace(/\\/g, '/')
    return norm.startsWith(dir) && !norm.includes('/../')
  }),
}))

function multipartBody(
  boundary: string,
  part: { filename?: string; filenameStar?: string; content: string },
): Buffer {
  const filename = part.filename ? `; filename="${part.filename}"` : ''
  const filenameStar = part.filenameStar ? `; filename*=UTF-8''${part.filenameStar}` : ''
  return Buffer.from([
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"${filename}${filenameStar}`,
    'Content-Type: text/plain',
    '',
    part.content,
    `--${boundary}--`,
    '',
  ].join('\r\n'))
}

function normalizePath(value: unknown): string {
  return String(value).replace(/\\/g, '/')
}

describe('upload controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mkdirMock.mockResolvedValue(undefined)
    writeFileMock.mockResolvedValue(undefined)
  })

  it('stores chat uploads under the request-scoped profile upload directory', async () => {
    const boundary = 'test-boundary'
    const { handleUpload } = await import('../../packages/server/src/controllers/upload')
    const ctx: any = {
      get: vi.fn((header: string) => header === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
      req: Readable.from([multipartBody(boundary, { filename: 'note.txt', content: 'hello' })]),
      state: { profile: { name: 'research' } },
      body: undefined,
      status: 200,
    }

    await handleUpload(ctx)

    expect(mkdirMock).toHaveBeenCalledWith('/tmp/hermes-web-ui/upload/research', { recursive: true })
    expect(writeFileMock).toHaveBeenCalledOnce()
    const [savedPath, data] = writeFileMock.mock.calls[0]
    expect(normalizePath(savedPath)).toMatch(/^\/tmp\/hermes-web-ui\/upload\/research\/[a-f0-9]+\.txt$/)
    expect(data.toString('utf-8')).toBe('hello')
    expect(ctx.body.files[0]).toMatchObject({ name: 'note.txt', path: savedPath })
  })

  it('parses boundary parameters and RFC 5987 filenames for chat uploads', async () => {
    const boundary = 'test-boundary'
    const { handleUpload } = await import('../../packages/server/src/controllers/upload')
    const ctx: any = {
      get: vi.fn((header: string) => header === 'content-type'
        ? `multipart/form-data; boundary=${boundary}; charset=utf-8`
        : ''),
      req: Readable.from([multipartBody(boundary, { filenameStar: 'daily%20report.txt', content: 'hello' })]),
      state: { profile: { name: 'research' } },
      body: undefined,
      status: 200,
    }

    await handleUpload(ctx)

    expect(writeFileMock).toHaveBeenCalledOnce()
    const [savedPath, data] = writeFileMock.mock.calls[0]
    expect(normalizePath(savedPath)).toMatch(/^\/tmp\/hermes-web-ui\/upload\/research\/[a-f0-9]+\.txt$/)
    expect(data.toString('utf-8')).toBe('hello')
    expect(ctx.body.files[0]).toMatchObject({ name: 'daily report.txt', path: savedPath })
  })

  it('returns 400 for malformed RFC 5987 filenames', async () => {
    const boundary = 'test-boundary'
    const { handleUpload } = await import('../../packages/server/src/controllers/upload')
    const ctx: any = {
      get: vi.fn((header: string) => header === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
      req: Readable.from([multipartBody(boundary, { filenameStar: 'bad%ZZname.txt', content: 'hello' })]),
      state: { profile: { name: 'research' } },
      body: undefined,
      status: 200,
    }

    await handleUpload(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Malformed multipart filename' })
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('neutralizes filenames that attempt path traversal and keeps writes inside uploadDir', async () => {
    const boundary = 'test-boundary'
    const { handleUpload } = await import('../../packages/server/src/controllers/upload')
    const ctx: any = {
      get: vi.fn((header: string) => header === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
      req: Readable.from([multipartBody(boundary, { filename: 'x.txt/../../evil.sh', content: 'boom' })]),
      state: { profile: { name: 'research' } },
      body: undefined,
      status: 200,
    }

    await handleUpload(ctx)

    expect(ctx.status).toBe(200)
    expect(writeFileMock).toHaveBeenCalledOnce()
    const [savedPath] = writeFileMock.mock.calls[0]
    expect(normalizePath(savedPath)).toMatch(/^\/tmp\/hermes-web-ui\/upload\/research\/[a-f0-9]+\.sh$/)
  })

  it('strips traversal segments from the saved extension and keeps the file inside uploadDir', async () => {
    const boundary = 'test-boundary'
    const { handleUpload } = await import('../../packages/server/src/controllers/upload')
    const ctx: any = {
      get: vi.fn((header: string) => header === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
      req: Readable.from([multipartBody(boundary, { filename: 'report.png', content: 'hello' })]),
      state: { profile: { name: 'research' } },
      body: undefined,
      status: 200,
    }

    await handleUpload(ctx)

    expect(ctx.status).toBe(200)
    expect(writeFileMock).toHaveBeenCalledOnce()
    const [savedPath] = writeFileMock.mock.calls[0]
    expect(normalizePath(savedPath)).toMatch(/^\/tmp\/hermes-web-ui\/upload\/research\/[a-f0-9]+\.png$/)
  })

  it('drops dangerous extension characters (path separators, null bytes)', async () => {
    const boundary = 'test-boundary'
    const { handleUpload } = await import('../../packages/server/src/controllers/upload')
    const ctx: any = {
      get: vi.fn((header: string) => header === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
      req: Readable.from([multipartBody(boundary, { filename: 'x\\..\\..\\evil.txt', content: 'boom' })]),
      state: { profile: { name: 'research' } },
      body: undefined,
      status: 200,
    }

    await handleUpload(ctx)

    expect(writeFileMock).toHaveBeenCalledOnce()
    const [savedPath] = writeFileMock.mock.calls[0]
    expect(normalizePath(savedPath)).toMatch(/^\/tmp\/hermes-web-ui\/upload\/research\/[a-f0-9]+\.txt$/)
  })
})
