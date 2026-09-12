# The eight prompts

The report claims that none of the role prompts mentions a test, a
measurement, a gold standard, or the existence of another role. These files
are what makes that claim checkable — and what makes the one exception
checkable too: the output filenames each agent was told to write to carry the
model name and the version letter, which implies a comparative run. That is
discussed in the report's design section and is not repaired here, because
repairing it after the fact would only hide it.

Each file holds the instruction as given. What is NOT reproduced here is the
mechanical tail every agent also received: where its input files live, where
to append its output, to work one item at a time, and to report only a count.
Those paths are specific to the machine that ran the round and say nothing
about the task; the filenames they name are quoted in the report where they
matter.

| file | role | author |
|---|---|---|
| `subject-version-a.md` | the model under test, may refuse | owner |
| `subject-version-b.md` | the model under test, must answer | owner |
| `writer-with-corpus.md` | wrote 30 questions having read the corpus | owner |
| `writer-domain-only.md` | wrote 30 questions having seen no document | owner |
| `curator.md` | removed duplicates, shuffled, hid the origin | owner |
| `judge.md` | located the answer, or declared absence | owner |
| `hunter.md` | tried to prove existence where the judges found none | assistant, owner-approved |
| `auditor.md` | judged whether the judge's passage answers | assistant, owner-approved |

The two subject prompts differ by one paragraph and are otherwise identical
byte for byte; that paragraph is the independent variable of the round.

Both judges, both hunters and both auditors received the same prompt as their
counterpart on the other model. For the runs executed on the second model, the
prompt was transmitted verbatim over the bridge and its use confirmed by the
operator; this repository holds the text as sent, not a capture of what that
process received.
