# Lucius Fundamentum

> Document grounding and citation attribution that never loses a character.

**Status: under construction.** The foundation is being laid commit by commit;
nothing here is published to npm yet. Follow the commit history — it is written
to be read.

## What this is

A library for building document search with **span-level citations** — the kind
of grounding you get from a hosted file-search API, except that it runs where you
run, works with any embedding provider, and reports positions in **Unicode code
points**, never bytes. Portuguese is the first-class test case: if accented text
comes back with the citation in the right place, so does everything else.

Two layers, both usable on their own:

1. **Retrieval** — hybrid lexical + dense search over your documents, with no
   LLM in the loop.
2. **Attribution** — given a text and the retrieved passages, says which stretch
   of the text is supported by which passage, with positions you can trust.

## What this is not

It does not generate text, and it is not a chat. It does not promise to be more
*accurate* than the hosted alternatives — it promises to be **inspectable**:
every decision it makes can be read, measured and disputed.

## The benchmark: what it is, and what it is not

Under `bench/` lives a ruler, not a claim. It measures whether each citation a
hosted file-search API returns points at the right stretch of a document **we**
uploaded, along three axes that only mean something together:

- **Precision** — of the citations the model placed, how many land on the
  passage that actually supports the sentence they mark.
- **Coverage** — of the sentences a human judged to be supported by the
  documents, how many received a correct citation.
- **Activation** — whether the search ran at all, or the model answered from
  memory.

What it is not: it copies no proprietary content, trains nothing on the
answers, and reverse-engineers nothing. The documents are public domain and
uploaded by us — see `bench/corpus/public/`, which carries its own LICENSE and
NOTICE, and `bench/corpus/manifest.json`, the one record of where each file
came from. The test suite refuses a file the manifest does not know.

The raw API answers are not in this repository, by the owner's decision. The
price is stated openly: a published report cannot be recomputed by a third
party from this repository alone; the recorded answers are available on
request.

The numbers are born from labels written by hand over recorded answers, signed
by a handle on the allowlist, and aggregated into one report per variant —
each question is asked once plainly and once with an instruction to search —
under `bench/reports/`, each report carrying the model, the recording date and
the store configuration. Two exclusions are declared rather than compensated:
a cited snippet whose whitespace the API altered counts as not located, and
the abbreviations of nineteenth-century Portuguese spelling are outside the
package's list.

Measured so far, on the first twenty recorded answers (commit `cbcd9f3`): the
search ran in all twenty; 161 citations, none with a wrong byte length or
position; of 205 cited chunk references, 170 located verbatim in the source,
35 not located — every one of them a whitespace difference — and none
ambiguous. Precision and coverage await the labels.

## License

Apache-2.0. See [LICENSE](./LICENSE).
