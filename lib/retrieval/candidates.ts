/**
 * Deterministic candidate retrieval (PRD TAX05). Pure and independently testable: given the
 * active mappable leaves of one taxonomy version and one product, return at most ten candidates
 * with scores and the terms that matched. No model is involved.
 */
import { clean } from "@/lib/domain/catalog-validation";

export const RETRIEVAL_POLICY_VERSION = "lexical-v1";
export const MAX_CANDIDATES = 10;

export interface RetrievalConcept {
  conceptId: string;
  stableKey: string;
  parentConceptId: string | null;
  name: string;
  definition: string;
  synonyms: string[];
  path: string;
}
export interface RetrievalProduct {
  title: string;
  description: string | null;
  merchantCategoryPath: string | null;
  brand: string | null;
}
export interface CandidateEvidence {
  field: "title" | "description" | "merchant_category_path";
  /** Text exactly as it appears in the product field. */
  excerpt: string;
}
export interface Candidate {
  conceptId: string;
  stableKey: string;
  path: string;
  name: string;
  definition: string;
  score: number;
  matchedTerms: string[];
  /** A name or synonym of this concept appears as a whole phrase in the title and is not part of a longer phrase owned by another concept. */
  exactAlias: boolean;
  evidence: CandidateEvidence[];
}

const STOP = new Set(["a", "an", "and", "the", "of", "for", "with", "in", "to", "or", "by", "on", "from", "pack", "count", "ct", "oz", "fl", "lb", "gal", "qt", "pc", "per", "x", "new", "other", "such", "as", "including", "sold"]);

interface Token {
  norm: string;
  start: number;
  end: number;
}

const stem = (w: string) => {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("oes")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
};

/** Lowercased, lightly stemmed word tokens with their character offsets in the cleaned text. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;
  for (const m of clean(text).matchAll(re)) {
    const raw = m[0].toLowerCase().replace(/['’]s$/, "");
    // Size tokens such as "64oz" or "12ct" carry no product-type information.
    if (STOP.has(raw) || /^\d+[a-z]{1,3}$/.test(raw)) continue;
    out.push({ norm: stem(raw), start: m.index, end: m.index + m[0].length });
  }
  return out;
}
const norms = (text: string) => tokenize(text).map((t) => t.norm);

/** A concept's name and synonyms as token phrases. */
function aliasPhrases(c: RetrievalConcept): string[][] {
  const seen = new Set<string>();
  const phrases: string[][] = [];
  for (const t of [c.name, ...c.synonyms]) {
    const p = norms(t);
    const key = p.join(" ");
    if (p.length > 0 && !seen.has(key)) {
      seen.add(key);
      phrases.push(p);
    }
  }
  return phrases;
}

function findPhrase(tokens: Token[], phrase: string[]): [number, number] | null {
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    if (phrase.every((p, j) => tokens[i + j].norm === p)) return [i, i + phrase.length];
  }
  return null;
}

export function retrieveCandidates(concepts: RetrievalConcept[], product: RetrievalProduct): Candidate[] {
  const title = clean(product.title);
  const description = clean(product.description ?? "");
  const category = clean(product.merchantCategoryPath ?? "");
  const titleTokens = tokenize(title);
  const descTokens = tokenize(description);
  const titleSet = new Set(titleTokens.map((t) => t.norm));
  const descSet = new Set(descTokens.map((t) => t.norm));
  const categorySet = new Set(norms(category));

  // Whole-phrase alias matches in the title, longest span per concept.
  const spans = new Map<string, [number, number]>();
  const descAlias = new Map<string, [number, number]>();
  for (const c of concepts) {
    for (const phrase of aliasPhrases(c)) {
      const inTitle = findPhrase(titleTokens, phrase);
      const best = spans.get(c.conceptId);
      if (inTitle && (!best || inTitle[1] - inTitle[0] > best[1] - best[0])) spans.set(c.conceptId, inTitle);
      const inDesc = findPhrase(descTokens, phrase);
      if (inDesc && !descAlias.has(c.conceptId)) descAlias.set(c.conceptId, inDesc);
    }
  }
  // Product type versus attribute: "almond" inside "almond milk" belongs to the longer phrase.
  const exact = new Map<string, [number, number]>();
  for (const [id, span] of spans) {
    const swallowed = [...spans].some(([other, o]) => other !== id && o[0] <= span[0] && o[1] >= span[1] && o[1] - o[0] > span[1] - span[0]);
    if (!swallowed) exact.set(id, span);
  }
  const lastEnd = Math.max(0, ...[...exact.values()].map((s) => s[1]));

  const scored: Candidate[] = [];
  for (const c of concepts) {
    const matched = new Set<string>();
    const evidence: CandidateEvidence[] = [];
    let score = 0;
    const span = exact.get(c.conceptId);
    if (span) {
      // The phrase that ends last in the title is usually the head noun, i.e. the product type.
      score += 10 + 2 * (span[1] - span[0]) + (span[1] === lastEnd ? 3 : 0);
      const excerpt = title.slice(titleTokens[span[0]].start, titleTokens[span[1] - 1].end);
      matched.add(excerpt.toLowerCase());
      evidence.push({ field: "title", excerpt });
    }
    const dSpan = descAlias.get(c.conceptId);
    if (dSpan) {
      score += 4;
      const excerpt = description.slice(descTokens[dSpan[0]].start, descTokens[dSpan[1] - 1].end);
      matched.add(excerpt.toLowerCase());
      evidence.push({ field: "description", excerpt });
    }
    const overlap = (source: Set<string>, text: string, weight: number, field?: CandidateEvidence["field"]) => {
      for (const n of new Set(norms(text))) {
        if (!source.has(n)) continue;
        score += weight;
        matched.add(n);
        if (field && evidence.length === 0) {
          const tok = (field === "title" ? titleTokens : descTokens).find((t) => t.norm === n);
          if (tok) evidence.push({ field, excerpt: (field === "title" ? title : description).slice(tok.start, tok.end) });
        }
      }
    };
    overlap(titleSet, c.name, 2, "title");
    overlap(titleSet, c.synonyms.join(" "), 1.5, "title");
    overlap(titleSet, c.definition, 0.5, "title");
    overlap(descSet, `${c.name} ${c.synonyms.join(" ")}`, 0.75, "description");
    // Merchant category is only a hint: it nudges the ranking but never creates a candidate.
    if (score > 0) for (const n of new Set(norms(c.path))) if (categorySet.has(n)) score += 0.75;
    if (score <= 0) continue;
    scored.push({
      conceptId: c.conceptId,
      stableKey: c.stableKey,
      path: c.path,
      name: c.name,
      definition: c.definition,
      score: Math.round(score * 100) / 100,
      matchedTerms: [...matched].slice(0, 8),
      exactAlias: !!span,
      evidence: evidence.slice(0, 2),
    });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, MAX_CANDIDATES);
}
