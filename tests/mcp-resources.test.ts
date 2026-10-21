import { describe, it, expect, vi } from 'vitest'
import { BazaarMcpServer } from '../src/mcp/server'
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js'
import { defaultResources, snapshotResource, type LensResourceDescriptor } from '../src/mcp/resources'

/**
 * #418 — the server advertised only tools, so an agent had to call one every
 * turn to keep facts that barely change in context. These tests pin the other
 * half of the capability: the resources are listed with stable URIs and honest
 * freshness, a read returns the body, and a URI that does not exist is refused
 * as a protocol error rather than a fabricated tool result.
 */

function buildHarness(resources?: LensResourceDescriptor[]) {
  const server = new BazaarMcpServer({
    fetchWithPayment: vi.fn(),
    ...(resources ? { resources } : {}),
  })

  const handlers: Record<string, any> = {}
  ;(server as any).server.setRequestHandler = (schema: any, fn: any) => {
    if (schema === ListResourcesRequestSchema) handlers.list = fn
    if (schema === ReadResourceRequestSchema) handlers.read = fn
  }
  ;(server as any).setupHandlers()

  return {
    server,
    listResources: () => handlers.list(),
    read: (uri: string) => handlers.read({ params: { uri } }),
  }
}

const FIXED = new Date('2026-01-01T00:00:00.000Z').toISOString()

function stubResource(overrides: Partial<LensResourceDescriptor> = {}): LensResourceDescriptor {
  return {
    uri: 'lens://pairs',
    name: 'pairs',
    title: 'Watched pairs',
    description: 'd',
    mimeType: 'application/json',
    read: () => ({ data: { network: 'testnet', pairs: [] }, lastModified: FIXED }),
    ...overrides,
  }
}

describe('BazaarMcpServer resources capability (#418)', () => {
  it('declares resources alongside tools', () => {
    const { server } = buildHarness()
    const capabilities = (server as any).server._capabilities
    expect(capabilities).toHaveProperty('tools')
    expect(capabilities).toHaveProperty('resources')
  })

  it('lists each resource with a stable URI, MIME type and freshness', async () => {
    const { listResources } = buildHarness([stubResource()])
    const { resources } = await listResources()

    expect(resources).toHaveLength(1)
    const [resource] = resources
    expect(resource.uri).toBe('lens://pairs')
    expect(resource.mimeType).toBe('application/json')
    expect(resource.annotations.lastModified).toBe(FIXED)
    expect(resource._meta.version).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(resource._meta.lastModified).toBe(FIXED)
  })

  it('omits lastModified rather than inventing one when a source has no notion of change', async () => {
    const { listResources, read } = buildHarness([
      stubResource({ read: () => ({ data: { constant: true } }) }),
    ])

    const [listed] = (await listResources()).resources
    expect(listed.annotations).toBeUndefined()
    expect(listed._meta.lastModified).toBeUndefined()
    // The version is still reported: it is derived from content, not from time.
    expect(listed._meta.version).toMatch(/^sha256:[0-9a-f]{64}$/)

    const { contents } = await read('lens://pairs')
    expect(contents[0]._meta.lastModified).toBeUndefined()
  })

  it('reads a resource and returns its JSON body with the version', async () => {
    const { read } = buildHarness([
      stubResource({ read: () => ({ data: { network: 'testnet', pairs: ['XLM/USDC'] }, lastModified: FIXED }) }),
    ])

    const { contents } = await read('lens://pairs')
    expect(contents).toHaveLength(1)
    const [body] = contents
    expect(body.uri).toBe('lens://pairs')
    expect(body.mimeType).toBe('application/json')
    expect(JSON.parse(body.text)).toEqual({ network: 'testnet', pairs: ['XLM/USDC'] })
    expect(body._meta.version).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(body._meta.lastModified).toBe(FIXED)
  })

  it('serves a text body verbatim instead of re-serializing it', async () => {
    const document = '{"openapi":"3.0.0","info":{"title":"Lens"}}'
    const { read } = buildHarness([
      stubResource({ uri: 'lens://openapi.json', name: 'openapi', read: () => ({ text: document, lastModified: FIXED }) }),
    ])

    const { contents } = await read('lens://openapi.json')
    expect(contents[0].text).toBe(document)
  })
})

describe('BazaarMcpServer resource refusals (#418)', () => {
  it('rejects an unknown URI as an InvalidParams protocol error', async () => {
    const { read } = buildHarness()
    await expect(read('lens://nope')).rejects.toBeInstanceOf(McpError)
    await expect(read('lens://nope')).rejects.toMatchObject({ code: ErrorCode.InvalidParams })
  })

  it('does not dress an unknown URI up as a readable resource', async () => {
    const { read } = buildHarness()
    // A faked `{ content, isError }` tool result would parse as a successful
    // read here, so the refusal has to travel as an exception instead.
    await expect(read('lens://missing')).rejects.toThrow(/Unknown resource/)
  })

  it('reports an internal error when a resource source fails', async () => {
    const { read } = buildHarness([
      stubResource({
        uri: 'lens://status',
        name: 'status',
        read: () => {
          throw new Error('health check timed out')
        },
      }),
    ])

    await expect(read('lens://status')).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('health check timed out'),
    })
  })
})

describe('MCP default resources (#418)', () => {
  it('exposes the pair list and the OpenAPI document, among others', () => {
    const uris = defaultResources().map((r) => r.uri)
    expect(uris).toContain('lens://pairs')
    expect(uris).toContain('lens://openapi.json')
    expect(uris).toContain('lens://venues')
    expect(uris).toContain('lens://status')
  })

  it('names every resource uniquely, so a handle cannot be ambiguous', () => {
    const descriptors = defaultResources()
    const names = descriptors.map((d) => d.name)
    expect(new Set(names).size).toBe(names.length)
    expect(new Set(descriptors.map((d) => d.uri)).size).toBe(descriptors.length)
  })

  it('advertises the server version passed in, not a hard-coded one', () => {
    const snapshot = snapshotResource(
      defaultResources({ serverVersion: '9.9.9-test' }).find((d) => d.uri === 'lens://status')!
    )
    expect(JSON.parse(snapshot.text).serverVersion).toBe('9.9.9-test')
  })

  it('reports a stable version for identical content and a new one once it changes', () => {
    const forPairs = (keys: string[]): LensResourceDescriptor => ({
      uri: 'lens://x',
      name: 'x',
      title: 'x',
      description: 'x',
      mimeType: 'application/json',
      read: () => ({ data: { pairs: keys } }),
    })
    const once = snapshotResource(forPairs(['XLM/USDC'])).version
    const same = snapshotResource(forPairs(['XLM/USDC'])).version
    const changed = snapshotResource(forPairs(['BTC/USDC'])).version
    expect(once).toBe(same)
    expect(once).not.toBe(changed)
  })

  it('reads the real OpenAPI document from disk, stamped with its file mtime', async () => {
    const { read } = buildHarness()
    const { contents } = await read('lens://openapi.json')
    const document = JSON.parse(contents[0].text)

    expect(document).toHaveProperty('openapi')
    expect(document).toHaveProperty('paths')
    expect(Number.isNaN(Date.parse(contents[0]._meta.lastModified))).toBe(false)
  })

  it('treats status as never cacheable: every read is a new version', async () => {
    const { read } = buildHarness()
    const first = (await read('lens://status')).contents[0]._meta.version
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = (await read('lens://status')).contents[0]._meta.version
    expect(first).not.toBe(second)
  })

  it('keeps the pair and venue lists cacheable: repeat reads agree', async () => {
    const { read } = buildHarness()
    for (const uri of ['lens://pairs', 'lens://venues']) {
      const first = (await read(uri)).contents[0]
      const second = (await read(uri)).contents[0]
      expect(first._meta.version).toBe(second._meta.version)
      expect(first._meta.lastModified).toBe(second._meta.lastModified)
    }
  })

  it('describes the watched pairs on the active network', async () => {
    const { read } = buildHarness()
    const { contents } = await read('lens://pairs')
    const body = JSON.parse(contents[0].text)
    expect(Array.isArray(body.pairs)).toBe(true)
    expect(['testnet', 'mainnet']).toContain(body.network)
  })
})
