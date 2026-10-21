import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config, activeNetwork } from '../config.js';

/**
 * A resource an agent can attach to its context once, rather than re-fetching by
 * calling a tool every turn. These are the stable, cacheable facts *about the
 * service itself* — the pairs it quotes, the venues it reads, its OpenAPI
 * document, and its current status.
 *
 * `read` may run on every `resources/list` as well as `resources/read`, so it
 * must stay cheap. Throwing is allowed and surfaces to the caller as a read
 * error.
 */
export interface LensResourceDescriptor {
  /** Stable URI. Clients cache against it, so it must never change shape. */
  uri: string;
  /** Short machine-readable handle, unique within the service. */
  name: string;
  title: string;
  description: string;
  mimeType: string;
  /**
   * Produce the current payload. Supply `text` for a verbatim body (a file
   * served byte-for-byte) or `data`, which is serialized to compact JSON.
   * `lastModified` is the instant the underlying source last changed; omit it
   * when the source genuinely has no notion of change.
   */
  read: () => { data?: unknown; text?: string; lastModified?: string };
}

/** A descriptor resolved to a concrete body plus its freshness metadata. */
export interface LensResourceSnapshot {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  text: string;
  version: string;
  lastModified?: string;
}

export interface LensResourceOptions {
  /**
   * The server name and version reported by `lens://status`. Passed in rather
   * than imported so this module does not depend on `server.ts`, which imports
   * it — the cycle would resolve at call time in CommonJS, but depending on
   * that ordering is not worth it for two strings.
   */
  serverName?: string;
  serverVersion?: string;
}

/**
 * The instant this process resolved its config. The pairs, venues and status
 * resources derive from a config snapshot frozen at import, so "when did this
 * change" for those sources is "when did this process start". Reporting boot
 * time is honest about that: a restart with new env is a new version, and a
 * running process never silently mutates these.
 */
const BOOT_TIME = new Date().toISOString();

/**
 * Content-hash version. A client that cached a previous body compares this to
 * decide whether its copy is still current without diffing the text. Deriving
 * it from the exact bytes we return keeps it truthful: same payload, same
 * version; any change, a new one.
 */
function computeVersion(text: string): string {
  return 'sha256:' + createHash('sha256').update(text).digest('hex');
}

/**
 * Resolve the OpenAPI document path, honoring an operator override.
 *
 * `__dirname`, not `import.meta.url`: this project compiles with
 * `module: commonjs`, under which `import.meta` is a TypeScript error. Two
 * levels up reaches the repo root from both `src/mcp/` and `dist/mcp/`, since
 * `rootDir` is `src` and `outDir` is `dist`.
 */
function openapiPath(): string {
  if (process.env.MCP_OPENAPI_PATH) return process.env.MCP_OPENAPI_PATH;
  return join(__dirname, '..', '..', 'openapi.json');
}

/**
 * The default set of Lens resources, derived only from `config` and the on-disk
 * OpenAPI document — deliberately with no database dependency, for the same
 * reason {@link createLensPriceQueries} lives in its own module: a process that
 * does not opt into Lens's own price data should not pay for importing `pg` and
 * Prisma just to advertise what it watches.
 *
 * A host that does hold that state can pass its own descriptors to
 * `BazaarMcpServer`, exactly as it passes `priceQueries`.
 */
export function defaultResources(options: LensResourceOptions = {}): LensResourceDescriptor[] {
  return [
    {
      uri: 'lens://pairs',
      name: 'pairs',
      title: 'Watched pairs',
      description: 'The asset pairs Lens quotes on the configured network.',
      mimeType: 'application/json',
      read: () => ({
        data: {
          network: activeNetwork,
          // The declared pair list for this network, not the process-wide
          // runtime registry — the same choice `lens_get_price` makes, and for
          // the same reason: pairs added through POST /pairs register against
          // whichever network that API process runs, so reading the registry
          // here could advertise a pair that only exists on another network.
          pairs: config.pairs.map((p) => ({
            pairKey: p.pairKey,
            assetA: p.assetA,
            assetB: p.assetB,
          })),
        },
        lastModified: BOOT_TIME,
      }),
    },
    {
      uri: 'lens://venues',
      name: 'venues',
      title: 'Venues',
      description: 'The liquidity venues Lens reads prices from on the configured network.',
      mimeType: 'application/json',
      read: () => ({
        data: {
          network: activeNetwork,
          venues: [
            { name: 'SDEX', source: 'SDEX', kind: 'orderbook', enabled: true },
            { name: 'AMM', source: 'AMM', kind: 'orderbook', enabled: true },
            { name: 'Soroswap', source: 'soroswap_amm', kind: 'amm', enabled: config.soroswap.enabled },
            { name: 'Aquarius', source: 'aquarius_amm', kind: 'amm', enabled: config.aquarius.enabled },
          ],
        },
        lastModified: BOOT_TIME,
      }),
    },
    {
      uri: 'lens://openapi.json',
      name: 'openapi',
      title: 'OpenAPI document',
      description: "The service's OpenAPI 3 specification, served verbatim as JSON.",
      mimeType: 'application/json',
      read: () => {
        const file = openapiPath();
        const text = readFileSync(file, 'utf8');
        return { text, lastModified: new Date(statSync(file).mtimeMs).toISOString() };
      },
    },
    {
      uri: 'lens://status',
      name: 'status',
      title: 'Service status',
      description: 'Current network, endpoints, venue enablement and watched-pair count.',
      mimeType: 'application/json',
      read: () => {
        const generatedAt = new Date().toISOString();
        return {
          data: {
            serverName: options.serverName ?? 'lens-mcp-server',
            serverVersion: options.serverVersion ?? '0.0.0-unknown',
            network: activeNetwork,
            generatedAt,
            horizonUrl: config.horizon.url,
            rpcUrl: config.rpc.url,
            watchedPairCount: config.pairs.length,
            venues: {
              soroswap: config.soroswap.enabled,
              aquarius: config.aquarius.enabled,
              oracle: config.oracle.enabled,
            },
          },
          // Status is defined by being current: every read is a new version, so
          // a client knows it must not treat this as a long-lived cache.
          lastModified: generatedAt,
        };
      },
    },
  ];
}

/** Resolve a descriptor into the body plus version/freshness returned to clients. */
export function snapshotResource(descriptor: LensResourceDescriptor): LensResourceSnapshot {
  const { data, text: rawText, lastModified } = descriptor.read();
  const text = rawText ?? JSON.stringify(data);
  return {
    uri: descriptor.uri,
    name: descriptor.name,
    title: descriptor.title,
    description: descriptor.description,
    mimeType: descriptor.mimeType,
    text,
    version: computeVersion(text),
    lastModified,
  };
}
