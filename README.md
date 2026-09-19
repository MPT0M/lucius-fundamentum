# Lucius Fundamentum

> Document grounding and citation attribution that never loses a character.

**Under construction.** The text foundation, search and attribution are in place
and tested. Nothing is published to npm yet.

## The rule

Every position in this library is an offset in **Unicode code points** into the
**raw** text, 0-based, end-exclusive.

Never bytes: every accented character shifts the citation by one. Never UTF-16
units: an emoji is two of those and one character. And never into normalized
text — normalization changes length, so a position measured against it would
need a translation table back to the source, which is the whole class of defect
this library exists to remove.

Portuguese is the first-class test case: if accented text comes back with the
citation in the right place, so does everything else.

## What exists today

**Positions and slicing.** `countCodePoints`, `sliceByCodePoints`,
`normalizeUnicode` — count, cut and normalize without letting a position slip.

**Length-preserving masking.** LaTeX formulas, code spans, URLs and abbreviation
periods are masked before the segmenter sees the text. Because the mask is the
same length as what it covers, every position the segmenter reports on the
masked text is a valid position on the original. This is the core idea of the
package.

**Portuguese abbreviations.** `PT_BR_ABBREVIATIONS` and
`maskAbbreviationPeriods`, so that "Dr." and "art." do not become sentence ends.

**Search.** `createIndex` builds a lexical index and `createDenseIndex` adds
vectors; the two are fused by reciprocal rank. No LLM in the loop, any
embedding provider, and it runs where you run. `FUSION_K` and `FUSION_DEPTH`
are exported to be read, not tuned: a recall figure published without them
cannot be compared with another one.

**Chunking.** `chunk()` cuts a document into pieces that know exactly where they
came from. Boundaries always fall on sentence ends — never inside a formula, a
code span, a URL, or right after an abbreviation. Each chunk carries its `span`
in the source text, and the chunk's text is cut from the original, never from
the masked version. Overlap is configurable in whole sentences, so a fact
straddling a boundary stays findable from both sides.

`Span` has `start` and `end` always present, with no optional and no default: a
citation opening at offset zero is the most common one there is, and a format
that treats zero as absent sends it to the wrong place in silence.

## Example

```ts
import { chunk, DEFAULT_CHUNK_OPTIONS } from '@nihilo-dev/fundamentum';

const chunks = chunk(
  { id: 'lei-8078', title: 'CDC', text: source },
  DEFAULT_CHUNK_OPTIONS
);

// each chunk: { id, documentId, text, span: { start, end } }
```

## Attribution

Given a text a model already wrote and the passages a search returned, the
attributor says which stretch of the text each passage supports.

```ts
// One tokenizer, passed to both. `createIndex` defaults it when none is given
// and does not hand back what it built, so the short path leaves no handle to
// attribute with — and attributing with a different tokenizer than the one
// that indexed is not detectable from inside.
const tokenizer = createTokenizer();
const index = createIndex(docs, { tokenizer });
const results = index.searchLexical(question, { topK: 10 });

const attribution = attributeLexical(answer, results, { tokenizer });
const formatted = formatAttribution(attribution, { markerStyle: 'bracket' });
const { text, spans } = formatted;
```

**It checks support, not relevance.** The clause says something the passage
contains — that is what is verified. Whether that passage answers the question
that was asked is a different instrument, and this one does not have it. A
citation can be perfectly faithful and point at the wrong passage, and nothing
here would notice. The promise is auditability, not accuracy.

**`MIN_LEXICAL_SUPPORT` is a ratio, not a similarity threshold.** With weights
close to each other, the default of `0.25` means at most three of a clause's
terms may be absent from the passage for every one that is present. It and
`LEXICAL_MARGIN` are the coverage-versus-noise trade in disguise: raise them
and the library cites less and is wrong less often.

**The answer is attributed once, after the model finishes writing it.** There
is no mode that marks text while it is being produced; `opts.onState` reports
progress for a caller who wants to show something during the wait, and emits
an identifier rather than a sentence, because the words belong to whoever
writes the interface.

**Reporting is opt-in twice over**, and the second one is easy to miss. Pass no
`onState` and nothing is produced: no event, and the preview is never even
built. Pass one and use only the event kinds, and you have a loading state that
appears only when there is a wait — `provider-wait` is not emitted without a
provider, nor when the words resolved every clause. Pass one and also paint the
`local-done` preview, and you have taken on the third posture: the final result
replaces that preview rather than extending it, because a span the vectors add
changes which markers are neighbours, and neighbours decide what fuses and what
gets nudged. Swap the block; patching marker by marker drifts. An interface
that only wants a spinner should ignore the preview and never meet this.

**`index.denseArm` says whether hybrid search can run before you call it.**
`ready`, or one of two refusals that cost different things: `needs-provider`
means the vectors are in the artifact and a provider was not supplied to
`loadIndex`, so the repair is one argument; `absent` means the corpus was never
embedded, so the repair is embedding all of it. Collapsing them into a boolean
offers a re-index to someone who only had to pass a key.

**A provider failure does not throw — it degrades.** `attribute` catches it,
answers with what the local rungs found, and describes the failure on
`Attribution.providerFailure`, whose `retryable` says whether repeating is
worth offering. A `try/catch` around the call will not fire; inspect the
field. What does throw is a configuration error checked before the network
— a chunk wider than the provider's window, say.

`CHANGELOG.md` carries the known limits — what the veto cannot see, why
`confidence` is local to one call, and why two attributions of the same text
can place a marker differently.

## Where this is going

**Measurement.** `bench/` holds the ruler search and attribution will be
measured with: a public-domain corpus with its own provenance record, and a
harness that scores citation positions against labeled spans. It is what will
calibrate the thresholds this package exports rather than tunes.

## The measured round

`bench/reports/` carries the scores. `bench/fixtures/` carries what they were
computed from, so that anyone can compute them again and disagree.

- `fixtures/google/` — 48 answers, 24 questions in two variants, recorded on
  2026-09-08 against `gemini-3.5-flash-lite` with Google's File Search over one
  document. Each file keeps the grounding metadata as the API returned it, and
  the round's own parameters, so a number is never readable apart from the
  conditions that made it.
- `fixtures/labeled/` — the gold: for each verifiable claim, the passage of the
  book that supports it, as code-point spans. The gold is read off the book and
  never derived from what the emitter cited, which is what lets a citation be
  scored against where the claim is rather than where the emitter said it was.

### What this round does not cover

One book, one language, one day, one model. The ruler recognises four kinds of
protected region — code, URLs, formulas, abbreviations — and this corpus
exercises one: 99.9% of the gold is ordinary prose, because Machado de Assis
wrote no source listings and no equations. Twelve claims carry no gold on
purpose, because the book does not support them. Each of those is a judgement,
and the labels are published so that it can be contested.

Rounds against other providers are planned. A ruler that has only ever been
held against one product has measured that product and not much else.

## License

Apache-2.0. See [LICENSE](./LICENSE).
