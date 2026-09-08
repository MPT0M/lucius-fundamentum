# Lucius Fundamentum

> Document grounding and citation attribution that never loses a character.

**Under construction.** The text foundation is in place and tested; search and
attribution land in later releases. Nothing is published to npm yet.

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

## Where this is going

**Search.** Hybrid retrieval — lexical and dense — over your documents, with no
LLM in the loop. Works with any embedding provider and runs where you run.

**Attribution.** Given a text and the retrieved passages, says which stretch of
the text is supported by which passage, with positions you can trust.

**Measurement.** `bench/` holds the ruler these two will be measured with: a
public-domain corpus with its own provenance record, and a harness that scores
citation positions against labeled spans.

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
purpose, the book not supporting them; each is a judgement, and the labels are
published so it can be contested.

Rounds against other providers are planned. A ruler that has only ever been
held against one product has measured that product and not much else.

## License

Apache-2.0. See [LICENSE](./LICENSE).
