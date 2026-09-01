import { beforeEach, describe, expect, it, vi } from 'vitest'

const provider = {
  readFile: vi.fn(),
}
const createFileProviderMock = vi.fn(async () => provider)
const resolveHermesPathMock = vi.fn((relativePath: string, profile = 'default') => {
  const normalized = relativePath.replace(/^\/+/, '')
  return normalized ? `/home/agent/.hermes/${normalized}` : '/home/agent/.hermes'
})
const validatePathMock = vi.fn((filePath: string) => filePath)
const isInUploadDirMock = vi.fn(() => false)

vi.mock('../../packages/server/src/services/hermes/file-provider', () => ({
  createFileProvider: createFileProviderMock,
  localProvider: { readFile: vi.fn(async () => Buffer.from('local')) },
  isInUploadDir: isInUploadDirMock,
  validatePath: validatePathMock,
  resolveHermesPath: resolveHermesPathMock,
  MAX_DOWNLOAD_SIZE: 200 * 1024 * 1024,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: () => 'default',
  getProfileDir: (name: string) => `/home/agent/.hermes${name === 'default' ? '' : `/profiles/${name}`}`,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-path', () => ({
  isPathWithin: (target: string, base: string) => {
    const normTarget = String(target).replace(/\\/g, '/')
    const normBase = String(base).replace(/\\/g, '/')
    return normTarget === normBase || normTarget.startsWith(`${normBase.replace(/\/$/, '')}/`)
  },
}))

vi.mock('../../packages/server/src/config', () => ({
  config: { appHome: '/home/agent/.hermes-web-ui', uploadDir: '/home/agent/.hermes-web-ui/upload' },
}))

vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  requireSuperAdmin: async (ctx: any, next: any) => {
    if (ctx.state.user?.role !== 'super_admin') {
      ctx.status = 403
      ctx.body = { error: 'Super administrator privileges are required' }
      return
    }
    await next()
  },
}))

async function runDownloadRoute(ctx: any) {
  const { downloadRoutes } = await import('../../packages/server/src/routes/hermes/download')
  const layer = downloadRoutes.stack.find((entry: any) => entry.path === '/api/hermes/download')
  if (!layer) throw new Error('Missing download route')

  let index = -1
  async function dispatch(nextIndex: number): Promise<void> {
    if (nextIndex <= index) throw new Error('next() called multiple times')
    index = nextIndex
    const fn = layer.stack[nextIndex]
    if (!fn) return
    await fn(ctx, () => dispatch(nextIndex + 1))
  }

  await dispatch(0)
}

describe('download route security', () => {
  beforeEach(() => {
    vi.resetModules()
    provider.readFile.mockReset()
    createFileProviderMock.mockClear()
    resolveHermesPathMock.mockClear()
    validatePathMock.mockClear()
    provider.readFile.mockResolvedValue(Buffer.from('data'))
  })

  it('requires super admin privileges', async () => {
    const ctx: any = {
      query: { path: '/home/agent/.hermes/config.yaml' },
      state: { user: { role: 'admin' } },
      get: vi.fn(() => ''),
      set: vi.fn(),
      status: 200,
      body: undefined,
    }

    await runDownloadRoute(ctx)

    expect(ctx.status).toBe(403)
    expect(provider.readFile).not.toHaveBeenCalled()
  })

  it('returns 403 for absolute paths outside the allowed roots', async () => {
    const ctx: any = {
      query: { path: '/etc/passwd' },
      state: { user: { role: 'super_admin' } },
      get: vi.fn(() => ''),
      set: vi.fn(),
      status: 200,
      body: undefined,
    }

    await runDownloadRoute(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Access denied', code: 'permission_denied' })
    expect(provider.readFile).not.toHaveBeenCalled()
  })

  it('downloads files that are inside the profile root', async () => {
    const ctx: any = {
      query: { path: 'config.yaml' },
      state: { user: { role: 'super_admin' } },
      get: vi.fn((name: string) => (name === 'content-type' ? '' : '')),
      set: vi.fn(),
      status: 200,
      body: undefined,
    }

    await runDownloadRoute(ctx)

    expect(ctx.status).toBe(200)
    expect(provider.readFile).toHaveBeenCalledWith('/home/agent/.hermes/config.yaml')
    expect(Buffer.isBuffer(ctx.body)).toBe(true)
  })

  it('downloads files from the upload directory via the local provider', async () => {
    isInUploadDirMock.mockReturnValue(true)
    const ctx: any = {
      query: { path: '/home/agent/.hermes-web-ui/upload/file.png' },
      state: { user: { role: 'super_admin' } },
      get: vi.fn((name: string) => (name === 'content-type' ? '' : '')),
      set: vi.fn(),
      status: 200,
      body: undefined,
    }

    await runDownloadRoute(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toBeInstanceOf(Buffer)
  })
})