# Independent evaluation protocol

Status: **defined, not executed.** No frozen test set exists yet. Every number reported so far comes from development data with provisional labels, and none of it can open a launch gate.

This protocol covers PRD section 13.5 and KPI01 to KPI05. It exists because the first "held-out" set stopped being independent: its misses were printed and read while the harness was built.

## 1. Data sets and what each may be used for

| Set | File | Labels | Allowed use |
| --- | --- | --- | --- |
| Development | `evals/corpus/development.jsonl` | Provisional, written by the application's author | Tuning retrieval, prompts and signal policy. Reading individual results |
| Inspected (former held-out) | `evals/corpus/heldout.jsonl` | Provisional | **Development data.** Same uses as above. Its reports are labeled INSPECTED. It can never open a gate |
| Frozen test | `evals/corpus/frozen.jsonl` with `evals/corpus/frozen.manifest.json` | Expert, adjudicated | Reporting only. **Does not exist yet** |
| Demo fixtures | `fixtures/generated/*` | Curated demo answers | The demo. Never an evaluation set |

The code enforces this: `pnpm eval --split frozen` refuses to run without a manifest whose hash matches the file, refuses records that are not expert-labeled, prints aggregate results only, and appends every run to `evals/reports/frozen-access-log.jsonl`. The High signal gate accepts the frozen split only.

## 2. Who does what

Four roles, held by at least three different people. None of them may be the person, or the model, that writes or tunes the retrieval rules, prompts or signal policy.

| Role | Responsibility |
| --- | --- |
| Set author | Collects or writes the listings. Does not see the application's outputs |
| Labeler A and labeler B | Each labels every record independently, without seeing the other's labels or any model output |
| Adjudicator | A taxonomy owner. Resolves disagreements, or records them as disagreements |
| Evaluator | Runs the frozen evaluation and reports the aggregates. May be the developer, because the runner exposes no per-item results |

## 3. Building the frozen set

1. **Source.** At least 200 listings across three merchants and the eight domains (grocery, beverages, household, personal care, OTC health, pet, baby, general merchandise). At least 30 ambiguous, at least 20 with no suitable concept, plus overlapping merchant labels, sparse descriptions, misleading category paths and instructions embedded in text. Real merchant data needs the owner's permission and a check of the provider's retention terms before any live run.
2. **No leakage.** No product family, and no title or near-duplicate title, shared with the development set, the inspected set or the demo fixtures. At least one merchant that appears nowhere else. `pnpm eval:check` verifies this mechanically and must pass before freezing.
3. **Label.** For each record: the correct leaf's stable key or abstention, acceptable alternatives, the reason, issue types and difficulty. Labelers use the published taxonomy definitions only.
4. **Adjudicate.** Every record where A and B differ goes to the adjudicator. The outcome is either one label with `adjudicated: true`, or a recorded `disagreement` with both alternatives. A disagreement is not forced into a single truth; it is scored leniently and reported separately.
5. **Report agreement.** Raw agreement and Cohen's kappa between A and B before adjudication, overall and for the ambiguous subset.
6. **Freeze.** Run `pnpm eval:freeze`. It writes the manifest: SHA-256 of the file, record count, composition, labeler and adjudicator names, agreement figures and the freeze date. Commit both files together. From that commit the file is immutable; any change is a new version with a new manifest and resets every result.

## 4. Running it

- One run per release candidate: `pnpm eval --split frozen --provider claude`. Record the model ID, prompt version, retrieval policy and signal policy, which the report already includes.
- Decide the configuration on development data first. A frozen run is a measurement, not an experiment.
- The runner prints aggregates and the gate decision. It does not print which records were missed.
- **If anyone looks at per-record results on the frozen set, or changes anything in response to a frozen result and reruns, the set is spent.** Record it in the manifest (`inspected`), move it to development use, and build a new one. This is what happened to the first held-out set, and it is the rule that keeps the next one honest.
- A set is also retired after five scored runs, because repeated selection on aggregates leaks too.

## 5. What is reported

| Measure | Target | Notes |
| --- | --- | --- |
| Retrieval recall at 10 (KPI01) | 95% | Labelable records only |
| Top suggestion accuracy (KPI02) | 85% | Abstentions and failures count as misses. Strict and lenient both reported |
| High band precision (KPI03) | 95% | With coverage, the number of High selections and a 95% Wilson interval |
| Abstention | none set | Correct abstention, false selection and over-abstention, separately |
| Evidence faithfulness | none set | Share of responses passing server validation |
| Provider failures | none set | Refusals, truncation, errors, invalid output |

Every report states the sample size, the dataset version (hash), the share of expert labels and the labeler agreement.

## 6. The High signal gate

High stays disabled (`high_signal_enabled = false`; nothing in the application sets it). An administrator may enable it only when one frozen run shows all of:

- the frozen split, with a valid manifest and no `inspected` mark;
- results from the live model;
- every record expert-labeled;
- at least 50 High selections;
- High precision of at least 95%, with the lower bound of the 95% interval reported beside it. The decision to accept a lower bound below 95% is the taxonomy owner's, recorded in DECISIONS.md.

## 7. Analytics questions (KPI05)

The 40-question benchmark in `evals/analytics/benchmark.ts` was written by the author of the demo planner. It is a regression check. An independent measure needs:

1. At least 40 new questions written by catalog operations staff who have not read the planner rules or prompt, phrased the way they would ask.
2. For each, an expected outcome agreed by two people: a reference AnalysisSpec, a clarification, or a refusal. Reference numbers come from hand-written SQL, as now.
3. One run with the live planner: `pnpm eval:analytics:live`. Report supported-question accuracy separately from the refusal and clarification rate, and the count of questions that ran when they should not have. That count must be zero.

## 8. Studies that need people

| KPI | Protocol |
| --- | --- |
| KPI04 Review time | Two matched sets of at least 60 listings. At least four taxonomists, each doing one set with suggestions and one without, order and assignment counterbalanced. Compare median active seconds per listing (the application already records active duration), counting corrections and investigations. Report the difference with its interval |
| KPI08 Usability | Five target users, no developer help, one script: import a catalog, review it, publish a partial release, ask one question. Success is finishing all four. Record where each person stalled |

## 9. Current state

- Development set: 151 records. Inspected set: 153 records. All labels provisional.
- Frozen set: not built. No labelers have been engaged.
- Live model runs: none, on any set. No credentials were available.
- High signal: disabled.
