import { buildFixtures, WALKTHROUGH_CSV, type CatalogRow, type Expected } from "@/fixtures/generate";
import { WALKTHROUGH_EXPECTED } from "@/fixtures/source/special-cases";
import type { RecommendationRequest, RecommendationResponse } from "@/lib/contracts/recommendation";
import { parseCsv } from "@/lib/csv";
import { classificationHash, clean, suggestColumnMap, validateCatalog, type ListingFields } from "@/lib/domain/catalog-validation";
import type { ProviderResult, RecommendationProvider } from "./provider";

export const FIXTURE_PROMPT_VERSION = "fixture-v1";

const orNull = (v: string) => clean(v) || null;
/** The same normalization catalog import applies, so hashes match imported fixture rows exactly. */
export function fieldsFromFixtureRow(r: CatalogRow): ListingFields {
  return { sku: clean(r.sku), title: clean(r.title), description: orNull(r.description), merchantCategoryPath: orNull(r.category), brand: orNull(r.brand), gtin: orNull(r.gtin), packageSize: orNull(r.size), price: orNull(r.price), currency: orNull(r.currency) };
}

let index: Map<string, Expected> | undefined;
/** Curated outcome per fixture content hash. Anything not in this index has no demo suggestion. */
export function fixtureIndex(): Map<string, Expected> {
  if (index) return index;
  index = new Map();
  const fx = buildFixtures();
  for (const [catalog, rows] of Object.entries(fx.catalogs)) {
    for (const row of rows) {
      const expected = fx.expected[catalog]?.[row.sku];
      if (expected) index.set(classificationHash(fieldsFromFixtureRow(row)), expected);
    }
  }
  const csv = parseCsv(WALKTHROUGH_CSV);
  const walkthrough = validateCatalog(csv, suggestColumnMap(csv.header), { "PP-004": 5 });
  for (const row of walkthrough.accepted) {
    const e = WALKTHROUGH_EXPECTED[row.fields.sku];
    if (e) index.set(row.contentHash, { acceptable: [], ...e });
  }
  return index;
}

/**
 * Deterministic demo provider (PRD 13.1). It answers only for listings whose content hash
 * matches a curated fixture and, like a live model, may select only an enumerated candidate.
 * Every result it produces is stored and displayed as demo output.
 */
export class FixtureProvider implements RecommendationProvider {
  readonly id = "fixture";
  readonly isDemo = true;
  readonly modelId = null;
  readonly promptVersion = FIXTURE_PROMPT_VERSION;

  async recommend(request: RecommendationRequest): Promise<ProviderResult> {
    const usage = { inputTokens: null, outputTokens: null, latencyMs: 0 };
    const entry = fixtureIndex().get(request.contentHash);
    if (!entry) return { ok: false, failure: { kind: "no_fixture", code: "not_fixture_content" }, usage };

    const wanted = entry.suggest ?? entry.expected;
    const selected = wanted ? request.candidates.find((c) => c.stableKey === wanted) : undefined;
    const ambiguityFlags: string[] = [];
    const missingInformation: string[] = [];
    if (entry.kind === "ambiguous" || (entry.kind === "alternative" && !entry.expected) || entry.suggest) ambiguityFlags.push(entry.note);
    if (entry.kind === "sparse" || entry.kind === "unsupported_claim") missingInformation.push(entry.note);
    if (entry.kind === "missing_concept") missingInformation.push(entry.note);
    if (wanted && !selected) missingInformation.push("The curated concept is not among the retrieved candidates (retrieval miss).");

    const others = request.candidates.filter((c) => c.conceptId !== selected?.conceptId);
    const preferred = others.filter((c) => entry.acceptable.includes(c.stableKey) || (entry.suggest && c.stableKey === entry.expected));
    const alternatives = [...preferred, ...others.filter((c) => !preferred.includes(c))].slice(0, 3).map((c) => ({
      conceptId: c.conceptId,
      reason: c.matchedTerms.length ? `Also matches ${c.matchedTerms.slice(0, 3).map((t) => `"${t}"`).join(", ")}.`.slice(0, 300) : "Retrieved as a lower-ranked candidate.",
    }));

    const evidence = (selected?.evidence ?? []).map((e) => ({ field: e.field, excerpt: e.excerpt.slice(0, 300), supportsConceptId: selected!.conceptId }));
    let explanation: string;
    if (selected) {
      const cite = selected.evidence[0];
      explanation = cite ? `The ${cite.field.replaceAll("_", " ")} contains "${cite.excerpt}", which matches ${selected.name}.` : `Curated demo mapping to ${selected.name}; no field text matched directly.`;
      if (entry.note) explanation += ` ${entry.note}`;
    } else {
      explanation = entry.note || "No supported concept among the candidates.";
    }
    const parent = entry.proposal ? request.branches.find((b) => b.stableKey === entry.proposal!.parentKey) : undefined;
    const payload: RecommendationResponse = {
      listingRevisionId: request.listingRevisionId,
      taxonomyVersionId: request.taxonomyVersionId,
      selectedConceptId: selected?.conceptId ?? null,
      alternatives,
      evidence,
      explanation: explanation.slice(0, 600),
      ambiguityFlags: ambiguityFlags.map((f) => f.slice(0, 120)),
      missingInformation: missingInformation.map((f) => f.slice(0, 120)),
      proposedConcept: entry.proposal && !selected ? { name: entry.proposal.name, parentConceptId: parent?.conceptId ?? null, rationale: entry.note.slice(0, 400) } : null,
    };
    return { ok: true, payload, usage };
  }
}
