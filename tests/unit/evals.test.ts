import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVELOPMENT_SPLITS, HELDOUT_STATUS, loadDataset, MAX_FROZEN_RUNS, type EvalRecord, type FrozenManifest } from "@/evals/corpus";
import { checkCorpus, jaccard } from "@/evals/leakage";
import { computeMetrics, highSignalGate, wilson, type ItemOutcome } from "@/evals/metrics";
import { BaselineProvider, evaluate } from "@/evals/run";

const development = loadDataset("development");
const heldout = loadDataset("heldout");
const rec = (id: string, over: Partial<EvalRecord> & { key?: string | null; acceptable?: string[] } = {}): EvalRecord => ({
  id,
  split: "heldout",
  merchant: "Quay Street Grocer",
  family: id,
  domain: "grocery",
  title: `Title ${id}`,
  description: null,
  merchantCategoryPath: null,
  brand: null,
  packageSize: null,
  label: { conceptKey: over.key === undefined ? "GRO-DAI-MILK" : over.key, acceptable: over.acceptable ?? [], missingConcept: false, issues: [], difficulty: "easy" },
  labeling: { source: "provisional_model_authored", labelers: ["x"], adjudicated: false, disagreement: null },
  ...over,
});
const outcome = (record: EvalRecord, o: Partial<ItemOutcome>): ItemOutcome => ({ record, candidateKeys: ["GRO-DAI-MILK"], status: "selected", selectedKey: "GRO-DAI-MILK", failureCode: null, valid: true, evidenceCount: 1, band: "medium", ...o });

describe("evaluation corpus", () => {
  it("meets the PRD composition minimums and has no leakage", () => {
    const report = checkCorpus(development.records, heldout.records);
    expect(report.problems).toEqual([]);
    expect(report.composition).toMatchObject({ total: 304, development: 151, heldout: 153, domains: 8, heldoutOnlyMerchants: ["Quay Street Grocer"] });
    expect(report.composition.ambiguous).toBeGreaterThanOrEqual(30);
    expect(report.composition.missingConcept).toBeGreaterThanOrEqual(20);
  });
  it("states honestly that no label is expert ground truth yet", () => {
    expect(development.labeling.expert + heldout.labeling.expert).toBe(0);
    expect(heldout.records.every((r) => r.labeling.source === "provisional_model_authored" && !r.labeling.adjudicated)).toBe(true);
  });
  it("detects duplicates, near-duplicates, shared families and invalid labels", () => {
    const base = development.records[0];
    const copy: EvalRecord = { ...heldout.records[0], id: "held-copy", family: base.family, title: base.title };
    const near: EvalRecord = { ...heldout.records[1], id: "held-near", title: `${development.records[6].title} Organic` };
    const bad: EvalRecord = { ...heldout.records[2], id: "held-bad", label: { ...heldout.records[2].label, conceptKey: "GRO-DAI" } };
    const { problems } = checkCorpus(development.records, [...heldout.records, copy, near, bad]);
    expect(problems.some((p) => p.includes(`Family "${base.family}" appears in both`))).toBe(true);
    expect(problems.some((p) => p.includes("are duplicates") && p.includes("held-copy"))).toBe(true);
    expect(problems.some((p) => p.includes("near-duplicates") && p.includes("held-near"))).toBe(true);
    expect(problems.some((p) => p.includes('"GRO-DAI" is not a mappable leaf'))).toBe(true);
    // The demo fixtures are checked too: a fixture title cannot be reused as an evaluation item.
    const fromDemo: EvalRecord = { ...heldout.records[3], id: "held-demo", family: "demo-copy", title: "Meadow Lane Whole Milk" };
    expect(checkCorpus(development.records, [...heldout.records, fromDemo]).problems.some((p) => p.startsWith("held-out vs demo fixtures"))).toBe(true);
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });
});

describe("evaluation metrics", () => {
  const a = rec("a");
  const b = rec("b");
  const c = rec("c", { acceptable: ["GRO-DAI-PLANT"] });
  const d = rec("d");
  const abstainRight = rec("e", { key: null });
  const abstainWrong = rec("f", { key: null });
  const outcomes: ItemOutcome[] = [
    outcome(a, { band: "high" }), // correct
    outcome(b, { candidateKeys: ["GRO-DAI-PLANT"], selectedKey: "GRO-DAI-PLANT", band: "high" }), // retrieval miss, wrong
    outcome(c, { selectedKey: "GRO-DAI-PLANT", candidateKeys: ["GRO-DAI-MILK", "GRO-DAI-PLANT"], band: "medium" }), // acceptable only
    outcome(d, { status: "abstained", selectedKey: null, band: "none", evidenceCount: 0 }), // over-abstention
    outcome(abstainRight, { status: "abstained", selectedKey: null, band: "none", evidenceCount: 0 }),
    outcome(abstainWrong, { band: "low", evidenceCount: 0 }), // false selection
    outcome(rec("g"), { status: "failed", selectedKey: null, valid: false, failureCode: "refusal:refusal", band: null }),
    outcome(rec("h"), { status: "failed", selectedKey: null, valid: false, failureCode: "invalid:unsupported_evidence", band: null }),
  ];
  const m = computeMetrics(outcomes);
  it("separates retrieval from ranking and counts abstentions and failures as misses", () => {
    expect(m).toMatchObject({ items: 8, labelable: 6, shouldAbstain: 2 });
    expect(m.retrievalRecallAt10).toEqual({ n: 6, hits: 5, rate: 5 / 6 });
    expect(m.retrievalMisses).toEqual(["b"]);
    expect(m.top1Accuracy).toEqual({ n: 6, hits: 1, rate: 1 / 6 });
    expect(m.top1AccuracyLenient.hits).toBe(2);
    expect(m.rankingAccuracyGivenRetrieved).toEqual({ n: 5, hits: 1, rate: 1 / 5 });
  });
  it("measures abstention behavior in both directions", () => {
    expect(m.abstention.correctAbstention).toEqual({ n: 2, hits: 1, rate: 0.5 });
    expect(m.abstention.falseSelection).toEqual({ n: 2, hits: 1, rate: 0.5 });
    expect(m.abstention.overAbstention.hits).toBe(1);
  });
  it("measures evidence faithfulness over responses received and band precision with coverage", () => {
    // The refusal produced no response; the invalid answer did, and it was unfaithful.
    expect(m.evidenceFaithfulness).toEqual({ n: 7, hits: 6, rate: 6 / 7 });
    expect(m.providerFailures.hits).toBe(2);
    expect(m.bands.high.precision).toEqual({ n: 2, hits: 1, rate: 0.5 });
    expect(m.bands.high.coverage).toEqual({ n: 8, hits: 2, rate: 0.25 });
    // A selection on an item that should be abstained on is never a correct band member.
    expect(m.bands.low.precision).toEqual({ n: 1, hits: 0, rate: 0 });
    expect(computeMetrics([]).top1Accuracy.rate).toBeNull();
  });
  it("keeps the High gate closed without a live model, expert labels, enough selections and 95% precision", () => {
    const gate = highSignalGate({ split: "frozen", provider: "baseline", expertLabeled: 0, items: 8, metrics: m });
    expect(gate.met).toBe(false);
    expect(gate.reasons).toHaveLength(4);
    const perfect = computeMetrics(Array.from({ length: 60 }, (_, i) => outcome(rec(`p${i}`), { band: "high" })));
    expect(highSignalGate({ split: "frozen", provider: "claude", expertLabeled: 60, items: 60, metrics: perfect })).toEqual({ met: true, reasons: [] });
    // The inspected former held-out set is development data: it cannot open the gate whatever it scores.
    expect(highSignalGate({ split: "heldout", provider: "claude", expertLabeled: 60, items: 60, metrics: perfect }).met).toBe(false);
    expect(highSignalGate({ split: "frozen", provider: "claude", expertLabeled: 59, items: 60, metrics: perfect }).met).toBe(false);
    // A set that has been looked at cannot open the gate, however good the numbers are.
    const inspected = highSignalGate({ split: "frozen", provider: "claude", expertLabeled: 60, items: 60, metrics: perfect, inspected: true });
    expect(inspected.met).toBe(false);
    expect(inspected.reasons[0]).toMatch(/has been inspected/);
    expect(HELDOUT_STATUS.inspected).toBe(true);
    expect(highSignalGate({ split: "development", provider: "claude", expertLabeled: 60, items: 60, metrics: perfect }).met).toBe(false);
  });
});

describe("evaluation runner", () => {
  it("runs the deterministic baseline end to end through request building and server validation", async () => {
    const first = await evaluate(development, new BaselineProvider(), { maxItems: 40 });
    const second = await evaluate(development, new BaselineProvider(), { maxItems: 40 });
    expect(first.evaluated).toBe(40);
    expect(first.metrics).toEqual(second.metrics);
    expect(first.metrics.evidenceFaithfulness.rate).toBe(1);
    expect(first.metrics.providerFailures.hits).toBe(0);
  });
});

describe("frozen test set (evals/PROTOCOL.md)", () => {
  const expert = (id: string): EvalRecord => ({ ...rec(id), split: "frozen", labeling: { source: "expert", labelers: ["Labeler A", "Labeler B"], adjudicated: true, disagreement: null } });
  function fixture(records: EvalRecord[], manifest: (text: string) => Partial<FrozenManifest> | null) {
    const dir = mkdtempSync(join(tmpdir(), "ci-frozen-"));
    const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(join(dir, "frozen.jsonl"), text);
    const m = manifest(text);
    if (m) writeFileSync(join(dir, "frozen.manifest.json"), JSON.stringify({ sha256: createHash("sha256").update(text).digest("hex"), records: records.length, frozenAt: "2026-11-01T00:00:00.000Z", author: "Set Author", labelers: ["Labeler A", "Labeler B"], adjudicator: "Adjudicator", agreement: { raw: 0.9, kappa: 0.8 }, inspected: null, scoredRuns: 0, ...m }));
    return dir;
  }
  const attempt = (dir: string) => {
    try {
      return loadDataset("frozen", dir).records.length;
    } catch (err) {
      return (err as Error).message;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("does not exist yet, and asking for it fails loudly instead of falling back to another set", () => {
    expect(() => loadDataset("frozen")).toThrow(/No frozen test set exists yet/);
    expect(DEVELOPMENT_SPLITS).toEqual(["development", "heldout"]);
  });
  it("loads only when the file matches its manifest and every record is expert-labeled by two people", () => {
    expect(attempt(fixture([expert("a"), expert("b")], () => ({})))).toBe(2);
    expect(attempt(fixture([expert("a")], () => null))).toMatch(/has not been frozen/);
    expect(attempt(fixture([expert("a")], () => ({ sha256: "0".repeat(64) })))).toMatch(/changed after freezing/);
    expect(attempt(fixture([expert("a"), { ...rec("b"), split: "frozen" }], () => ({})))).toMatch(/1 records are not expert-labeled/);
    expect(attempt(fixture([{ ...expert("a"), labeling: { source: "expert", labelers: ["Labeler A"], adjudicated: true, disagreement: null } }], () => ({})))).toMatch(/not labeled by two people/);
    expect(attempt(fixture([{ ...expert("a"), labeling: { source: "expert", labelers: ["Labeler A", "Labeler B"], adjudicated: false, disagreement: null } }], () => ({})))).toMatch(/neither adjudicated nor recorded as a disagreement/);
    expect(attempt(fixture([{ ...expert("a"), labeling: { source: "expert", labelers: ["Labeler A", "The Developer"], adjudicated: true, disagreement: null } }], () => ({})))).toMatch(/not in the manifest/);
  });
  it("is spent once inspected or scored too often", () => {
    expect(attempt(fixture([expert("a")], () => ({ inspected: { at: "2026-11-02T00:00:00.000Z", reason: "Misses were read." } })))).toMatch(/development data now/);
    expect(attempt(fixture([expert("a")], () => ({ scoredRuns: MAX_FROZEN_RUNS })))).toMatch(/retires a set after 5/);
  });
  it("reports a Wilson interval beside High precision", () => {
    const w = wilson(48, 50)!;
    expect(w.low).toBeCloseTo(0.865, 2);
    expect(w.high).toBeCloseTo(0.989, 2);
    expect(wilson(0, 0)).toBeNull();
  });
});

describe("thin evidence (signal-v2)", () => {
  it("treats a model's default pick for a bare one-word listing as low signal needing investigation, without touching its label", async () => {
    const { evaluationTaxonomy } = await import("@/evals/corpus");
    const { requestFor } = await import("@/evals/run");
    const { signalBand, thinEvidence, SIGNAL_POLICY_VERSION } = await import("@/lib/ai/validate-recommendation");
    const taxonomy = evaluationTaxonomy();
    const pick = (id: string, key: string) => {
      const record = development.records.find((r) => r.id === id)!;
      const request = requestFor(record, 0, taxonomy);
      const conceptId = request.candidates.find((c) => taxonomy.keyOfId.get(c.conceptId) === key)!.conceptId;
      const response = { listingRevisionId: request.listingRevisionId, taxonomyVersionId: request.taxonomyVersionId, selectedConceptId: conceptId, alternatives: [], evidence: [], explanation: "", ambiguityFlags: [], missingInformation: [], proposedConcept: null };
      return { record, request, response };
    };
    // What the live model answered on 2026-10-08: "Water", no description, picked still water with no flags.
    const water = pick("dev-water-sparse", "BEV-WATER-STILL");
    expect(water.record.label.conceptKey).toBeNull(); // the expected outcome stays abstention
    expect(thinEvidence(water.request, water.response)).toBe(true);
    expect(signalBand(water.request, water.response, false)).toMatchObject({ band: "low" });
    expect(signalBand(water.request, water.response, true).band).toBe("low");
    // A listing with a description is judged on its text as before.
    const cheese = pick("dev-cottage-cheese", "GRO-DAI-CHEESE");
    expect(thinEvidence(cheese.request, cheese.response)).toBe(false);
    expect(thinEvidence(water.request, { ...water.response, selectedConceptId: null })).toBe(false);
    expect(SIGNAL_POLICY_VERSION).toBe("signal-v2");
  });
});
