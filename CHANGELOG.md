# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). While the version is
`0.x`, a breaking change bumps the minor and is written up with its migration.

## [Unreleased]

### Added

- **Attribution.** `attribute` and `attributeLexical` take a text a model
  already wrote plus the passages a search already returned, and say which
  stretch of the text each passage supports. The answer is attributed ONCE,
  after the model has finished writing it. Nothing rewrites the
  answer: the engine returns structure, and `formatAttribution` writes the
  markers separately and hands the spans back REINDEXED, because inserting a
  marker moves every later offset and a caller using the original spans would
  get drift.
- **What it checks, and what it does not.** It verifies SUPPORT — the clause
  says something the passage contains — and not RELEVANCE. A passage can
  support a sentence perfectly and still be the wrong passage to have cited,
  and nothing here notices. The promise is auditability, not accuracy.
- **Three rungs, because the last one costs money.** A lexical pass, then a
  hard veto on figures, dates and negation that only ever REJECTS, then the
  vectors for what the words could not separate. The dense rung costs TWO
  network calls per call to `attribute`, however many clauses are ambiguous —
  one for the candidate passages, one for every unresolved clause together.
  Without `opts.provider` it does not run, `attribute` answers exactly what
  `attributeLexical` answers, and nothing is paid.
- **`rungs`, the instrument.** `Attribution.rungs` counts clauses per rung so
  the harness can publish the fraction each one resolved without an instrument
  of its own. **`dense` is always zero from `attributeLexical`**, because that
  door does not run the rung and the clauses it would have decided land in
  `unattributed`. The two doors are two instruments: a counter from one
  compared against the other compares different measurements of different
  work.
- **Progress, for a caller who asks.** `opts.onState` receives four events:
  `local-done` with a preview, `provider-wait`, and `provider-done` or
  `provider-failed`. Leaving it out produces nothing — the preview is built
  inside the branch that emits it, so nothing is paid. **What is emitted is
  an identifier, never a sentence:** which words a reader sees belongs to
  whoever writes the interface. There is no percentage, because how many
  clauses remain is unknowable until the text ends.
- **`provider-wait` exists only when there will be a wait.** Not without a
  provider, and not when every clause resolved on the words and the network
  is never called. Measured by `bench/src/attribution-cost.ts` — a document of
  32,520 code points, an answer of 1,608, ten candidates — the LEXICAL door
  takes **milliseconds**, median of twenty runs, against a network call in the
  hundreds of them; the dense door adds the preview, the cosine loop and a
  second density pass on top of that, all of the same order. The figure moves
  with what else the machine is doing — the same code on the same machine
  gave 3.1 ms alone and 8.3 ms with the test suite loading it from a second
  shell — which
  is why the ORDER is published and not a decimal, and why the test pins a
  collapse ceiling rather than a value; run `npm run bench:cost` and disagree
  with it. An indicator hung on the
  start of the work would flash and vanish; hung on this event it cannot,
  because the event does not exist.
- **THE PREVIEW REPLACES, IT DOES NOT AMEND.** Between `local-done` and the
  returned result a marker can move, change number and be fused away. Swap
  the block; patching marker by marker drifts. The numbers are under "the floor
  is not invariant between two attributions" below.
- **A remote failure no longer destroys local work.** The dense rung is
  guarded, the result comes back with what the local rungs found, and
  `Attribution.providerFailure` says the rung was TRIED and failed — which
  is what tells it apart from no provider at all, for a caller who asked
  for no events. `retryable` reads an HTTP status, a standardised number,
  and never the provider's prose.
- **Five thresholds, all arbitrary until measured** and all exported to be
  read: `MIN_LEXICAL_SUPPORT`, `LEXICAL_MARGIN`,
  `DEFAULT_COALESCE_MAX_CODE_POINTS`, `DEFAULT_MIN_CLUSTER_CODE_POINTS` and
  `DEFAULT_ATTRIBUTE_OPTIONS`. The first two ARE the coverage-versus-noise
  trade in disguise; the harness of lot 2 is what will calibrate them.

### Known limits of the attribution, stated rather than discovered

- **Without a key the coverage is structurally lower.** In a browser with no
  provider only the two local rungs run, so a clause the words cannot separate
  comes back with no marker. A figure measured with a provider does not hold
  for that mode.
- **`confidence` is local to the candidates it was computed over.** The weights
  come from their frequencies, so the same clause and passage score differently
  under a different `topK`. Order by it, never threshold across calls. Spans
  resolved by the dense rung score systematically lower, because low lexical
  coverage is exactly what sent them there — split by `resolvedBy` before
  comparing, and treat `'mixed'` as a THIRD group rather than folding it into
  either. A fused span's number is recomputed over the union by a lexical
  measure, so it belongs to neither of the two the sentence above compares.
- **Negation without a lexical marker does not fire the veto** (`deixou de`,
  `está longe de`). It errs by letting through, never by dropping a correct
  citation.
- **Segmenting a passage in isolation can bound a sentence differently** from
  segmenting the whole document, when a protected region crosses the chunk
  edge: half of a fenced block has no fence. The popover can open on a passage
  cut inside a URL or a formula.
- **The floor is not invariant between two attributions of the same text with
  different rungs available, so a marker can MOVE.** It does not depend on
  `onState`: it depends on there being two calls. The floor walks the spans in
  order and defers any anchor closer than `minClusterCodePoints` to the
  previous one, reading neither the rung nor the chunk — so a dense span
  landing between two lexical ones becomes the
  previous anchor of the later one and can push it to the next clause.
  Reproduced: same document, same candidates, an answer whose second clause
  only the vectors resolve —

      attributeLexical      lei#0@43  lei#3@119  lei#4@237
      attribute + provider  lei#0@43  lei#2@119  lei#3@179  lei#4@237

  **THREE PATHS REACH TWO CALLS, and none of them is exotic.** The two lines
  above are the two public doors. A caller can paint for free with
  `attributeLexical` and improve with `attribute` later. And a failed provider
  now returns `retryable: true`, which
  invites a retry, and a retry that succeeds is the second call.

  The FIRST coalescence pass is invariant by construction — it fuses over
  clause adjacency, and the clause sequence is identical for both doors.
  Neither the floor nor the second pass was given the same treatment.
- **And the third density pass AMPLIFIES that divergence, so a marker can also
  disappear rather than only move.** The pass fuses pairs the floor moved
  (`a.moved && b.moved`), and `moved` is the floor's verdict, so a pair the
  floor pushed together in one call and left apart in the other fuses in one
  of them only: two markers where the other shows one. MEASURED AT THE
  `applyDensity` LEVEL, not through the public API — 198 of 216 arrangements of
  two same-passage clauses with a dense span in front of them, with the
  defaults:

      lexical only          x@10[0-10]  y@100[88-100]  y@200[188-200]
      attribute + provider  x@10[0-10]  z@130[28-40]   y@330[88-200]

  Through the public API only the MOVE is reproduced; every arrangement tried
  there had the pair already fused by the first pass, where both doors agree. The
  effect is stated at the level it was measured, and a reader wanting it
  end-to-end will have to build the case.
- **Paraphrase groups now, and only the mixed pair still costs a marker.**
  Coalescence used to run over the `'lexical'` subset alone, because that was
  the one set both doors produced identically. The constraint fell on exactly
  the population that most needed the merge — text that paraphrases its source
  is what reaches the vectors at all, so the better a model wrote, the more
  markers it collected.
  Measured, four consecutive clauses of one passage, anchors twenty code points
  apart: the vector row read four markers where the word row read two, at every
  floor setting. It now reads two.

  **What still costs a marker** is a pair where one side matched a sentence in
  its chunk and the other did not. Those do not fuse, because the `sourceSpan`
  of the second is the whole chunk and merging would widen the first one's
  claim from a sentence to a block. Two spans that BOTH lack a matched sentence
  do fuse: they carry the same `sourceSpan` by construction, so nothing widens.

- **`resolvedBy` gains `'mixed'`.** A span fused from one lexical and one dense
  side carries a literal citation and a paraphrase at once; calling it
  `'dense'` would lie about the first and `'lexical'` about the second. It also
  earns its own population for `confidence`: the fused number is recomputed
  over the UNION by a LEXICAL measure, so filing it under `'dense'` would put
  it in the group these notes declare scores systematically lower, and
  comparing the two groups would then compare instruments. **Split by
  `resolvedBy` before comparing, and treat `'mixed'` as a third group rather
  than folding it into either.**
- **Without an HTTP status, a refused connection and an unknown host are the
  same `network`.** A provider failure classifies by status, which is a
  standardised number: `401`/`403` give `auth`, `429` `quota`, `408`/`504`
  `timeout`, the rest `network`. Without a status only the timeout separates,
  by `name === 'TimeoutError'`. **The discriminator for the other two exists
  and is runtime-dependent** — a `fetch` failure in Node carries a code at
  `cause.cause.code` — and this package declares Node, `workerd`, Bun and the
  browser, so reading it would hold on one runtime and not the others. That is
  the limit, and it is smaller than the missing contract an earlier draft
  claimed.
- **The dense rung re-embeds the candidate passages** rather than reading the
  vectors the index already holds. It pays twice, and in exchange both sides of
  every comparison are born in the same call, through the same door.

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
