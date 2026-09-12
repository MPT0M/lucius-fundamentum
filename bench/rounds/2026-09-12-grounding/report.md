# Instruction, not model: what produces invented citations in document grounding

Round of 2026-09-12 — legal corpus, 60 questions, four runs.

## The question

When a model with document search asserts something the source does not say,
is the cause the search, the instruction, or the model? The question is usually
answered by opinion. This round tries to answer it by subtraction: it fixes the
search and the corpus, varies the instruction, and repeats the whole design on
two models.

The two models are not the object of measurement. Sixty questions support no
claim about either one. They are here as **replication**: if the effect of the
instruction appears in the same direction in two independent systems, the
effect belongs to the instruction.

## The design

Six roles, run in isolation. None saw another's output.

| role     | receives                         | produces                            |
|----------|----------------------------------|-------------------------------------|
| writer 1 | the 7 corpus files               | 30 questions                        |
| writer 2 | only a description of the domain | 30 questions                        |
| curator  | the 60, shuffled                 | removes duplicates, hides origin    |
| subject  | question + 10 retrieved passages | answer + citation                   |
| judge    | question + the whole corpus      | where the answer lives, or absence  |
| hunter   | question + the whole corpus      | proof it exists, or what was tried  |

None of the six prompts mentions a test, a measurement, a gold standard, or
the existence of another role. The output filenames, however, were part of the
mechanics each agent received, and for four roles they carry the model name and
the version letter — `claude-A.md`, `gemini-juiz.md`. An agent writing to
`claude-A.md` can infer that a `claude-B.md` exists and that something is being
compared. What the letter does not reveal is what differs between A and B, or
in which direction. The blinding was therefore partial for the four measured
roles, and this was found by rereading the prompts before publication, not by
design.

Writer 2 never saw the documents: it wrote what a person asks about the domain,
without knowing what the corpus held. Twenty-one of the sixty questions had no
answer in the corpus, and none of them was planted.

The two instructions under test differ by one paragraph. Under **version A** the
model may declare that the answer is not in the passages. Under **version B** it
must always answer. Everything else is identical, word for word.

Judges and hunters each ran twice, on different models, with identical prompts.
The final count is mechanical: the judge quotes literal text, a script locates
which chunk that text lives in, and compares it against the chunk the subject
cited.

## Corrections made after seeing the data

This comes before the results because it changes how to read them. Three
corrections were made, all after the data was in hand.

**#21 — "Can a school install a signal jammer?"** One judge said absent; the
other quoted art. 14 of Resolution CNE/CEB 2, which states that signal-blocking
solutions are not recommended and must not be used. The text exists and the
search had retrieved it. The question says "jammer", the norm says "signal
blocking".

**#44 — "Is the school required to provide meals even for students who are not
low-income?"** Both judges said absent. Both hunters found the same provision
of the LDB, requiring student support at every stage of basic education through
supplementary food programmes. The human gold standard classified it as a
neighbouring answer, and was wrong: where a duty is universal, the absence of a
restriction is the answer, not a gap.

**The counter required exact contiguity.** In three questions the judge's
quotation could not be located in the corpus, which emptied the set of correct
chunks and made any answer count as neighbouring. Two causes, both measured: in
#8 and #53 the judge stitched non-adjacent items of a numbered list into a
single quotation, sometimes marking the elision and sometimes not; in #32 the
quotation crosses a chunk boundary. This is the same family as the `notLocated`
category in the ruler itself — exact substring matching against text the citing
party altered. The matcher now consumes a quotation in maximal fragments
instead of requiring contiguity, which covers marked elision, unmarked elision
and boundary crossing with one mechanism. All 52 quotations now locate; 49 did
before.

The correction returned eight correct answers, two per run. Neighbouring
answers fell by the same amount. Misses and confabulations are unchanged,
because the defect only reached questions where the judge had pointed at
something.

| | before | after |
|---|---|---|
| correct (across four runs) | 24 / 24 / 22 / 24 | 26 / 26 / 24 / 26 |
| neighbouring | 8 / 10 / 6 / 8 | 6 / 8 / 4 / 6 |

The first two corrections were found only because a second evaluator disagreed.
Where the evaluators agreed, nobody looked — and that was exactly the class of
the error.

## Every number here is a floor

The corrections were found independently, and all of them fail in the same
direction: each one penalised an answer that was right.

| layer | incident | direction |
|---|---|---|
| judge | #21 — did not find text that existed | penalised a correct answer |
| counter | #8, #32, #53 — required contiguity | penalised a correct answer |
| human | #44 — read as neighbouring what did answer | penalised a correct answer |
| human | #24 — read the head of a chunk as if it were the quotation | penalised a correct answer |

This is not a run of unlucky bugs. Each layer of the evaluator can only err in
one direction. The judge errs by not finding, never by inventing a passage. The
counter errs by not matching, never by matching spuriously. The human erred by
being severe.

The fourth incident deserves its own note, because of how it was found. While
auditing the other direction, the human flagged #24 as a suspected gold-standard
error — the question concerns full-time schooling, and the judge appeared to
have cited a passage about rural literacy. He had read the first 180 characters
of the chunk instead of the quotation. The chunk opens with one strategy and
contains the cited target further down. The suspicion was written into an
earlier draft of this report, in the Limits section, by name, and was retracted
before publication when both auditors marked the question as partially covered
rather than wrong.

Two of the four incidents are human, and they differ from the other two in kind:
the automated layers fail by not finding, the human failed by judging without
opening the text. That is the same failure the report names elsewhere — treating
a label as if it were the content.

The consequence has to be stated plainly: **every number in this report is a
floor, not an estimate.** The correct answers may be higher. The confabulations
may not. The bias has a known direction, which is better than an unknown one,
but it is bias.

This finding does not depend on the sample size.

## Results

Thirty-seven questions with an answer in the corpus, twenty-one without, two
partial and excluded from the count.

**Of the 37 that have an answer:**

|                        | version A (may refuse) | version B (must answer) |
|------------------------|------------------------|-------------------------|
| correct — model 1      | 26                     | 26                      |
| correct — model 2      | 24                     | 26                      |
| neighbouring — model 1 | 6                      | 8                       |
| neighbouring — model 2 | 4                      | 6                       |
| missed — model 1       | 5                      | 3                       |
| missed — model 2       | 9                      | 5                       |

**Of the 21 that have no answer:**

|                             | version A | version B |
|-----------------------------|-----------|-----------|
| refused — model 1           | 20        | 0         |
| refused — model 2           | 21        | 0         |
| warned, no source — model 1 | 0         | 16        |
| warned, no source — model 2 | 0         | 18        |
| confabulated — model 1      | 1         | 5         |
| confabulated — model 2      | 0         | 3         |

Invented chunk identifiers: zero across all four runs.

## What the numbers say

**The instruction moves confabulation, and moves it in the same direction in
both systems.** With permission to refuse, one case and zero cases out of
twenty-one. Under the obligation to answer, five and three. The effect
replicates; the magnitude, at this denominator, does not hold. Given the
asymmetry above, these figures are ceilings for confabulation.

**Forcing an answer also recovered answers that were there.** Missed answers
fell by half in both (5→3 and 9→5). Permission to refuse was making the model
give up on material that was in the passages. The gain and the cost arrive
together.

**The model would rather break the format than fake grounding.** Version B
requires an answer and forbids leaving the passages: a squeeze with no exit. In
sixteen and eighteen cases the model disobeyed the format — wrote that there
was no source and said in the body that the answer was not there. Against the
intuition that forcing an answer forces invention, what appeared was refusal
dressed as partial obedience, and no fabricated identifiers.

**The two systems converge after correction.** Under A the gap narrowed to 26
against 24; under B both reach 26. The more the evaluation is cleaned, the more
the two look alike — which is what the replication framing predicts.

**The dominant failure mode is not invention.** It is the neighbouring answer:
four to eight cases per run, against zero to five confabulations.

## The neighbouring answer

This is the finding that does not depend on sample size, because it is a
demonstrated class of error rather than an estimated rate.

The model cites a passage that exists, copies the text faithfully, and the
quoted text really does contain what it asserted. What fails is the relation
between the question and the passage: the norm addresses the adjacent subject —
close enough to look like an answer, far enough not to be one.

Question #22 asks who monitors whether the targets of the National Education
Plan are being met, and how often this is published. The model cited art. 6,
under which the federal government holds at least two national education
conferences. The answer is art. 5, the article immediately before it, which
places the execution of the plan and its targets under continuous monitoring
and periodic evaluation by named bodies. A conference is not monitoring, and
the distance is visible without knowing the law.

This passes through every citation verifier in use today, including those that
check whether the quoted text is really in the source — because it is. No
current layer validates the question against the passage.

The same axis produced the first two corrections, in both directions: synonymy
wrongly rejected (#21, #44) and adjacency wrongly accepted. The clause that
separates the two cases is the one that was already in the subject's prompt:
saying in other words what the passage says is part of answering; extending it
to what the passage does not say is not.

## Limits

**One run per cell.** No condition was repeated in full, so there is no estimate
of run-to-run variance. It cannot be claimed that the difference between A and B
is larger than the difference between two runs of A. One partial replicate
exists: an interrupted run of model 2 under version B covering questions 1 to 20
reproduced the definitive run exactly — same outcome and same quotation in all
twenty. It is the easy case, being a pure prefix, a single cell, and the
condition in which the model has least room to choose. It does not soften this
limit.

**Three post-hoc corrections**, declared above with the text and the mechanism
that justify them. It is the most attackable part of this report.

**Agreement between judges is not independent agreement.** The two agreed on 59
of 60, and got #44 wrong in identical fashion. Models with similar training
distributions share blind spots; the agreement measures less than the figure
suggests.

**Audited in both directions.** The 21 questions without an answer were swept by
hunters. The 37 with an answer were audited afterwards by two independent
auditors, who agreed on 33 of 37. In 36 of the 37 the passage the judge pointed
at does address what was asked. The single unanimous `no` is #3, where the
question asks for a specific index score and the passage announces the target
without reaching the numeric table: right article, missing number. Every
reservation raised was partial coverage — the passage covers the substance and
leaves an edge — and all four disagreements fall between `yes` and `partly`,
never near `no`. The sweep changed no figure in this report.

**The subject has two outcomes; the corpus has three.** Seven of the 37 were
marked as partial coverage by at least one auditor, three of them by both, and
two further questions were excluded from the count for the same reason. The
subject's instruction offers no way to express that a passage answers part of a
question, so partial coverage is scored as if it were complete. A third outcome
belongs in the next round's design.

**Corpus contamination, measured and closed.** The Lei 15.100 file carries, in
its opening lines, text from a different statute published in the same edition
of the official gazette. Three chunks of that file carry the neighbouring text;
none of them was served in any of the 60 packets.

**Sixty questions, one corpus, one domain, one language, one day.** The numbers
describe this round.

**Model output is not reproducible.** It is stored as an artefact; the corpus,
the packets and the counter are deterministic.

## What this changes for the project

The synonymy clause enters the grounding specification: it recovered withheld
answers at no cost in invention, in both systems.

The neighbouring answer becomes a named failure mode, and is the concrete
argument for the attribution layer: it has to validate *does this passage answer
the question?*, not only *is this text in the passage?*.

The one-directional bias of the evaluator becomes a design constraint for the
next round. An evaluator whose every layer errs against the subject produces
floors, and floors are useful. Auditing the second direction is what turned
three of the corrections from suspicion into fact, and what retracted a fourth
before it was published; a round that audits only one direction should expect
its figures to be floors without knowing by how much.

## Material

The 60 questions, the 60 passage packets, the four runs of the subject model,
the two sets of judgements, the two hunts, the two reverse audits, the counter
with all corrections applied and commented, and the two prompts under test are
published alongside this report, in this directory.

`count.mjs` reproduces every figure above from those files. It needs
`npm run build` at the repository root, then:

    node bench/rounds/2026-09-12-grounding/count.mjs         claude-A.md gemini-A.md claude-B.md gemini-B.md

`build-packets.mjs` rebuilds the 60 packets from the corpus and the questions,
which is deterministic; the model outputs are not, and are stored as they were
produced.
