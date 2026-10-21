# MCP resources

The Lens MCP server (`src/mcp/server.ts`) offers an agent two kinds of thing:

- **Tools** — functions it calls to *do* something: `bazaar_search`,
  `paid_call`, `lens_get_price`.
- **Resources** — read-only content it attaches to its context once, instead of
  re-fetching by calling a tool every turn.

Resources are for the stable, cacheable facts *about the service itself*. Each
has a fixed URI, an accurate MIME type, and freshness an agent can rely on.

## Resource URIs

| URI | MIME type | Contents | `lastModified` comes from |
| --- | --- | --- | --- |
| `lens://pairs` | `application/json` | The pairs Lens quotes on the configured network: `{ network, pairs: [{ pairKey, assetA, assetB }] }`. | the instant this process resolved its config |
| `lens://venues` | `application/json` | The venues Lens reads from, each with its `source` and whether it is `enabled` here. | the instant this process resolved its config |
| `lens://openapi.json` | `application/json` | The service OpenAPI 3 document, served verbatim. | the file's on-disk mtime |
| `lens://status` | `application/json` | Network, Horizon/RPC URLs, venue enablement, watched-pair count, server name and version. | the read instant |

A URI never changes shape. Adding a field to a payload is fine; renaming a URI,
or reusing one for different content, is not.

## Freshness

Every resource reports two things, on `resources/list` and on `resources/read`:

- **`version`** — `sha256:<hex>` over the exact bytes returned, in
  `_meta.version`. A client compares it against the copy it cached, so it can
  decide whether to re-read without diffing the text. Identical payload means an
  identical version.
- **`lastModified`** — ISO-8601, in `annotations.lastModified` on list and
  `_meta.lastModified` on both. Omitted when a source has no notion of change
  rather than filled in with something invented.

`lens://status` embeds its own generation time, so every read is a new version.
That is deliberate: status is defined by being current, and a version that
survived two reads would be a lie about it.

`resources/list` resolves each resource to compute this metadata instead of
returning a static catalogue. These payloads are small and cheap, and stale
freshness metadata is worse than none.

## Refusals

Reading a URI that does not exist throws an MCP `InvalidParams` error, and a
resource source that fails throws `InternalError`. Neither is expressed as a
tool-style `{ isError, code }` payload: `ReadResourceResult` has no such field,
so a fabricated one would be parsed as a successful read.

This is also why the resources work adds nothing to the `MCP_ERROR_CODES`
vocabulary in `./codes.ts`. That vocabulary answers "why did the money or the
fetch fail" — `ERR_URL_BLOCKED` for an address we will never reach,
`ERR_HOST_NOT_ALLOWED` for a host we will not pay. "No such resource" is a
different question, and the protocol already has a typed answer for it.

## Overriding the sources

The defaults read only `config` and the on-disk OpenAPI document — no database —
for the same reason `createLensPriceQueries` lives in its own module: a process
that has not opted into Lens's own price data should not pay for importing `pg`
and Prisma just to list what the service watches. `lens://pairs` therefore
reports the *declared* pair list for the network, not the process-wide runtime
registry, matching what `lens_get_price` accepts.

A host that does hold that state can inject its own descriptors, exactly as it
injects `priceQueries`:

```ts
new BazaarMcpServer({
  fetchWithPayment,
  resources: [
    {
      uri: 'lens://pairs',
      name: 'pairs',
      title: 'Watched pairs',
      description: 'Pairs Lens quotes, including those added at runtime.',
      mimeType: 'application/json',
      read: () => ({ data: { network, pairs: getActivePairs() } }),
    },
  ],
});
```

## Configuration

`MCP_OPENAPI_PATH` overrides which file `lens://openapi.json` serves. Unset, it
is the `openapi.json` at the package root. Set it only when the document sits
elsewhere, e.g. mounted separately in a container.
