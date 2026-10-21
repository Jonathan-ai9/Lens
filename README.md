# Lens — Unified Stellar Price API

[![CI](https://github.com/Miracle656/Lens/actions/workflows/ci.yml/badge.svg)](https://github.com/Miracle656/Lens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Stellar](https://img.shields.io/badge/Stellar-SDEX%20%2B%20AMM-black)](https://stellar.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Aggregates price data from Stellar's Classic Order Book (SDEX) and AMM Liquidity Pools into a single, unified API.

**What Horizon doesn't do:** Horizon's `/trade_aggregations` only covers SDEX. AMM pool prices (derived from reserve ratios) are not aggregated anywhere. Lens fills this gap.

## Endpoints

### REST
| Method | Path | Description |
|---|---|---|
| GET | `/price/:assetA/:assetB` | Current VWAP, 24h volume, best route |
| GET | `/price/:assetA/:assetB/route?amount=1000` | Best execution route for a given amount |
| GET | `/price/:assetA/:assetB/depth?amount=1000` | Simulated order-book depth and execution slippage |
| GET | `/book/:assetA/:assetB?depth=0.1&step=0.01&network=testnet` | Aggregated SDEX book and synthetic AMM price ladder with cumulative size and venue provenance |
| GET | `/price/:assetA/:assetB/history?window=1h` | OHLCV history (`1m`, `5m`, `1h`, `24h`) |
| GET | `/price/twap/:assetA/:assetB?window=60&sampleInterval=60&method=iqr` | Manipulation-resistant time-weighted average price |
| GET | `/price/vwap/:assetA/:assetB?window=60&source=SDEX&method=iqr` | Volume-weighted average price |
| GET | `/candles/:assetA/:assetB?interval=1h&from=…&to=…` | OHLCV candles (`1m`, `5m`, `15m`, `1h`, `4h`, `1d`) |
| GET | `/prices/history?pair=XLM/USDC&from=…&to=…&interval=1m` | Historical 1-minute price snapshots, optionally aggregated (`1m`, `5m`, `1h`); honours `?network=`; `?format=csv` serves the points as `text/csv` (`ts,price,volume`); ~30-day retention |
| GET | `/pools` | Active AMM pools being watched |
| GET | `/pairs` | Watched trading pairs |
| GET | `/volumes/:asset?window=24h` | Cross-venue traded volume (`24h`, `7d`, `30d`) with a per-venue breakdown |
| GET | `/spreads/:asset?window=5m` | Per-venue bid/ask spread, tightest first (`5m`, `15m`, `1h`, `24h`) |
| GET | `/compare/:asset` | Lens vs configured oracle prices, with per-oracle deviation and availability |
| GET | `/screener?sortBy=volume&order=desc&limit=20` | Screen pairs by volume, 24h change, liquidity and price |
| GET | `/benchmark/:asset?target=USD` | Peg-deviation statistics versus a target |
| GET | `/basket?asset=XLM&asset=USDC&weight=0.6&weight=0.4` | Weighted price of a basket of assets |
| GET | `/status` | Indexer health |
| GET | `/snapshot?network=testnet\|mainnet` | Whole-network snapshot: venues, TVL, 24h volume, top pairs, peg readings and data freshness in one cached, timestamped object |
| GET | `/live` | Liveness probe — no dependency checks (see [`docs/health.md`](docs/health.md)) |
| GET | `/ready` | Readiness probe — boot complete + dependencies reachable |
| GET | `/discovery/resources?type=&payTo=&network=&extensions=&limit=&offset=` | Bazaar catalog of x402-discoverable resources (spec: [`bazaar`](https://github.com/x402-foundation/x402/blob/main/specs/extensions/bazaar.md)) |
| GET | `/usage/me` | Usage and quota for the calling API key (requires `Authorization: Bearer <key>`) |
| GET | `/supported` | Payment kinds and extensions this facilitator supports |
| POST | `/verify` | Verify an x402 payment payload |
| POST | `/settle` | Settle an x402 payment (idempotent — retries replay the stored result) |
| POST | `/webhooks` | Subscribe to a price-threshold webhook |
| DELETE | `/webhooks/:id` | Delete a webhook subscription |
| GET/POST | `/graphql` | GraphQL query/mutation endpoint (GraphiQL IDE at `/graphiql`, docs: [`docs/graphql.md`](docs/graphql.md)) |

Every non-internal route above has a matching entry in [`openapi.yaml`](openapi.yaml);
`tests/openapi.test.ts` boots the server and fails if a registered route is
missing from the spec. Operator-only and non-HTTP routes (`/admin/keys*`,
`/admin/usage*`, `/metrics`, `/ws`, `/graphiql*`) are deliberately excluded via
the commented allow-list in [`src/openapi/coverage.ts`](src/openapi/coverage.ts).

The `?network=testnet\|mainnet` query param (or `x-network` header) selects the
Stellar network. It is validated on every request — an unrecognised value gets a
`400` — and defaults to this instance's `STELLAR_NETWORK`. Only the routes whose
spec entry declares a `network` parameter answer for the selected network; the
ones listed below still read a single instance-wide network.

Per-request today: `/price/:assetA/:assetB` (its VWAP, OHLCV, AMM and
best-route reads), `/price/:assetA/:assetB/route`, `/price/:assetA/:assetB/depth`, `/book/:assetA/:assetB`,
`/prices/history`, `/screener`, `/pools`, `/pairs`, `/spreads/:asset`,
`/volumes/:asset`, `/status`, and the x402 payment `network`/`payTo`. That list
is the same one `openapi.yaml` declares a `network` parameter on — if they ever
disagree, the spec is the thing to fix.

Still reading across both networks, and ignoring the parameter:
`/candles/:assetA/:assetB`, `/price/twap/*`, and `/price/vwap/*`.

### API key authentication errors

API-key authentication failures return HTTP 401 with a machine-readable `code`:

| Code | Meaning |
|---|---|
| `missing` | No Authorization header was supplied. |
| `malformed` | The Authorization header is not a valid Bearer header. |
| `unknown` | The key was not recognized; never-issued and unknown keys have the same response. |
| `revoked` | The recognized key has been revoked. |
| `expired` | The recognized key has passed its expiry time. |

Unknown keys always receive the same response, regardless of whether the key
ever existed. Admin-token failures use `admin_unauthorized`.

Admin key creation accepts an optional future ISO date-time in `expiresAt`.
Omitting it creates a key without an expiry.

```bash
curl "https://api.example.com/price/XLM/USDC?network=mainnet"
```

### Data Quality Guarantees
For formal guarantees on pricing freshness (including the 300s staleness threshold), completeness (venue diversity and outlier filtering), precision (PostgreSQL Decimal(36,18) and negotiated decimal strings), venue inclusion across SDEX and AMMs, and deterministic violation semantics, see [`docs/data-quality.md`](docs/data-quality.md).

### GraphQL
Available at `/graphql` with GraphiQL IDE at `/graphiql`. Real-time price
streaming is available via the `priceUpdated` [subscription](#graphql-subscriptions-live-prices).

For complete GraphQL schema documentation, all queries with runnable `curl` examples, WebSocket `graphql-transport-ws` handshake specifications, and an explicit comparison against the REST surface, see [`docs/graphql.md`](docs/graphql.md).

```graphql
query {
  getPrice(assetA: "XLM", assetB: "USDC") {
    price
    bestRoute
    vwap1h
    volume24h
    priceChange24h
  }
  getBestRoute(assetA: "XLM", assetB: "USDC", amount: 500) {
    route
    sdexPrice
    ammPrice
    estimatedOutput
    slippagePct
    recommendation
  }
}
```

#### Schema Definition & SDL Artifact
The GraphQL schema is exported as a canonical Schema Definition Language (SDL) artifact committed at [`schema.graphql`](schema.graphql).

- **Location**: [`schema.graphql`](schema.graphql)
- **Regenerate / Refresh**:
  ```bash
  npm run graphql:schema:gen
  ```
- **Drift Guard & Validation**: CI runs `src/__tests__/graphqlSchemaDrift.test.ts` to assert that `schema.graphql` matches the code-defined schema in `src/api/graphql.ts`, guarantees deterministic output, validates SDL syntax for client generators, and detects breaking schema changes.


## Observability

Prometheus metrics are exposed on `GET /metrics` (public, no API key required).

Alongside the ingestion and database metrics, Lens exports HTTP request,
latency, authentication and rate-limit signals:

| Metric | Type | Labels |
|---|---|---|
| `http_requests_total` | Counter | `method`, `route`, `status_class` |
| `http_request_duration_seconds` | Histogram | `method`, `route` |
| `api_key_auth_failures_total` | Counter | `reason` |
| `admin_auth_failures_total` | Counter | — |
| `rate_limit_rejections_total` | Counter | `scope` |
| `global_shed_requests_total` | Counter | — |

`route` is the matched route **template** (`/price/:assetA/:assetB`), never the
resolved URL, so the number of time series stays bounded no matter how many
distinct assets are queried. `status_class` is `2xx`/`4xx`/`5xx` rather than the
exact code, for the same reason.

```promql
# Request rate
sum(rate(http_requests_total[5m])) by (route)

# Error rate
sum(rate(http_requests_total{status_class="5xx"}[5m]))
  / sum(rate(http_requests_total[5m]))

# p95 latency
histogram_quantile(0.95,
  sum(rate(http_request_duration_seconds_bucket[5m])) by (le))
```

See [`docs/http-metrics.md`](docs/http-metrics.md) for the full label reference,
the bucket rationale and suggested alerting rules.

The websocket stream carries its own signals — `ws_clients_total`,
`ws_messages_sent_total`, `ws_messages_dropped_total`, `ws_clients_dropped_total`
and `ws_buffered_bytes` — which exist to make slow subscribers visible instead
of silent. See [`docs/websocket-backpressure.md`](docs/websocket-backpressure.md).

The ingestion metrics are labelled by `network` as well, so a dual-network
deployment reports each network separately:

| Metric | Type | Labels |
|---|---|---|
| `trades_ingested_total` | Counter | `pair`, `network` |
| `amm_snapshots_total` | Counter | `pool`, `network` |
| `price_snapshots_total` | Counter | `network` |
| `last_trade_timestamp` | Gauge | `pair`, `network` |

`last_trade_timestamp` is a gauge, so without the `network` label one network's
ingester overwrites the other's value for the same pair — which would make the
staleness signal silently unusable. See
[`docs/ingest-metrics.md`](docs/ingest-metrics.md) for the cardinality notes
(`pairs x networks`) and a staleness alert.

### GraphQL Subscriptions (live prices)

Lens exposes a `priceUpdated(pair)` subscription that pushes a message every time
an ingester (SDEX, Horizon AMM, or Soroswap) records a new price for the pair.
It runs over the same `/graphql` endpoint using the `graphql-transport-ws`
protocol, so any [`graphql-ws`](https://github.com/enisdenjo/graphql-ws) client works.

```graphql
subscription {
  priceUpdated(pair: "XLM/USDC", network: "mainnet") {
    pair
    price
    ts
    network
  }
}
```

```bash
npm install graphql-ws ws
```

```typescript
import { createClient } from "graphql-ws";
import WebSocket from "ws"; // browsers already have WebSocket globally

const client = createClient({
  url: "ws://localhost:3002/graphql",
  webSocketImpl: WebSocket, // omit in the browser
});

// `subscribe` returns an unsubscribe function — call it to close the channel.
const unsubscribe = client.subscribe(
  {
    query: `subscription ($pair: String!, $network: String) {
      priceUpdated(pair: $pair, network: $network) { pair price ts network }
    }`,
    variables: { pair: "XLM/USDC", network: "mainnet" },
  },
  {
    next: ({ data }) => console.log("price:", data.priceUpdated),
    error: (err) => console.error("subscription error:", err),
    complete: () => console.log("subscription closed"),
  },
);

// Later — stop receiving updates and close the socket cleanly:
// unsubscribe();
```

> **`network` is optional but you almost always want it.** Since #117 every
> enabled network runs its own ingester loop and they all publish to the same
> stream, so omitting it interleaves testnet and mainnet prices for the same
> pair. Every message carries its own `network` field, so an omitted argument
> is safe *if* you read that field — and misleading if you do not.

> **Note:** the `pair` argument is the canonical `pairKey` (alphabetically
> sorted, e.g. `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN/XLM`). Use the `listPairs` query to discover
> the exact keys being indexed. Only the pair you subscribe to is delivered;
> updates for other pairs are filtered out server-side. For full protocol handshake details and a raw WebSocket implementation, see [`docs/graphql.md`](docs/graphql.md#live-price-subscriptions-graphql-transport-ws).

## MCP (Model Context Protocol)

Lens exposes its Bazaar catalog of x402-discoverable resources as an MCP
server, so any MCP-compatible client or agent can discover and pay for price
data through two tools: `bazaar_search` and `paid_call`. The server signs
x402 payment challenges with Stellar secret keys on both `stellar:testnet`
and `stellar:pubnet`.

**⚠️ Warning:** the mainnet key signs with real XLM. Read the configuration,
spending warning, and worked example before running.

Full documentation: [examples/mcp-server/README.md](examples/mcp-server/README.md)

### WebSocket backpressure

`/ws` counts a message as sent only once the socket reports the write completed,
and bounds what a client that stops reading can cost: past 256 KiB of queued
bytes updates are coalesced to the newest one, past 1 MiB — or congested for 30s
— the client is closed with `1013` and counted. A truncated feed is visible in
`ws_messages_dropped_total` rather than silent, and one slow client cannot affect
any other. See [`docs/websocket-backpressure.md`](docs/websocket-backpressure.md).

## Usage Examples

Lens gates `/price`, `/pools`, and `/candles` behind x402 micropayments on Stellar (testnet by default). The `/status` endpoint is free.

### 1. Free health check (no payment)

```bash
curl http://localhost:3002/status
# {
#   "ok": true,
#   "network": "testnet",
#   "watchedPairs": ["XLM:native/USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"],
#   "lastIndexedLedger": 53842917,
#   "lastProcessedAt": "2026-05-07T18:45:11.220Z",
#   "ingestLagSeconds": 4
# }
```

`/status` answers for one network — pass `?network=mainnet` (or the
`x-network` header) to check the mainnet indexer instead. `ingestLagSeconds` is
`null` until that network has ingested, and `lastIndexedLedger` is `null` until
its SDEX ingester has recorded a trade.

### 2. Paid request without `X-PAYMENT` → `402` with payment requirements

```bash
curl -i http://localhost:3002/price/XLM/USDC
# HTTP/1.1 402 Payment Required
# content-type: application/json
#
# {
#   "x402Version": 1,
#   "accepts": [
#     {
#       "scheme": "exact",
#       "price": "$0.10",
#       "network": "stellar:testnet",
#       "payTo": "G...your-oracle-address..."
#     }
#   ],
#   "error": "Payment required",
#   "description": "Unified SDEX+AMM price with VWAP and best route"
# }
```

The `accepts[]` array lists every payment requirement the server will honor. Sign one of them, encode as JSON, base64-encode, and resend with the `X-PAYMENT` header.

### 3. Paid request with `X-PAYMENT` → `200` with price data

```bash
# X-PAYMENT is base64(JSON(signed payment payload — see @x402/stellar))
curl -H "X-PAYMENT: $(cat payment.b64)" \
     http://localhost:3002/price/XLM/USDC
# {
#   "assetA": "XLM",
#   "assetB": "USDC",
#   "pairKey": "XLM:native/USDC:GA5...",
#   "vwap1m": "0.12450000",
#   "vwap1h": "0.12410000",
#   "volume24h": "1284390.5500",
#   "priceChange24h": "0.32",
#   "bestRoute": "amm",
#   "lastUpdated": "2026-05-07T18:46:02.114Z"
# }
```

### 4. Node.js — automatic payment with `@x402/fetch` + `@x402/stellar`

`@x402/fetch` wraps the native `fetch` so a `402` is intercepted, signed, and retried automatically — your application code looks like a normal request.

```bash
npm install @x402/fetch @x402/stellar
```

```typescript
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer } from "@x402/stellar";

// 1. Sign with a Stellar testnet secret (S...). Fund via friendbot first.
const signer = createEd25519Signer(
  process.env.STELLAR_SECRET!, // e.g. "SBN...FUNDED..."
  "stellar:testnet",
);

// 2. Wrap fetch — `stellar:*` matches both pubnet and testnet.
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    {
      network: "stellar:*",
      client: new ExactStellarScheme(signer),
    },
  ],
});

// 3. Call the gated endpoint. The 402 → sign → 200 dance is automatic.
const res = await fetchWithPayment("http://localhost:3002/price/XLM/USDC");
const data = await res.json();
console.log(`XLM/USDC VWAP-1h: ${data.vwap1h}`);
```

> **Mainnet:** swap `STELLAR_NETWORK=mainnet` on the server, point the
> client at `stellar:pubnet`, and supply a custom Soroban RPC URL via
> `new ExactStellarScheme(signer, { url: "https://your-rpc..." })`.
> Stellar payments use *ledger-based* expiration (~12 ledgers ≈ 60s),
> not timestamps.

### 5. GraphQL price query

```bash
curl -X POST http://localhost:3002/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ getPrice(assetA:\"XLM\", assetB:\"USDC\") { price vwap1h volume24h priceChange24h } }"}'
```

Or interactively at [http://localhost:3002/graphiql](http://localhost:3002/graphiql).

> **Note:** the current `GATED_ROUTES` map in [`src/middleware/x402.ts`](src/middleware/x402.ts) gates `/price`, `/pools`, and `/candles` only — `/graphql` is not gated. If you intend price data from GraphQL to require the same payment as REST, extend `GATED_ROUTES` (or add a per-resolver guard).

## Documentation
Detailed system design and data flow diagrams can be found in the [Architecture Overview](docs/architecture.md).
The API specification is available in [OpenAPI 3.0 format](openapi.yaml) and is auto-published to GitHub Pages at https://miracle656.github.io/lens/openapi.json.

Operational docs: [HTTP metrics](docs/http-metrics.md), [ingest metrics](docs/ingest-metrics.md), [websocket backpressure](docs/websocket-backpressure.md), [health probes](docs/health.md), [GraphQL](docs/graphql.md).
The MCP server also advertises read-only [resources](docs/mcp-resources.md) — the watched pairs, venues, this OpenAPI document, and service status — each with a stable URI and freshness an agent can cache against.

## Examples

The [oracle relay example](examples/oracle-relay/README.md) shows a minimal Soroban contract plus a Node relay that reads Lens prices and pushes them on chain.

The [price alert bot example](examples/alert-bot/README.md) shows an "if XLM > X notify me" bot built on the WebSocket price stream — see the [cookbook walkthrough](docs/cookbook/alert-bot.md).

## Docker Quickstart
The fastest way to get Lens running locally is with Docker:

```bash
# Start Lens, Postgres, and Redis
docker compose up -d

# Check health
docker compose ps
```
The API will be available at `http://localhost:3002`. Database migrations run automatically on startup.

## Quick Start (Manual)

```bash
# 1. Start PostgreSQL + Redis
docker-compose up -d

# 2. Install dependencies
npm install

# 3. Copy env
cp .env.example .env

# 4. Push database schema
npm run db:push

# 5. Seed the database with fixture data
npm run seed

# 6. Start dev server
npm run dev
```

## Seed & Query

A fresh clone gives an empty database — every price endpoint returns zeros and
you cannot tell working code from broken code. `npm run seed` writes
deterministic fixture data so the API is immediately usable.

### What it seeds

| Table | Rows per network | Description |
|---|---|---|
| `pair_configs` | 1 | Default pair registration so `/pairs` and `/price` resolve immediately |
| `price_points` | 36 (24 SDEX + 12 AMM) | Hourly SDEX trades and bi-hourly AMM trades over 24 h |
| `pool_snapshots` | 6 | AMM pool reserves every 4 h |
| `price_aggregates` | 49 (12×1m + 12×5m + 24×1h + 1×24h) | Pre-computed OHLCV buckets |

Data is seeded for the default pair on each network:
- **testnet:** `XLM / USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
- **mainnet:** `XLM / USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`

### Usage

```bash
# Seed both networks (default)
npm run seed

# Seed a single network
npm run seed -- --network testnet
npm run seed -- --network mainnet
```

### Idempotency

The seed guarantees idempotency by **converging to the same deterministic row set**.
Timestamps are anchored to the current UTC hour (`Math.floor(Date.now() / 3_600_000) * 3_600_000`), keeping fixture data fresh relative to `NOW()` (satisfying service-level queries bounded by 1 h / 24 h intervals).

To prevent duplicate accumulation across runs while keeping timestamps fresh, re-seeding safely cleans up previously seed-owned rows (`where: { id: { startsWith: 'seed-' }, network }`) before inserting the fresh set. Default pair configs use `skipDuplicates: true` on `@@id([network, pairKey])` so existing pairs are preserved.

```
$ npm run seed

🌱 Lens seed complete

  testnet  (USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM)
    pair_configs     1 inserted (1 total)
    price_points     36 inserted (36 total)
    pool_snapshots   6 inserted (6 total)
    price_aggregates 49 inserted (49 total)

  mainnet  (USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN/XLM)
    pair_configs     1 inserted (1 total)
    price_points     36 inserted (36 total)
    pool_snapshots   6 inserted (6 total)
    price_aggregates 49 inserted (49 total)

  ✅ testnet: 1 pair_configs, 36 price_points, 6 pool_snapshots, 49 price_aggregates
  ✅ mainnet: 1 pair_configs, 36 price_points, 6 pool_snapshots, 49 price_aggregates

$ npm run seed   # re-seed: cleans seed rows & converges to the same row set

🌱 Lens seed complete

  testnet  (USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM)
    pair_configs     0 inserted (1 total)
    price_points     36 inserted (36 total)
    pool_snapshots   6 inserted (6 total)
    price_aggregates 49 inserted (49 total)

  mainnet  (USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN/XLM)
    pair_configs     0 inserted (1 total)
    price_points     36 inserted (36 total)
    pool_snapshots   6 inserted (6 total)
    price_aggregates 49 inserted (49 total)

  ✅ testnet: 1 pair_configs, 36 price_points, 6 pool_snapshots, 49 price_aggregates
  ✅ mainnet: 1 pair_configs, 36 price_points, 6 pool_snapshots, 49 price_aggregates
```

### Verify with the API

After seeding, start the server (`npm run dev`) and confirm the endpoints
return real data:

```bash
# /pairs — lists watched pairs with latest price
curl -s http://localhost:3002/pairs | jq '.pairs[0]'
# {
#   "pairKey": "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM",
#   "assetA": { "code": "XLM", "issuer": null },
#   "assetB": { "code": "USDC", "issuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
#   "latestPrice": 0.11906825,
#   "lastUpdated": "<seeded-anchor-timestamp>"
# }

# /pools — lists AMM pool snapshots
curl -s http://localhost:3002/pools | jq '.pools[0]'
# {
#   "pool_id": "65c24738ce0ba076fd4f4d3b66618681ca1f9e9d78c95bb8db3a684a82bb3ee0",
#   "asset_a": "XLM",
#   "asset_b": "USDC",
#   "reserve_a": 550000,
#   "reserve_b": 66000,
#   "spot_price": 0.12,
#   "fee_bp": 30,
#   "timestamp": "<seeded-anchor-timestamp>"
# }

# /price/:assetA/:assetB — aggregated VWAP + best route
curl -s http://localhost:3002/price/XLM/USDC | jq '{price, ammPrice, lastUpdated}'
# {
#   "price": 0.11906825,
#   "ammPrice": 0.12,
#   "lastUpdated": "<request-timestamp>"
# }
```

*(Note: timestamp values above reflect the dynamic hourly anchor at seed execution time and request time).*


## Environment Variables

| Variable | Description | Default | Required |
|---|---|---|---|
| `NODE_ENV` | Environment mode (`development`, `test`, `production`) | `development` | No |
| `PORT` | API server port | `3002` | No |
| `HOST` | API server host | `0.0.0.0` | No |
| `GLOBAL_RATE_LIMIT_MAX` | Maximum accepted non-health requests per rolling minute per instance | `1000` | No |
| `DATABASE_URL` | PostgreSQL connection string | - | **Yes** |
| `REDIS_URL` | Redis connection string | - | **Yes** |
| `PRICE_CACHE_TTL` | Cache duration for price data (seconds) | `10` | No |
| `HORIZON_URL` | Stellar Horizon server URL | - | No |
| `RPC_URL` | Soroban RPC server URL | - | No |
| `NETWORK_PASSPHRASE` | Stellar network passphrase | - | No |
| `STELLAR_NETWORK` | `mainnet` or `testnet` — this instance's default/ingested network | `testnet` | No |
| `POLL_INTERVAL_MS` | Indexer polling frequency (ms) | `5000` | No |
| `SDEX_PAGE_SIZE` | Trades per page for SDEX ingestion | `200` | No |
| `AMM_PAGE_SIZE` | Trades per page for AMM ingestion | `200` | No |
| `ADMIN_API_KEY` | Key for admin route authentication | - | No |
| `WATCHED_PAIRS` | Comma-separated list of asset pairs to index | - | **Yes** |
| `ORACLE_PAYMENT_ADDRESS` | Stellar address for x402 API payments | - | No* |
| `ORACLE_PAYMENT_ADDRESS_TESTNET` / `ORACLE_PAYMENT_ADDRESS_MAINNET` | Per-network override for the address above | - | No |
| `X402_FACILITATOR_URL` | x402 facilitator service URL | - | No |

*\*Required if enabling x402 payment gating.*

## Stack
- **Runtime:** Node.js 20 + TypeScript
- **API:** Fastify + Mercurius (GraphQL)
- **Database:** PostgreSQL + TimescaleDB
- **Cache:** Redis
- **Queue:** BullMQ
- **Stellar:** @stellar/stellar-sdk


### Deployed smoke check

Run against a real running instance (local, staging or production):

```bash
SMOKE_MAX_AGE_SECONDS=120 SMOKE_TIMEOUT_MS=8000 npm run smoke -- http://localhost:3002
```

Validate the smoke checker itself with `npm run test:smoke`.

The check requires public `/status`, `/live` and `/ready`, plus `/price/XLM/USDC`. It uses a
`graphql-transport-ws` live price subscription at `/graphql`. Both probes must be
present and healthy — a missing `/ready` fails the run rather than being skipped,
since a smoke check that silently tolerates an absent probe is how a deployment
ends up unmonitored while still green. It checks
indexer and trade freshness, validates price shape, and waits for a real
subscription event. It fails non-zero, naming the failing check, on timeout,
stale data, a missing message, or HTTP errors. No synthetic price events are
generated. On installations where x402 payment gates the price endpoint,
a normal unauthenticated call receives HTTP 402 and the smoke check fails;
it never bypasses payment requirements. A quiet pair without any new trades
will likewise fail the live-message requirement.
