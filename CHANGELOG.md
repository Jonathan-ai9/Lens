# Changelog

## 0.3.0

### Minor Changes

- Add pagination and a revoked filter to `GET /admin/keys`. `limit` (default 50, max 100) and `offset` page the listing, `revoked=true|false` (default `false`) selects live or revoked keys, and the response adds `pagination` metadata with the total matching count. Invalid values return 400.
- ad9152e: Add a network-aware aggregated `/book/:assetA/:assetB` endpoint with live SDEX levels, synthetic AMM reserve steps, cumulative depth, and source provenance.
- Add a single enumerated set of stable, machine-readable error codes. Every JSON
  error response now carries a `code` beside its existing `error` string: `error`
  stays human-readable and may be reworded at any time, while `code` is a contract
  a client can branch on instead of matching on sentences.

  The codes are declared once in `src/errors.ts`, emitted through a shared
  `apiError` helper, and mirrored in `openapi.yaml`. A guard test fails the build
  if the spec and the enum drift apart, or if any route emits a code outside the
  set — so a typo cannot ship as a new code.

- Record when an API key was last used to authenticate (#500). `api_keys.last_used_at` is stamped on each successful authentication, throttled to one write per key per `KEY_LAST_USED_THROTTLE_SECONDS` (default 60) so authentication stays a read for busy keys, and surfaced on `GET /admin/keys` — null meaning the key has not authenticated since the column existed, which is what makes an abandoned key visible. A failed write never refuses a valid request, but is logged once per key rather than swallowed.
- Cache API-key lookups in-process so authentication is no longer a Postgres round-trip per request (#495). Positive and negative lookups are held for `API_KEY_CACHE_TTL` seconds (default 30), the cache is bounded at 10,000 entries so invalid keys cannot grow it without limit, hit/miss is exported as `api_key_cache_lookups_total`, and a key's own `expiresAt` is re-checked on every hit so the TTL can never outlive the key. Revoking or rotating a key drops its cached entry immediately on the instance handling the request; another instance picks it up within the TTL. Rotation now also carries the old key's scopes to the replacement.
- c8e96b3: Serve every public route under a `/v1` version segment, keeping the
  unversioned paths as deprecated aliases that answer identically.

  `src/api/versioning.ts` strips the segment in a Fastify `rewriteUrl` hook before
  the request is routed, so `/v1/price/XLM/USDC` and `/price/XLM/USDC` resolve to
  the same route definition — same handler, same auth, same x402 gating and rate
  limits — rather than being mounted twice and drifting. Existing callers are not
  broken: the unversioned form keeps working, and every response to it now carries
  `Deprecation: true` and a `Link: </v1/...>; rel="successor-version"` header
  pointing at the versioned path. The versioned response carries neither.

  `openapi.yaml` (and the generated `openapi.json`) now document the `/v1` paths;
  `tests/openapi.test.ts` asserts that every documented versioned path maps onto a
  registered route, that the unversioned alias exists for each, and that the two
  forms answer identically. Operator-only and non-HTTP routes (`/metrics`, `/ws`,
  `/admin/*`, `/graphiql*`) are excluded and remain unversioned.

  The warning contract and the alias-retirement window — at least two minor
  releases, no more than twelve months — are written down in
  [`docs/api-versioning.md`](docs/api-versioning.md).

- 36eb950: Automatic cataloging of resources from discovery extension upon settlement (#130)
- 81d8e59: Add seller-side Bazaar discovery helpers (`src/bazaar/declare.ts`): `param.*`
  constructors that make per-parameter descriptions a required positional
  argument, `declareHttpResource` / `declareMcpTool` builders that assemble the
  `extensions.bazaar` declaration and its JSON Schema, and
  `validateDeclaration` / `assertDeclaration` which run the catalog's own
  `validateListing` plus seller-side metadata-quality rules so malformed listings
  fail at development time rather than in production. Lens's own gated routes
  (`/price`, `/candles`, `/pools`, `/price/twap`, and the MCP price tool) are
  declared with them in `src/bazaar/lensListings.ts`.
- 4dc40a3: Ingest Blend lending pool state (#212). A dedicated ingester reads pool reserves over Soroban, derives utilisation and supply/borrow APR, and stores them in `lending_rates` — not `price_points`, because a lending rate is not a spot price. `GET /rates/:asset` serves them, a retention job prunes old rows, and the cycle is bounded by the same per-ingester deadline every other loop uses.
- a1c5637: Ship the first real centralized-exchange adapter in `src/ingest/cex/` (issue #215). The directory previously held only the `CexAdapter` interface and a mock, so every cross-venue comparison compared Stellar venues against nothing. `CoinbaseAdapter` implements `CexAdapter` in full — `fetchTicker` and `fetchOrderBook` against Coinbase Exchange's public market-data endpoints — and is built and registered through a new exchange-agnostic `createCexAdapter(name)` factory (`registerCexAdapterFactory` wires concrete exchanges in).

  It normalises pairs in both directions, mapping the Lens canonical form (`XLM/USD`) to the identifier the exchange actually uses (`XLM-USD`) and back, since a slash-form request 404s. Requests are throttled to Coinbase's published public limit (10 req/s per IP, burst up to 15) with a token bucket; a `429` honours `Retry-After` when present and otherwise backs off exponentially. Any outage, timeout, non-2xx, or malformed body degrades to a `null` return — the adapter never throws, so a dead exchange cannot take down the process or surface an error response. Prices carry a distinct `source` (`coinbase_cex`) and take the `network` from the caller rather than hard-coding it, so a CEX number is never mistaken for, or silently blended with, an on-chain one.

- 98c8dff: Serialise decimal quantities as exact strings across the API boundary via header/query/Accept negotiation to preserve 18-decimal precision without IEEE-754 floating-point loss.
- 0dfa3ba: DeFindex vault shares are now priced. A new `DeFindex` venue adapter
  (`src/ingest/venues/defindex.ts`) enumerates every vault from the protocol's
  on-chain factory registry, reads each vault's total managed assets and total
  share supply straight from the chain, and derives the share price as
  `totalAssets / totalShares` — never from a published figure that could be stale.
  A vault with zero shares yields no point rather than dividing by zero. Rows are
  written with `source = 'defindex_vault'` so a derived vault price is never
  silently blended with a traded one, and each row carries the network it was read
  from, so the ingester runs once per `ENABLED_NETWORKS` entry without merging
  mainnet and testnet series. The factory contract ids are taken whole from DeFindex's
  published `mainnet.contracts.json` / `testnet.contracts.json`.
- 33c6308: Add GET /discovery/search with relevance ranking and quality evaluation (#129)
- 373f389: Add GET /price/:asset/fiat for local currency conversion and naira valuation (#290)
- 059ca5a: Add a `priceUpdated(pair: String!, network: String)` GraphQL subscription that streams live prices over the existing `/graphql` endpoint (graphql-transport-ws protocol). Every ingester (SDEX, Horizon AMM, Soroswap) publishes `{ pair, price, ts, network }` on each new price; subscribers receive only the pair they request. `network` is optional and narrows the stream to one chain — omitting it delivers every enabled network, which is only safe if the subscriber reads the `network` field on each message, since a dual-network deployment otherwise interleaves two chains' prices for the same pair.
- 1e7da6d: Add a `screener` GraphQL query (#367). REST and GraphQL now share one implementation in `src/services/screener.ts`, so filters, sorting, the keyset cursor and the `[1, 100]` limit clamp cannot drift between the two surfaces. `sortBy` and `order` are allow-listed at the SQL boundary, and every CTE is scoped to a single network.
- e37c85e: **Breaking:** range endpoints now use half-open intervals — `[from, to)`, not
  `[from, to]`. `from` is inclusive, `to` is exclusive.

  `GET /candles/:assetA/:assetB` and `GET /prices/history` previously returned
  samples with `timestamp` in `from..to` inclusive at both ends. A caller paging
  back-to-back windows (`[T0, T1]`, then `[T1, T2]`) got every sample landing
  exactly on `T1` **twice** — once in each response — so the two windows
  together double-counted the boundary and inflated any total, average or VWAP
  computed over them.

  `to` is now exclusive. Adjacent windows `[T0, T1)` and `[T1, T2)` share no
  boundary, and a sample landing exactly on `T1` appears in exactly one of the
  two responses.

  Callers that relied on the inclusive end must widen their `to` by one tick
  (the smallest interval they query) to keep the same rows — e.g. `[T0, T1]` is
  now `[T0, T1 + 1s)` at `interval=1m`.

  Every `price_points` query now also carries the `network` predicate, so the
  `(network, pair_key, timestamp)` index is usable and a pair's price is never a
  blend of two chains. `GET /candles/:assetA/:assetB` and `GET /basket` were
  reading both networks; `GET /benchmark/:asset` was computing its deviation
  figures from both. They now default to the active network and honour
  `?network=` / `x-network`.

- 39f565f: Add `/live` and `/ready`, so a platform can tell "kill this one" apart from
  "stop sending traffic here".

  `/status` answered neither question. It reads `indexer_state`, so it fails when
  Postgres is unreachable — useless as a liveness signal — and it says nothing
  about whether the process has finished booting. `app.listen()` runs part-way
  through `main()`, before the ingesters, the retention worker and the websocket
  fan-out start, so between listening and those loops running the process accepts
  requests it cannot yet answer.

  `GET /live` touches no dependency and stays healthy while Postgres is down or
  the app is still booting. That is the point: a liveness probe that fails during
  a database outage has the orchestrator restarting every instance at once.

  `GET /ready` reports `503` with `ok: false` until `main()` finishes booting, and
  while Postgres is unreachable or unmigrated, or Redis is unreachable when Redis
  is part of readiness (`READINESS_REDIS_CHECK`, default true). The Postgres check
  is one `to_regclass` query answering both reachability and whether migrations
  were applied — reachability alone would report a process with no tables as
  ready. Probes are bounded by `READINESS_TIMEOUT_MS` and answers cached for
  `READINESS_CACHE_MS`, so polling every few seconds costs at most one round trip
  per dependency per interval.

  Both are public, allow-listed from rate limiting next to `/status`, sent
  `Cache-Control: no-store`, and excluded from `http_requests_total` — a
  fixed-interval poller would otherwise put a floor under the request rate that no
  amount of real traffic dropping could go below. `/status` is unchanged.

  The deployed smoke check now requires both probes instead of skipping `/ready`
  when it is absent, and fails on a failing `/live`.

- 5306598: Bound every ingester cycle with a deadline so one slow upstream can no longer stall an ingester while every health signal still reports it as healthy. Each round of a venue loop (SDEX, AMM, Soroswap, Aquarius) or the snapshot appender now runs under `runCycleWithDeadline`: a cycle over its deadline is aborted at its next unit checkpoint, counted in the new `ingester_abandoned_cycles_total` metric (`venue`, `network` labels) and logged, and the following cycle starts only after the abandoned one has unwound — two cycles against the same venue can never overlap, and because every checkpoint sits _before_ a write unit rather than inside one, an abandoned cycle can never leave a partial write. The per-ingester deadline is configurable via `INGEST_CYCLE_DEADLINE_MS` with `<VENUE>`/`<NETWORK>` overrides (0 disables it), venue adapters receive the cycle `AbortSignal` as an optional third `ingestPair` argument, and `startVenueAdapter` accepts an optional `stopSignal` so a loop can be stopped cleanly at a cycle boundary.
- ef57dd4: Publish market coverage ratio overall and per asset (`GET /coverage` and `GET /coverage/:asset`) comparing Lens indexed trade volume and count against total Stellar network activity from Horizon over a time window. Document reproducible methodology in `docs/coverage-methodology.md`, report unflattering 0% coverage faithfully, and return `coverageRatio: null` with `status: "unanswerable"` when network activity is zero.
- 0ce55ff: The MCP server can now serve Streamable HTTP, selected with `MCP_TRANSPORT=http`.
  Until then stdio was the only transport, so the server could only be used by a
  client able to launch this process on the same machine — which rules out every
  hosted agent, and means the agent's secret key has to be installed on each
  machine that wants to pay.

  HTTP reaches the network, so it is only allowed to start authenticated.
  `resolveMcpTransportConfig` (`src/mcp/config.ts`) requires a non-empty
  `MCP_HTTP_AUTH_TOKEN` before anything else happens, and `runHttp()` throws again
  if handed a blank one, so an unauthenticated remote server with `paid_call` in
  its tool list cannot be brought up by configuration or by an embedding caller.
  The example entrypoint resolves the transport before it builds a signer: a
  server that cannot authenticate callers never reaches the point where it can
  spend. Every request must then present `Authorization: Bearer <token>`, compared
  over SHA-256 digests with `timingSafeEqual`; a missing, malformed or wrong token
  is refused with `401`, `www-authenticate: Bearer realm="lens-mcp"` and the new
  `ERR_UNAUTHORIZED` code, before the body is read and before any tool runs. The
  token is never echoed back into an error message or a log line.

  It binds `127.0.0.1` unless `MCP_HTTP_HOST` says otherwise, answers MCP only on
  `MCP_HTTP_PATH` (default `/mcp`), rejects anything else with `404` without
  revealing whether the path exists, and requires `POST` — `GET` gets `405`, which
  spec-compliant clients read as "no server-initiated stream" rather than an
  error. Bodies are capped at 1 MiB and must be `application/json`, so a caller
  cannot make the payment path stream an unbounded request.

  Both transports register the same tools from the same code path, and share
  one spend budget and payment ledger per process, so a remote client cannot spend
  past a ceiling a local one already used. State is deliberately not shared
  across requests: the SDK's stateless Streamable HTTP transport is single-use — a
  second request on one instance throws, because message ids from different
  clients would collide — so each `POST` gets its own protocol server and
  transport.

  stdio remains the default: with `MCP_TRANSPORT` unset, or set to `stdio`, the
  server talks to stdin and stdout exactly as before. An unrecognised value throws
  instead of quietly falling back, because a server that silently ignored the
  transport it was told to serve would be hard to trust with a key.

- 3b86612: Add the `lens_get_price` MCP tool, so an agent connected over MCP can ask Lens for
  an aggregated price instead of only searching and paying other people's Bazaar
  nodes. Assets are `CODE` or `CODE:ISSUER`, the issuer binds when both sides name
  one (a same-named asset is refused with `ERR_ASSET_ISSUER_MISMATCH`, never
  priced), the network defaults to the one the server runs, and the answer is
  structured content carrying the price, venues, source count, confidence, the age
  of the last trade and the best route.
- c753139: Add the `lens_list_pairs`, `lens_get_pools` and `lens_screen_pairs` MCP tools
  (#409), so an agent that can already ask for a price can also ask what is
  quotable, what liquidity stands behind it and what is moving — the three
  questions REST answered and MCP did not, which left an agent guessing asset
  codes. Each tool runs the function its REST route runs (`listPairs`, `listPools`
  and the screener service behind `GET /screener` and the GraphQL query), so a
  page over MCP is the same rows, filters and cursor as a page over HTTP. Pages
  are bounded by the server's configured page limit and carry `nextCursor` and
  `hasMore`; a page too large for the tool output limit is returned labelled as
  truncated, without a cursor that would skip the rows it dropped. Every asset
  carries its issuer in full, since a Stellar asset code alone identifies nothing,
  and each description says which of the three questions it answers.
- 94bd8ea: Gate `paid_call` behind an operator allow-list of hosts (#404). The tool pays
  whatever URL it is given, up to `MCP_MAX_PAYMENT_PRICE`, from a live key — and
  an agent that reads attacker-influenced text is one sentence from being told
  which URL. `paidCallAllowlist` (server config, `MCP_PAID_CALL_ALLOWED_HOSTS`)
  lists origins or URL prefixes; an unlisted, non-http(s) or credential-bearing
  URL is refused with `ERR_HOST_NOT_ALLOWED` naming the host, before any request
  is sent, and the list cannot be widened by a tool argument. The default is
  empty, which pays nobody.
- c889e70: Multi-hop routing through configurable intermediate assets bounded in depth.

  - Evaluates multi-hop routes (up to `ROUTING_MAX_HOPS`, defaulting to 3) across configurable intermediate assets (`ROUTING_INTERMEDIATES`, defaulting to XLM and Circle USDC).
  - Names each hop with its input/output assets, execution venue (`SDEX` | `AMM`), pool ID if applicable, price, spot price, and slippage percentage.
  - Shows side-by-side comparison between direct routes and multi-hop paths, ensuring direct routes win when they produce higher output.
  - Returns comprehensive execution provenance including sample timestamps, target network, queried venues, total sample count, and data freshness age in seconds.
  - Adds test coverage verifying thin pairs where two hops beat a direct trade.

- ebb21a3: Add `GET /pegs` (`/v1/pegs`) endpoint reporting current and rolling-window worst peg deviations (in basis points) and provenance (venues, sample count, and freshness) across all configured pegged assets (`PEGGED_ASSETS_TESTNET`, `PEGGED_ASSETS_MAINNET`, `PEGGED_ASSETS`).
  - Defaults to Circle `USDC` pegged to `USD:1.0` per network (`USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5=USD:1.0` on testnet and `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN=USD:1.0` on mainnet) when `PEGGED_ASSETS*` is unset so deployed instances report the canonical USD stablecoin peg out of the box rather than returning an empty list.
  - Shares `DEFAULT_PEG_TOLERANCE_BPS = 100` (100 bps = 1.0%) with `GET /snapshot` (`PEG_TOLERANCE_BPS = 100`) and the peg-deviation alerting engine (#322, default band = 0.01 = 100 bps).
  - `GET /snapshot` consults `NetworkConfig.pegged` first when evaluating watched-pair pegs so configured targets and non-1.0 target prices never disagree between `/pegs` and `/snapshot`, while retaining its built-in 1:1 fiat stablecoin ticker map (`PEGGED_ASSETS`) as a fallback for unconfigured watched pairs and stablecoin-sibling reference quotes (`USDC/USDT`).
- 93c55cf: Add Phoenix, a Soroban AMM venue, as a price source. `src/ingest/venues/phoenix.ts`
  enumerates pools from Phoenix's own factory contract (`query_pools`) — never from a
  list kept in this repo — reads each pool's reserves with `query_pool_info`, derives
  the constant-product spot price, and writes `price_points` rows tagged
  `source: 'phoenix_amm'` with the pool's contract id in `poolId`. A watched pair is
  matched to a pool by deriving the Stellar Asset Contract id from its `{code, issuer}`
  and the network passphrase, so two assets sharing a code but not an issuer can never
  blend into one series.

  The discovered pool list is cached per network for `PHOENIX_POOL_CACHE_TTL_MS`
  (default 10 minutes) with single-flight refreshing, and a refresh that fails keeps the
  previous list and leaves the TTL un-advanced so the next cycle retries. The adapter is
  registered in `venueAdapters`, so `ENABLED_NETWORKS` starts one independently
  fault-isolated Phoenix instance per network, each writing rows stamped with its own
  network. An unreachable Phoenix RPC degrades this venue to "no Phoenix price today" —
  it logs and returns empty rather than throwing.

  Config: `PHOENIX_FACTORY_ADDRESS_MAINNET` defaults to Phoenix's published mainnet
  factory, `CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKMI`, taken verbatim
  from the protocol's own repository. Phoenix publishes no testnet deployment, so testnet
  has no built-in id: the venue stays disabled there until an operator sets
  `PHOENIX_FACTORY_ADDRESS_TESTNET`. `PHOENIX_ENABLED_<NETWORK>`,
  `PHOENIX_POLL_INTERVAL_MS` and `PHOENIX_POOL_CACHE_TTL_MS` round out the surface, all
  documented in `.env.example`.

- db4126d: Implement a retention policy and background worker for `price_points`:
  - Rolls raw `price_points` older than `PRICE_POINTS_RETENTION_DAYS` (default 30 days) into 1-hour `price_aggregates` prior to pruning, preserving historical OHLCV, VWAP, venue volume breakdowns, and trade counts with full numeric precision.
  - Deletes expired raw points in bounded batches (`PRICE_POINTS_PRUNE_BATCH_SIZE`, default 1,000) using `FOR UPDATE SKIP LOCKED` and yields between batches to prevent holding prolonged database locks.
  - Scopes every query by `network` to utilize indexes and prevent cross-network data contamination.
  - Exports Prometheus metrics `price_points_pruned_total` and `price_points_rolled_up_total` labeled by `network`.
  - Includes BullMQ scheduling and in-process hourly fallback for lifecycle resilience.
- 40014f4: Adopt Prisma migrate: commit a baseline migration (`prisma/migrations/0_init`), make CI fail on drift between `schema.prisma` and the migrations, switch app startup and deploys to `prisma migrate deploy`, and remove the `db push` path.

  Startup adopts the baseline by itself on a database that predates the migration history — it records the baseline as applied without running it, rather than colliding with tables that are already there — so the order of a merge and a redeploy cannot take the API down. Dropping `db push` also means schema drift is no longer self-healed at boot: `docs/database-migrations.md` has the one-time check to run against a live database before the first deploy.

- c5f598d: Build a question-led API route index (#305) generated directly from the OpenAPI specification to prevent documentation drift:
  - Annotate every documented route in `openapi.yaml` with `x-question`, `x-example`, `x-order`, and `x-category`.
  - Order routes by newcomer exploration journey rather than HTTP URL or method, with detailed rationale documented across 7 stages.
  - Provide concrete, non-elided examples without shortened addresses or contract IDs, echoing network parameter where supported.
  - Introduce `scripts/generate-question-index.ts` and `npm run index:gen` to compile `docs/what-lens-knows.md` and keep the `README.md` endpoint table synchronized.
  - Extend `tests/openapi.test.ts` to assert every Fastify registered route has a plain-English question, fail when a route lacks a question, verify contiguous newcomer ordering, and guard against drift in `README.md` and `docs/what-lens-knows.md`.
- 634ac0c: Every pricing response (`/price/:assetA/:assetB`, `/price/twap/:assetA/:assetB`, and `/price/vwap/:assetA/:assetB`) now carries:

  - `newestInputObservedAt`: ISO 8601 timestamp of its newest input data point (`null` if no trades exist)
  - `inputCount`: the count of inputs used in the computation
  - `stalenessThresholdSeconds`: the staleness bound in seconds
  - `stale`: boolean flag indicating whether the newest input is older than the staleness threshold

  The staleness bound defaults to 300 seconds (configurable globally via `PRICE_STALE_THRESHOLD_SECONDS` or `STALENESS_BOUND_SECONDS`) and can be customized per request using the `staleThreshold` query parameter. All routes and schemas are declared in `openapi.yaml` and synchronized in `openapi.json`.

- 83d9bd7: Lens publishes prices. A SEP-40 (`oracle/contract/`) oracle contract plus a
  rate-limited, deviation-triggered publisher (`src/publish/`) put Lens's own
  aggregate on chain so Soroban contracts can read a Lens price, with the same
  staleness and venue-provenance guarantees the HTTP API makes.

  The contract implements the spec's `PriceFeedTrait` verbatim — `base`, `assets`,
  `decimals`, `resolution`, `price`, `prices`, `lastprice` — returning `None`
  rather than reverting on input it cannot answer, and adds one provider-side
  write: `report(asset, price, timestamp, venues)`, authorized solely by the
  publisher address the admin sets. It re-checks every rule a consumer is told to
  rely on: the price is positive, the timestamp is trimmed to `resolution()`, is
  not ahead of ledger time, and is strictly newer than the last record, and the
  venue list is non-empty — `source_count` is derived from that list, never passed
  in. `last_report` exposes the venues, the ledger and the close time behind the
  current price. `initialize` is one-shot and `upgrade` swaps the WASM without
  changing the contract address, as SEP-40 requires.

  The publisher is a loop like the venue ingesters: one per entry in
  `ENABLED_NETWORKS`, each fault-isolated by `restartIngester`, each reading only
  its own network's pairs and rows. Which leg of a pair it quotes and whether the
  stored `price = assetB per assetA` has to be inverted are derived from the
  `base()` the _deployed contract_ reports — the scale and tick come from the
  chain too, and the cycle aborts if they cannot be read, because there is no safe
  default for a number a contract settles against. Publication then runs as
  guards → triggers → write vetoes: staleness and provenance are checked before
  the feed is read at all, so a stale aggregate provably never reaches RPC or
  spends a fee; a write needs either a `SEP40_DEVIATION_PCT` move measured against
  the price already on chain or a `SEP40_MAX_INTERVAL_MS` timer, and even then
  `SEP40_MIN_WRITE_INTERVAL_MS` caps it at one transaction per asset per interval.
  `SEP40_MAX_AGE_SECONDS` defaults to 120, stricter than the API's 300 s stale
  flag on purpose.

  Every write — and every failed write — lands in a new `oracle_publications`
  table with the venues behind it, the scaled value, the trigger, the deviation and
  the tx hash. Blocked decisions are logged, not stored: a 30-second poll across
  two networks would otherwise be a table of "nothing happened".

  Off by default on every network (`SEP40_ENABLED_*=false`), needs a deployed
  contract id and a funded publisher key, and refuses to start half-configured. No
  secret key is committed anywhere, and the docs deliberately contain no feed
  contract id. No REST or GraphQL route is added.

- 7d187ea: Add `GET /snapshot`: one cached, network-scoped summary of a network's venues
  (liveness), AMM liquidity (TVL, per-asset reserves and per-pool detail), 24h
  traded volume (per venue, with a single-unit total only when the pairs share a
  unit), the busiest pairs with their price direction, stablecoin peg readings,
  and data freshness. All figures come from a single database statement with one
  `as_of` clock, and unknowns are reported as `null` with a reason rather than
  invented. The endpoint is public and never 404s.
- Split the CORS policy across three route tiers (#268). Public reads stay open to any origin with no credentials; credentialed routes are restricted to `CORS_ALLOWED_ORIGINS` with `credentials: true`; admin routes are closed to cross-origin browsers unless `CORS_ADMIN_ALLOWED_ORIGINS` names them. A request carrying `Authorization` or `Cookie` is treated as credentialed whatever it asks for, so a browser cannot be handed `Access-Control-Allow-Origin: *` for an authenticated call. A bare `*` is refused for the credentialed and admin tiers, and a wildcard entry must match the scheme it names.
- 794eb07: Document and separate process health from data health on `GET /status` (#273). The response now carries `status`, `health.process`, `health.data`, a `process` block (uptime, heap) and a `data` block (last ledger, lag, `isStale`); the previous top-level fields are unchanged, so existing consumers keep working. Ingest lag over 300s reports `status: "degraded"` with a 200, and a Postgres failure returns 503 with `pagingCondition: "DATABASE_DOWN"` — so an uptime monitor pages on infrastructure, not on upstream ledger delay. The 503 body is a fixed phrase: `/status` is public, so the driver's message goes to the log, never the response. `health.process` is read from boot state, so the first seconds of a deploy report a degraded process with healthy data.
- 2eda5a2: Add a generated TypeScript client at `clients/typescript`. `npm run client:gen`
  regenerates `clients/typescript/src/schema.d.ts` from `openapi.yaml` with
  `openapi-typescript`, and `openapi-fetch` gives a typed `createLensClient`, so
  every request and response type is derived from the spec and nothing is
  hand-maintained. CI regenerates the client and fails if the committed copy
  differs from `openapi.yaml`, then typechecks it with
  `npm run client:typecheck`. `clients/typescript/src/example.ts` is a documented
  usage example; the README explains how to regenerate and use the client.
- 1a332bb: Classify venues as primary markets or aggregators and report net and gross volume separately (#244). `/volumes/:asset` now returns `totals.net` (summed across primary venues) alongside `totals.gross` (everything observed), so an aggregator re-reporting a trade that already settled on a primary market no longer inflates the headline figure. Aquarius and DeFindex are aggregators; SDEX, the native AMM, Soroswap and Phoenix are primary. The reasoning for each is documented in `docs/venues.md`, and a test fails the build if the adapter and the documented classification ever disagree.
- 6c97743: Add trade-size and volume-concentration statistics to `GET /volumes/:asset`, with per-network filtering and response provenance.
- 5ea669e: Bound what a slow websocket client can cost the process.

  `WebSocket#send()` neither blocks nor throws when a peer is slow, it queues.
  Nothing inspected `bufferedAmount`, so one subscriber that stopped reading — a
  suspended mobile client, a wedged TCP window — accumulated price updates in its
  socket buffer without limit, and the message was counted as sent the moment it
  was queued. With the feed pushing continuously, one stuck subscriber was enough
  to grow the process until it was OOM-killed, taking every other subscriber and
  every HTTP client with it.

  `FanOutManager` now applies a per-client policy in
  [`src/ws/backpressure.ts`](https://github.com/Divinity-Labs/Lens/blob/main/src/ws/backpressure.ts):
  past `WS_SLOW_CLIENT_BUFFER_BYTES` (256 KiB) updates are coalesced to the newest
  one, past `WS_MAX_BUFFERED_BYTES` (1 MiB) — or congested for longer than
  `WS_MAX_CONGESTED_MS` (30s) — the client is closed with `1013` and counted in
  `ws_clients_dropped_total`. Superseded updates count in
  `ws_messages_dropped_total`, so a truncated feed is visible rather than silent,
  and `ws_buffered_bytes` reports total queued bytes. All the limits are
  configurable, and none of them can slow down delivery to any other client.

  `ws_messages_sent_total` now increments when the socket reports the write
  completed rather than when `send()` returned, so it counts what was written
  rather than what was queued. The websocket metrics also moved from
  prom-client's global default registry onto the one `/metrics` renders, which is
  where they were supposed to be visible all along.

### Patch Changes

- 45aae33: Guard admin endpoints structurally (#514). An `onRequest` hook enforces `ADMIN_TOKEN` over every route that declares `{ admin: true, auth: 'admin' }` or is registered under `/admin/`, so a new admin endpoint is protected by where it lives rather than by its handler remembering to call `isAdminAuthorized`. `public: true` now means genuinely unauthenticated, and all seven admin routes declare the admin tier instead. The guard reads the matched route pattern, not `req.url`, so a percent-encoded path cannot route to an admin handler while reading as non-admin.
- Distinguish an unconfigured admin surface from a rejected token (#508). `checkAdminAuth` returns `authorized` / `unauthorized` / `not_configured`, and admin routes answer 503 `admin_not_configured` when `ADMIN_TOKEN` is unset, blank or an obvious placeholder, instead of a 401 that tells an operator their correct token is wrong. The structural admin hook makes the same three-way distinction, startup logs a warning when the surface is disabled, and `GET /status` reports `adminConfigured` — whether a token is set, never any part of its value.
- e091749: Partition the aggregation layer by network. Every function in
  `src/aggregator/vwap.ts` now takes a required `network` and filters
  `price_points`/`pool_snapshots` on it, and `getAMMPrice` filters both the
  `pool_snapshots` scan and the `pool_id` subquery. Previously an unfiltered read
  returned a volume-weighted blend of both chains' rows for a pair key that
  exists on both, so `/price/:a/:b` answered with a number nobody traded at and
  stamped it `"network":"mainnet"`.

  `/price/:assetA/:assetB` passes `req.network` through to the aggregator, so the
  `network` field in the response is the one the numbers came from. The aggregate
  refresh worker now runs once per enabled network — its own queue name, its own
  pair list, and `price_aggregates` upserts stamped with its network — where it
  previously pinned all three to `STELLAR_NETWORK`, leaving the second network's
  `/price/*/history` and `/screener` permanently empty. The Redis price key it
  writes is network-prefixed, matching what the REST route reads.

- 90f3269: `bazaar_search` no longer fetches any URL it is handed (#407). The MCP server now
  parses the target, refuses anything that is not `http`/`https`, resolves the
  hostname and rejects it if any address is private, loopback, link-local, or a
  cloud metadata endpoint (e.g. `169.254.169.254`), and follows redirects manually
  so a permitted host cannot bounce the request to a forbidden address. Operators
  can constrain reachable hosts further with the shared `OUTBOUND_ALLOWED_HOSTS`
  list, which narrows access but never re-opens a blocked address. Blocked requests
  return the new `ERR_URL_BLOCKED` code.
- 71f8e42: An empty `bazaar_search` result is a success, not an error (#414). A search that ran correctly and matched nothing returned `isError: true` with `ERR_NO_RESULTS`, which an agent answers by retrying or rephrasing — a paid call spent on a question already answered. It now returns the empty collection. `ERR_NO_RESULTS` is unchanged for `lens_get_price`, where a refused pair really is an error.
- 8e8d8ab: Enforce ratePerDay daily quota on authenticated API keys (#175)
- 1c883e3: A failed venue fetch is no longer indistinguishable from an empty venue (#329). The Horizon AMM pool fetch, the Soroswap token list, the Aquarius pool fetch and the Reflector oracle read now all return one result shape, `{ ok: true, data } | { ok: false, error }`, instead of turning an error into `[]` or `null`. A failure is logged (Reflector used to swallow it silently) and recorded per source, network and pair; the next successful fetch clears it. `aggregatePrice` excludes a failed source from the composite and from the deviation baseline instead of counting it as though it answered with nothing, and returns the failed sources as `failedSources`. `GET /status` lists them under `failedSources` (source, network, pair or asset, time; the error text stays in the log because the route is public).
- 7ba1f47: Preserve TWAP timestamp alignment when outlier prices are rejected.
- 4ddc5c2: Generate README venues section and endpoints table from code registries:
  - Added `scripts/generate-readme.ts` (`npm run readme:gen`) to render the venues table from `venueAdapters` and the endpoints table from `openapi.yaml`.
  - Added `type` and `description` to `VenueAdapter` and existing venue adapters (SDEX, AMM, Soroswap, Aquarius).
  - Added `tests/readme.test.ts` to assert that `README.md` venues and endpoints sections never drift from source registries.
- a6dcd93: `GET /prices/history` accepts `?format=csv`, returning the points as a
  `text/csv` body (`ts,price,volume`, RFC 4180 quoting, LF endings, one trailing
  newline); JSON stays the default and an unknown format is rejected with 400
  before the database is queried. The serializer is `historyToCsv()` in
  `src/api/history.ts`, and `tests/historical.golden.test.ts` byte-compares it —
  plus the HTTP response — against `tests/fixtures/historical-*.csv`, so column
  order, timestamp and number formatting, and line endings cannot drift without
  failing the suite.
- d546b0b: `GET /prices/history` now honours `?network=` / `x-network` instead of always
  querying the deployment's default network, and echoes the resolved `network`
  in the response. `queryHistory()` takes `network` as a parameter.
- Retry Horizon rate limiting instead of reading it as empty data (#348). `fetchHorizonJson` honours `Retry-After` when Horizon sends one and otherwise backs off exponentially with jitter, raises `HorizonRateLimitError` once the attempts are spent so the runner counts and backs off the whole cycle, and exports `horizon_rate_limit_remaining` from the `X-RateLimit-Remaining` header. Requests go through `fetchWithTimeout`, so they carry the configured HTTP timeout and the cycle deadline's abort signal — including during the retry wait.
- 5ef1591: Add a `network` label to the four ingest metrics — `trades_ingested_total`,
  `amm_snapshots_total`, `price_snapshots_total` and `last_trade_timestamp` — so a
  dual-network deployment (`ENABLED_NETWORKS=testnet,mainnet`) reports each
  network separately instead of folding them together.

  `last_trade_timestamp` is the one that mattered: it is a gauge, so the testnet
  ingester's `set()` was overwriting mainnet's value for the same pair every poll
  interval, making Lens's only staleness signal silently unusable — it still
  looked like a plausible timestamp. The counters were less broken but equally
  unqueryable per network, since the two loops summed into one series.

  Cardinality is unchanged in character: `pairs x networks` (plus `pools` on
  `amm_snapshots_total`), all bounded by `WATCHED_PAIRS` and `ENABLED_NETWORKS`.
  No `issuer` or `pool` label was added. Existing queries that did not filter by
  `network` keep working and now return one series per network instead of a
  merged one, so a recording rule that aggregated across networks before will see
  one additional series per pair.

  Documented in [`docs/ingest-metrics.md`](docs/ingest-metrics.md).

- 9601518: Validate ingest price ticks with rolling-median plausibility check and persist outliers to quarantine table (#238).
- Venue ingestion failures are logged through pino on the `ingester:<venue>` child logger, with `venue`, `network`, `pair`, `attempt`, `retryMs`, `durationMs` and `err` as queryable fields, so an operator can count failures per pair and see the stack. The convention is documented in `docs/logging.md`.
- 28af3ba: MCP tool results are size-bounded (#416). Every result was serialised
  pretty-printed and in full, so one large — or hostile — response could consume an
  agent's entire context window, and the failure looked like a bad model rather
  than an unbounded tool. All four tools (`bazaar_search`, `paid_call`,
  `payment_budget`, `lens_get_price`) now return compact JSON capped at
  `MCP_MAX_RESULT_BYTES`, and a truncated result says so: `truncated: true`, the
  total, the page returned, and a notice explaining how to ask for more.
  `bazaar_search` gains `limit` / `offset` arguments (defaults and ceiling from
  `MCP_DEFAULT_PAGE_LIMIT` / `MCP_MAX_PAGE_LIMIT`), forwards them to the node, and
  pages whatever comes back even if the node ignores them. `lens_get_price` keeps
  `structuredContent` only while the payload fits, since shipping it regardless
  would move the blow-up into another field.

  Upstream bodies are read through a capped stream reader (`MCP_MAX_UPSTREAM_BYTES`)
  that keeps the part that fits and cancels the rest, so an oversized body is never
  buffered in full. A discovery body too large to parse returns
  `ERR_RESPONSE_TOO_LARGE`, which — unlike `ERR_URL_BLOCKED` and
  `ERR_HOST_NOT_ALLOWED` — is not a refusal to ask: the request succeeded, the
  answer is simply too big to hand over.

- 59cc2a0: Every `paid_call` now leaves a record of what it cost. A successful call used to
  return the response body and nothing else: no log line, metric or persisted trace
  of which URL was paid, how much, on which network, with which transaction. For a
  tool that signs with a real key, the audit trail is not an enhancement — without
  it there is no answer to "where did today's money go", and the cumulative ceiling
  had no measurement of spend to read.

  `PaymentLedger` (`src/mcp/ledger.ts`) writes one JSON line per attempt to
  `MCP_PAYMENT_LEDGER_FILE` (default `~/.lens-mcp/payments.jsonl`): timestamp, full
  URL, host, method, price, asset, network, transaction hash, the call's outcome,
  what the ledger can vouch for about the money (`settled`, `possible` or `none`)
  and the error code if the call failed. A failed call is recorded too, because a
  payment can settle on a call that then errors — `outcome` and `spend` are separate
  fields so "the call failed" never implies "nothing left the account".

  The price is not on the `Response` the x402 client hands back; it is only visible
  on the payment header the transport puts on the request. So the ledger wraps that
  transport's fetch (`instrumentFetch`) and correlates the offer with the response
  it produced. The settlement header is read for the transaction hash and for
  whether the seller confirmed it.

  `mcp_payment_attempts_total` (labels `host`, `network`, `outcome`) and
  `mcp_payment_amount_usd_total` (labels `host`, `network`) export the same spend to
  Prometheus on the shared registry, which `MCP_TRANSPORT=http` now serves from the
  MCP process itself at `GET /metrics` — a counter nobody can scrape is not an
  export. That route answers only to the same bearer token as the tools: what an
  agent bought, on which host and for how much describes a key that moves money.
  `MCP_HTTP_PATH=/metrics` is refused at boot rather than resolved by precedence, so
  one path never has two meanings. Under stdio there is no listener, so the running
  total there is what `payment_budget` reports and what the audit file holds.

  Labels come from `MCP_METRIC_HOSTS` and `MCP_METRIC_NETWORKS` (default
  `stellar:testnet,stellar:pubnet`, the networks this agent signs for): series are
  permanent, so labelling by whatever URL an agent asks for would let one caller mint
  unbounded time series, and anything outside an allow-list is reported as `unknown`.
  The audit file always keeps the real host. Amounts that are not a USD money string
  are recorded verbatim but cannot join the USD sum, so `mcp_payment_unquantified_total`
  and `totalSpend().unquantifiedPayments` make that understatement visible instead of
  silent.

  No secret material is recorded. Only the seller's echoed `accepted` requirements are
  read out of the payment header; the signed envelope alongside it never reaches a
  record, a metric or the file, and every header field is length-capped so a seller
  cannot forge extra lines into the trail.

  Accounting fails closed in both directions: if the audit file cannot be created or a
  record cannot be written, `paid_call` is refused with `ERR_INTERNAL_FAILURE` rather
  than spending unrecorded. And `payment_budget` now reports `recordedSpend` beside the
  budget's own worst-case reservations, so the ceiling has an actual measurement to
  read: the budget holds the per-call maximum because it cannot see the price, while
  the ledger reports the price it did see.

- 2337629: The MCP server's spend cap is now cumulative, not just per call. `maxPrice`
  bounded a single payment, so an agent in a retry loop — or one told to "try each
  of these endpoints" — could pay that amount arbitrarily many times: every
  payment individually inside the limit, the sum unbounded. A per-call limit
  answers "how much can one mistake cost"; an operator's question is "how much can
  today cost".

  `SpendBudget` (`src/mcp/budget.ts`) adds a ceiling on the total paid by
  `paid_call` within one UTC day, configured with `MCP_DAILY_SPEND_CEILING`
  (default `$10.00`) alongside the per-call `MCP_MAX_PAYMENT_PRICE`. The day window
  was chosen over a sliding 24 hours because it answers the operator's question
  directly, needs one stored number rather than one entry per payment, and rolls
  over from the wall clock — so a restarted server resumes the same day's total and
  resets it after 00:00 UTC.

  Before a call is made the budget reserves its worst case, the per-call maximum,
  and refuses when that no longer fits what is left. It refuses with the new
  `ERR_BUDGET_EXCEEDED` code carrying the spent, ceiling, remaining and reset time
  in `details.budget`, so an agent can report being out of budget instead of
  looking broken; the refusal happens before the payment fetch, so no money moves.
  Both limits are in the `paid_call` description and the live totals are readable
  without spending, through the new `payment_budget` tool. The running total
  persists to `MCP_SPEND_STATE_FILE` (default `~/.lens-mcp/spend-state.json`) and is
  read back at startup, because a restart does not refund what the previous process
  already spent.

  Accounting is deliberately conservative: the wrapped x402 transport exposes only
  a plain `Response`, so a paid call that could have settled is booked at the
  per-call maximum and a rejection that proves nothing settled is not booked at all.
  Recorded spend is an upper bound, which means the ceiling is reached early rather
  than late — and an unreadable or unwritable state file is treated as fully spent,
  not as a clean slate.

  Also fixed while wiring this up: `MCP_MAX_PAYMENT_PRICE` was passed to
  `wrapFetchWithPaymentFromConfig` as `maxPrice`, which is not an option of the
  x402 client config and was silently ignored — every payment was capped by the
  library default of `$1` whatever the operator asked for. It is now passed as
  `spendControls.maxAmountPerPayment`, so the per-call limit the budget reserves
  against is the one actually enforced.

- 3c43cfe: Fix network-blind webhooks and price tracking across SDEX, Horizon AMM, Soroswap, and Aquarius ingesters:
  - Key module-level `lastPrice` maps by `(network, pairKey)` so price ticks on one chain do not supply the previous price for another chain.
  - Dispatch webhook price updates for the network the event originated from rather than falling back to the process active network.
  - Allow specifying network on webhook subscription (`POST /webhooks`) with validation.
- 9af1b08: Fix numeric price and volume precision across aggregations (#230).

  - Remove `::float` casts inside intermediate aggregate expressions in `/candles`, `/prices/history`, and GraphQL `getPriceHistory`.
  - Remove `::float` casts from `/price/:assetA/:assetB/history` and query raw numerics directly from `price_aggregates`.
  - Add explicit, documented edge serialization formatters in `src/pricing/precision.ts`: prices up to 18 decimal places matching `Decimal(36, 18)`, and volumes up to 7 decimal places matching Stellar stroops (`Decimal(36, 7)`).
  - Prevent multi-venue floating-point accumulation drift in `/volumes/:asset`.

- 2ea353b: Document the full public route surface in `openapi.yaml` (params, the shared
  `?network=` query, and response schemas) and add `tests/openapi.test.ts`, which
  boots the app, enumerates every registered route and fails when a non-internal
  route is missing from the spec. Operator-only and non-HTTP routes are excluded
  through an explicit, commented allow-list in `src/openapi/coverage.ts`. The
  generator is now importable and deterministic, and a test asserts the committed
  `openapi.json` matches it.
- 7ecd06d: `GET /pairs` and `GET /pools` no longer scan the whole history of every network
  on each request. Both now filter by network (`req.network`, default the active
  network) and read one index entry per pair / pool, so cost no longer grows with
  table size. Response shape is unchanged. A pair or pool that has gone quiet is
  still listed with its real last-update timestamp (it is never dropped).
- e3af84f: Make duplicate price points impossible to store (#237). `price_points` had no
  uniqueness on the trade identity, so an ingester retrying after a partial
  failure — or two instances briefly overlapping during a deploy — wrote the same
  trade again, inflating volume and skewing the volume-weighted VWAP.

  `PricePoint` now declares `@@unique([network, source, eventId])`
  (index `price_point_identity`), and `upsertPricePoints` writes as an idempotent
  insert (`skipDuplicates` → `ON CONFLICT DO NOTHING`), so a replayed batch is
  absorbed rather than stored twice.

  Postgres treats NULLs as distinct in a unique index, so a row stored without an
  event id could never be recognized as a duplicate. Writes therefore never store
  a null: venues with a natural id (SDEX/AMM trade TOIDs) pass it through,
  snapshot venues without one derive their key from pool STATE (AMM: pool id +
  `last_modified_ledger`; Soroswap: pool address + reserves) instead of the
  previous `Date.now()` ids, which minted a fresh identity per attempt. Sources
  that supply no id at all (Aquarius, future venues) get a SHA-256 synthesized
  deterministically from the row's content — never a clock, never random.

  `scripts/migrations/2026-10-17-price-point-identity.sql` removes rows already
  duplicated on this identity (keeping the earliest per group) before creating
  the index, for databases where `prisma db push` would otherwise fail. Rows
  predating the change with a NULL `event_id` are left untouched; from here on no
  new row can have one.

- 2c9d8a4: Snapshot retention now prunes `price_snapshots` for every network in
  `ENABLED_NETWORKS`, not just the active one, so the second network of a
  dual-network process no longer grows unbounded. The startup prune, the BullMQ
  worker and the in-process fallback timer all use the new `pruneAllNetworks()`,
  and the pruned row count is logged per network. `pruneOldSnapshots()` gains an
  optional `network` argument (defaulting to the active network).
- 0e1959b: `npm run openapi:gen` now also regenerates the README endpoint table from `openapi.yaml`, and CI runs `npm run readme:check`, which fails when the committed README differs from a fresh generation (#275).
- 9abd1f0: `/screener` no longer reports `market_cap`. It was a copy of `liquidity` under another name, so sorting or filtering by market cap silently sorted or filtered liquidity. Lens has no circulating-supply data to compute a real one, so the field is removed from the response and the sort allowlist, and `?market_cap=` and `?sortBy=market_cap` now return a 400 instead of being ignored. The three CTEs behind `/screener` are also now scoped to one network (`?network=` / `x-network`, defaulting to the active network) instead of pooling testnet and mainnet rows.
- d53ac14: Fix `slippagePct` on `/price/:a/:b/route`, which was always exactly 0 because
  the execution price was compared with itself. It is now the shortfall of the
  execution price against the AMM reserve-ratio spot price, so it grows with
  order size against a fixed pool. Route selection and `estimatedOutput` are
  unchanged. Slippage is only reported for an AMM route; SDEX and SPLIT routes
  (and pairs with no AMM pool) have no size-independent spot reference, so the
  value stays 0 rather than reporting a cross-venue spread as slippage.
- 61c1854: Fix `GET /status`: scope `indexer_state` to the requested network (`?network=`
  / `x-network`, defaulting to `STELLAR_NETWORK`) instead of returning whichever
  chain wrote most recently, and report the answering network and its watched
  pairs in the response.

  The SDEX and AMM ingesters now derive each trade's ledger from the TOID prefix
  of its Horizon id — Horizon sends no `ledger` field on a trade — so price points
  carry a real ledger again and `lastIndexedLedger` is no longer permanently null.
  A malformed id falls back to the last stored ledger, and the batch is deferred
  if no ledger can be established. A new `ingestLagSeconds` field surfaces a
  stalled ingester without Prometheus.

- 3cdb4bd: Route all logging through pino (`src/logger.ts`) instead of `console.*`. Every
  module now logs through a component-scoped child logger — `ingester:sdex`,
  `job:aggregate-refresh`, `ws:fanout`, `redis`, `config`, `webhook`,
  `route:price`, … — emitted as a structured `component` field rather than a
  message prefix, so operators can filter by component without regexing text.
  Fastify's request logger is built from the same options, so `req.log` carries
  the same redaction and formatting.

  The level is configurable via `LOG_LEVEL` (default `info`, documented in
  `.env.example`): logs are newline-delimited JSON when `NODE_ENV=production` and
  pretty-printed for humans otherwise. Values of secret-looking environment
  variables (`DATABASE_URL`, `DIRECT_DATABASE_URL`, `REDIS_URL`, and any name
  containing `KEY`/`SECRET`/`TOKEN`/`PASSWORD`) are scrubbed from every
  serialized line, including the password inside a connection string and driver
  error messages that echo it, while request auth headers are redacted via
  pino's `redact`. A test asserts no `console.*` survives in non-test source and
  that a connection string or API key value never reaches the output.

- 29e834a: Config now validates every Soroban contract id it hands out (Soroswap factory,
  Reflector oracle) with `StrKey.isValidContract`. A malformed id no longer boots
  the feature "enabled" and fails on every RPC call: it logs a warning naming the
  env var and disables that feature on that network. Two built-in defaults were
  55 characters and therefore invalid; the testnet Soroswap factory default is
  replaced with the address from Soroswap's published testnet deployment, and the
  mainnet Reflector default is removed, so the oracle stays off until
  `REFLECTOR_CONTRACT_ID_MAINNET` is set. `.env.example` and the deploy docs are
  updated.
- 789b054: `GET /volumes/:asset` now filters `price_points` by network instead of summing
  testnet and mainnet volume together. It accepts `?network=testnet|mainnet`
  (default: the active network), returns 400 for any other value, and echoes the
  resolved `network` in the response body.
- dca5ff3: Add `docs/x402-conformance.md`: a conformance baseline for the public `x402.org`
  facilitator on `stellar:testnet`, established by settling a real payment through
  it with an unmodified `@stellar/stellar-sdk` client and feeding it deliberately
  bad input. Records `/supported` verbatim, a settled transaction hash, a
  reason-per-rejection table, and five divergences between the reference
  implementation's advertised and actual behaviour. This is the baseline the Lens
  facilitator (#124, #125, #126) is measured against.
- 94bd8ea: Add an end-to-end test for the successful x402 402 payment loop (#423). Drives the real
  `@x402/fetch` transport against a stubbed resource + fake facilitator, signing a real Soroban
  `transfer` with `@stellar/stellar-sdk` using throwaway testnet keys. Asserts on what was signed —
  amount, destination and network passphrase (valid on testnet, invalid on mainnet) — not just the
  response body, and covers the failure branches: amount above maxPrice refused before submitting,
  a network the client is not registered for, and an expired signature that the facilitator rejects.

## 0.2.0

### Minor Changes

- bbe48e4: Add `/prices/history` endpoint backed by 1-minute price snapshots. A new `price_snapshots` table is appended to every minute by a snapshot ingester, queryable over a `[from, to]` window with optional `5m`/`1h` aggregation. A retention job prunes snapshots older than 30 days.

### Patch Changes

- 5a68745: Adopt changesets for versioning and release notes. Adds `@changesets/cli`, a release GitHub Actions workflow that opens a "Version Packages" PR for pending changesets and tags releases on merge, and contributor docs for the workflow.

All notable changes to Lens are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- CI pipeline (`.github/workflows/ci.yml`) running Prisma generate, typecheck, and build on every PR
- Contributor documentation, issue templates, PR template
- This changelog

## [0.1.0] — 2025 initial deployment

### Added

- Fastify REST API with `GET /price/:assetA/:assetB`, `GET /status`, `GET /pools`
- GraphQL endpoint via Mercurius
- SDEX trade ingestion with checkpoint tracking
- AMM pool snapshot ingestion
- Best-route price calculation across SDEX and AMM
- x402 micropayment gating via `@x402/stellar`
- Prisma schema for price points, pools, and checkpoints
- BullMQ aggregate refresh worker (optional, requires Redis)
- Supabase Postgres support with scoped SSL handling
- Deployed on Render at https://lens-ldtu.onrender.com

### Fixed

- `bestRoute.ts` AMM lookup — was using broken `code:code` join format; now queries via `pool_id`
- Prisma binary target on Render (`debian-openssl-3.0.x`)
- Supabase SSL cert error (scoped to supabase.com hosts)
- BullMQ blocking startup — wrapped in try/catch, ingesters auto-restart

[Unreleased]: https://github.com/Miracle656/Lens/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Miracle656/Lens/releases/tag/v0.1.0
