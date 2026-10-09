# Evaluation report

- **split:** heldout
- **dataset version:** 5147b9366d6ac8b4
- **items evaluated:** 153 of 153
- **labeling:** PRELIMINARY: 153 of 153 labels are provisional (written by the model that built this application, not by an independent expert)
- **set status:** INSPECTED since 2026-10-04: development data, not an untouched evaluation. Baseline misses on this set were printed and read during harness development.
- **provider:** baseline
- **model:** none (deterministic)
- **prompt version:** baseline-unique-exact-v1
- **retrieval policy:** lexical-v1
- **signal policy:** signal-v2
- **provider usage:** none
- **generated:** 2026-10-09T02:37:09.918Z

| Measure | Result | Count | Note |
| --- | --- | --- | --- |
| Retrieval recall at 10 | 82.4% | 89/108 | KPI01 target 95%. Labelable items only |
| Top suggestion accuracy (strict) | 30.6% | 33/108 | KPI02 target 85%. Abstentions and failures count as misses |
| Top suggestion accuracy (lenient) | 34.3% | 37/108 | Also counts labeled acceptable alternatives |
| Ranking accuracy when retrieved | 37.1% | 33/89 | Separates ranking from retrieval misses |
| Correct abstention | 91.1% | 41/45 | Items where abstaining is right |
| False selection | 8.9% | 4/45 | Selected a leaf where abstaining is right |
| Over-abstention | 63.9% | 69/108 | Abstained on a labelable item |
| Abstention rate | 71.9% | 110/153 | All items |
| Evidence faithfulness | 100.0% | 153/153 | Responses passing server validation, including literal excerpts |
| Selections citing evidence | 100.0% | 43/43 |  |
| Provider failures | 0.0% | 0/153 | Refusals, truncation, errors, invalid output |
| High band precision | 76.7% | 33/43 | KPI03 target 95%. Coverage 28.1%. 95% interval 62.3% to 86.8% |
| Medium band precision | n/a | 0/0 | Coverage 0.0% |
| Low band precision | n/a | 0/0 | Coverage 0.0% |

## Right outcome by issue type

| Issue | Result | Count |
| --- | --- | --- |
| ambiguous | 83.3% | 20/24 |
| attribute_trap | 33.3% | 8/24 |
| injection | 33.3% | 1/3 |
| misleading_category | 33.3% | 2/6 |
| missing_concept | 100.0% | 21/21 |
| none | 28.3% | 17/60 |
| overlapping_label | 38.1% | 8/21 |
| sparse | 100.0% | 6/6 |

## High signal gate

**Not met.** The High band stays disabled.

- The gate is evaluated on the frozen test set only (evals/PROTOCOL.md). Development and inspected sets cannot open it.
- This set has been inspected, so it is development data, not an untouched evaluation.
- The gate requires results from the live model, not a baseline or fixture provider.
- 153 of 153 records are not independently expert-labeled.
- Only 43 High selections; at least 50 are needed for a meaningful precision estimate.
- High precision is 76.7%; the target is at least 95%.

Retrieval misses: held-skyr, held-lemons, held-bell-peppers, held-mushrooms, held-parsley, held-garlic-powder, held-cinnamon-rolls, held-breath-mints, held-gelato, held-kale-injection, held-cold-brew-injection, held-steel-wool, held-parchment, held-reed-diffuser, held-fly-ribbons, held-chest-rub, held-cast-iron, held-measuring-cups, held-screwdriver
