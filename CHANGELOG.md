# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). While the version is
`0.x`, a breaking change bumps the minor and is written up with its migration.

## [Unreleased]

### Changed

- **`search` is now the hybrid search, not the dense one.** It runs both arms,
  ranks each to `FUSION_DEPTH`, and fuses them by reciprocal rank: a chunk both
  arms found outranks a chunk one arm placed first, which is the whole claim of
  hybrid retrieval. `searchLexical` is untouched and still answers from the
  lexical arm alone; there is no longer a way to query the dense arm by itself,
  which is deliberate — the two lots were kept apart precisely so that the
  history has a point where each arm can be measured alone, and after the
  fusion separating the contributions is inference rather than measurement.
- **`SearchResult.score` from `search` changed meaning, and callers must not
  threshold on it.** It was the cosine, between 0 and 1. It is now the
  reciprocal-rank sum, between 0.00625 and 0.033 at the defaults — the floor is
  not near zero and depends on `FUSION_DEPTH` as much as on `FUSION_K`, because
  a chunk that reaches the fused list at all was ranked within the depth by at
  least one arm, and the worst such rank is the depth itself. It is not a
  similarity and not a probability: 0.03 does not mean "3% relevant", and it
  carries no absolute meaning by construction, because the fusion reads
  positions precisely so it never has to trust the scales underneath. Order by
  it; never compare it to a constant. `searchLexical` still returns the BM25
  score, which was never comparable across corpora either.
- The page cap is applied once, to the fused list, and never inside an arm.
  Capping per arm would remove a chunk from one list for a reason that is not
  its relevance, and the fusion would read that absence as the arm having
  ranked it low — a chunk penalised for a cap it never met.
- **Known limit, declared rather than fixed: `search` draws from a pool of at
  most `2 * FUSION_DEPTH` chunks — 200 at the defaults.** Each arm ranks that
  deep and no deeper, so `topK` above 200 returns 200 with no error, and a
  `maxChunksPerPage` whose 200 candidates happen to cluster on a few pages
  returns fewer results than an uncapped corpus would have offered. That second
  case is the page cap shortening a list for a reason that is not relevance —
  the same failure its placement was chosen to avoid, reappearing one level up.
  Raising the depth trades it for cost on every query, and neither side has
  been measured, so the number stays and the limit is written down.
  `searchLexical` has no such pool and honours any `topK`.
- A URL region now stops at `$`, at a backtick and at an already masked code
  region. Before, `https://x.y$a$` was one `url` region that swallowed the
  formula, and a URL glued to inline code was dropped whole for overlapping
  it. The price: a `$` anywhere in a URL ends the URL there. Text in which
  no `$` or backtick occurs inside a URL masks exactly as before. The formula
  pass now drops a match that overlaps an earlier region, like the code and
  URL passes always did, so the spans stay disjoint when a `$` before a URL
  meets the `$` the URL released.
- `maskProtectedRegions` now returns a `ClassifiedMaskResult`: every span
  carries `kind` (`'code' | 'url' | 'formula' | 'abbreviation'`), the pass that
  painted it. `ClassifiedMaskResult` is a subtype of `MaskResult` — nothing was
  removed and no position changed — so code that reads `start`/`end`, or
  assigns the result to a `MaskResult`, keeps compiling and behaving the same.
  Only an assertion that fixes the exact set of keys on a span (a deep-equality
  check against `{ start, end }`) needs to add `kind`. `maskFormulas` and
  `maskAbbreviationPeriods` are unchanged.

### Added

- A dense arm. `createDenseIndex(documents, provider, options)` builds an index
  that carries a vector per chunk, which is what lets `search` answer at all —
  see above for what it does with them. It is `async` and separate from
  `createIndex` rather than a flag on it: this is the call that costs money and
  leaves the machine, and the signature says so. The lexical index stays
  synchronous and free, and `searchLexical` is unchanged.
- `EmbeddingProvider`, the contract an adapter fits: `embedDocuments` and
  `embedQuery` as two methods, not one with a flag. A question and a passage
  are different kinds of text, providers offer different ways to say which is
  which, and a flag an adapter ignored would compile, return vectors, rank
  results and retrieve worse than it should with no symptom.
  `deterministicProvider` implements both identically — a hash has no notion of
  question or passage — which is what lets the suite prove the mechanics with
  no network and no key. A third member, `countTokens`, is optional and no
  adapter implements it yet; the window guards convert code points to tokens at
  a fixed ratio until one does.
- Vector magnitude is deliberately outside the provider contract, even though
  every implementation currently satisfies the stronger promise: measured on
  2026-09-13, `gemini-embedding-2` at 1536 dimensions and
  `qwen3.7-text-embedding` at 1024 both return vectors of norm 1.0000, and the
  deterministic provider normalizes by construction. The contract stays silent
  because a promise resting on a vendor's current behaviour is not one this
  library can keep, and an adapter written by someone else has no reason to
  inherit it. Nothing here depends on the difference — indexing and querying
  both normalize, and normalizing twice changes nothing — but a caller using a
  provider directly and comparing two vectors by dot product should normalize
  first, or the number is a cosine only by the vendor's good manners.
- Adapters for three services: `openAiProvider`, `geminiProvider` and
  `qwenProvider`, plus `EmbeddingProviderError` so a caller can tell a provider
  failure from a bug in this library. They differ in ways worth knowing before
  choosing one:
  - OpenAI takes an array and returns one vector per element, so a corpus is
    one call. It has no query/passage distinction to honour, having absorbed it
    during training.
  - Qwen takes an array with a documented ceiling per call, so a corpus is
    split into runs of twenty, and it is the only one of the three with a
    first-class parameter for the asymmetry (`text_type`). **A DashScope key
    works only against its own region's host**, and the default here is the
    mainland one — a key from any other region is rejected as
    `401 InvalidApiKey`, which accuses the key when the key is fine. Pass
    `baseUrl` for the region the key was created in; the error raised against
    the default now carries the rule and the hosts. The adapter also refuses to
    guess the batch ceiling of a model it has not seen, since the ceiling is
    per model (`text-embedding-v4` documents ten against this default's
    twenty).
  - **Gemini fuses several `parts` into one aggregated vector**, which is the
    right behaviour for pairing text with an image and the wrong one for
    indexing a corpus. Each input therefore gets its own request, run with a
    ceiling on how many are in flight (`concurrency`, default 8, sized against
    the published paid-tier ceilings). Note that the free tier does not serve
    embeddings over the API at all; a key that works for chat fails here, with
    an HTTP error that does not mention the tier.
- Vector arithmetic and a wire format: `normalize`, `dot`, `norm`,
  `packVectors`, `unpackVectors`. Byte order is pinned little-endian through a
  `DataView`, because `Float32Array` uses the platform's — an artifact packed
  on one machine and read on another of opposite endianness would decode to
  noise with no error and no symptom. `normalize` throws on a vector with no
  direction rather than returning zeros, which would score zero against
  everything and read as "no match" instead of "the provider returned something
  unusable".
- Two guards against a chunk that does not fit the provider's window,
  `assertChunkCeilingFits` and `assertChunksFit`. Two layers because the chunk
  ceiling is a budget and not a bound: a sentence longer than
  `maxChunkCodePoints` is emitted whole rather than cut in half, so a
  configuration whose parameter fits the window can still produce a chunk that
  does not. Measured on this repository's own corpus: 2 of 636 chunks exceed
  the ceiling.
- Types `ProtectedSpan` and `ClassifiedMaskResult` are exported.
- The tests are now type-checked (`tsconfig.typecheck.json`, run by
  `npm run typecheck`), so a read whose only check is the declared type — such
  as `kind` on a span — fails to compile if the type stops promising it, even
  while the runtime value is still there.
- The compiler is told the package targets a Worker as well as ES2022
  (`"lib": ["ES2022", "WebWorker"]`). The adapters need `fetch`, `Response` and
  `AbortSignal`, and this is what makes the file header's claim that the
  library has to run in a Worker true of the build rather than only of the
  prose. It adds no runtime dependency. It does widen what compiles: the
  WebWorker lib declares no `document` and no `window`, but it does declare
  `caches` and `indexedDB`, which exist in a Worker and not in Node. Nothing in
  `src/` uses them, and a contribution that did would type-check here and throw
  `ReferenceError` under the runtime this package declares.
