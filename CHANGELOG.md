# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). While the version is
`0.x`, a breaking change bumps the minor and is written up with its migration.

## [Unreleased]

### Changed

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

- A dense arm. `createDenseIndex(documents, provider, options)` builds an index that
  carries a vector per chunk, and `search` on it ranks by cosine instead of
  refusing. It is `async` and separate from `createIndex` rather than a flag on
  it: this is the call that costs money and leaves the machine, and the
  signature says so. The lexical index stays synchronous and free, and
  `searchLexical` is unchanged.
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
- Vector magnitude is deliberately outside the provider contract: an adapter
  may return unit-length vectors or not, and these do differ. Nothing in the
  library depends on it, because indexing and querying both normalize and
  normalizing twice changes nothing — but a caller using a provider directly
  and comparing two vectors by dot product should normalize first, or the
  number is a cosine only by luck.
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
  prose. It adds no runtime dependency: `lib.webworker.d.ts` declares no
  `document`, `window` or storage API.
