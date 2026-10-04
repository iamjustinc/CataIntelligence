# Evaluation report

- **split:** development
- **dataset version:** 791e7aa2793515e3
- **items evaluated:** 151 of 151
- **labeling:** PRELIMINARY: 151 of 151 labels are provisional (written by the model that built this application, not by an independent expert)
- **provider:** baseline
- **model:** none (deterministic)
- **prompt version:** baseline-unique-exact-v1
- **retrieval policy:** lexical-v1
- **signal policy:** signal-v1
- **provider usage:** none
- **generated:** 2026-10-04T00:28:32.591Z

| Measure | Result | Count | Note |
| --- | --- | --- | --- |
| Retrieval recall at 10 | 86.1% | 99/115 | KPI01 target 95%. Labelable items only |
| Top suggestion accuracy (strict) | 29.6% | 34/115 | KPI02 target 85%. Abstentions and failures count as misses |
| Top suggestion accuracy (lenient) | 33.9% | 39/115 | Also counts labeled acceptable alternatives |
| Ranking accuracy when retrieved | 34.3% | 34/99 | Separates ranking from retrieval misses |
| Correct abstention | 91.7% | 33/36 | Items where abstaining is right |
| False selection | 8.3% | 3/36 | Selected a leaf where abstaining is right |
| Over-abstention | 65.2% | 75/115 | Abstained on a labelable item |
| Abstention rate | 71.5% | 108/151 | All items |
| Evidence faithfulness | 100.0% | 151/151 | Responses passing server validation, including literal excerpts |
| Selections citing evidence | 100.0% | 43/43 |  |
| Provider failures | 0.0% | 0/151 | Refusals, truncation, errors, invalid output |
| High band precision | 79.1% | 34/43 | KPI03 target 95%. Coverage 28.5% |
| Medium band precision | n/a | 0/0 | Coverage 0.0% |
| Low band precision | n/a | 0/0 | Coverage 0.0% |

## Right outcome by issue type

| Issue | Result | Count |
| --- | --- | --- |
| ambiguous | 85.7% | 12/14 |
| attribute_trap | 36.4% | 8/22 |
| injection | 100.0% | 3/3 |
| misleading_category | 83.3% | 5/6 |
| missing_concept | 95.5% | 21/22 |
| none | 28.0% | 21/75 |
| overlapping_label | 22.2% | 4/18 |
| sparse | 100.0% | 4/4 |

## High signal gate

**Not met.** The High band stays disabled.

- The gate is evaluated on the held-out split only.
- The gate requires results from the live model, not a baseline or fixture provider.
- 151 of 151 records are not independently expert-labeled.
- Only 43 High selections; at least 50 are needed for a meaningful precision estimate.
- High precision is 79.1%; the target is at least 95%.

Retrieval misses: dev-pears, dev-grapes, dev-onions, dev-sirloin, dev-sourdough, dev-croissants, dev-cinnamon, dev-club-soda, dev-tonic, dev-root-beer, dev-cleaning-vinegar, dev-teething-wafers, dev-spatula, dev-power-bank, dev-highlighters, dev-index-cards
