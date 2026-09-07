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

## License

Apache-2.0. See [LICENSE](./LICENSE).
