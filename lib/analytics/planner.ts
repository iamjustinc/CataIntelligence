/**
 * Question planning (PRD ANA02, ANA03, ANA05, ANA06).
 *
 * A planner turns a question into one of four outcomes: a validated AnalysisSpec, a focused
 * clarification, an explanation of why the request cannot be answered, or "not understood".
 * Planners never touch the database and never produce SQL. Deterministic guards run before any
 * planner, so a request to change data, read another workspace or run SQL is answered the same
 * way with or without a model.
 *
 * The demo planner is a rule-based phrase matcher, not AI. It accepts a question only when every
 * meaningful word was matched by a rule; anything else is refused rather than guessed.
 */
import { analysisSpecSchema, type AnalysisSpec } from "@/lib/contracts/analysis-spec";
import { DIMENSION_LABELS } from "./format";
import { METRICS, type DimensionId, type MappingState, type MetricId } from "./metric-registry";
import { dateRangeInterval, formatInstant, monthInterval, periodInterval, type Interval, type Period } from "./time";

export interface Vocabulary {
  timezone: string;
  merchants: { id: string; name: string }[];
  branches: { key: string; name: string }[];
}
export interface PlanInput {
  question: string;
  /** The last executed spec of the conversation; null for a new question. */
  previousSpec: AnalysisSpec | null;
  vocabulary: Vocabulary;
  now: Date;
}
export interface ClarifyOption {
  label: string;
  /** A ready interpretation the user can accept; null when they must supply a value (for example dates). */
  spec: AnalysisSpec | null;
}
export type PlanOutcome =
  | { kind: "spec"; spec: AnalysisSpec; notes: string[]; changes: string[] }
  | { kind: "clarify"; question: string; options: ClarifyOption[] }
  | { kind: "unsupported"; reason: "no_data" | "mutation" | "sql" | "history" | "workspace" | "combination"; message: string; links: { label: string; href: string }[] }
  | { kind: "not_understood"; message: string; unrecognized: string[] };

export interface PlannerUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  status: "ok" | "error" | "invalid";
  errorCode: string | null;
}
export interface Planner {
  id: "demo" | "live";
  modelId: string | null;
  promptVersion: string;
  plan(input: PlanInput): Promise<{ outcome: PlanOutcome; usage: PlannerUsage | null }>;
}

export function spec(metricId: MetricId, overrides: Partial<AnalysisSpec> = {}): AnalysisSpec {
  return { metricIds: [metricId], groupBy: [], filters: [], timeRange: null, scope: { population: "current_catalogs", mappingState: METRICS[metricId].mappingState ?? "published" }, sort: null, limit: 100, chartType: "table", needsClarification: false, clarificationQuestion: null, ...overrides };
}

// ---------------------------------------------------------------------------------------------
// Guards: identical for every planner
// ---------------------------------------------------------------------------------------------

const REVIEW_LINK = { label: "Open the review queue", href: "/review?state=unresolved" };

/** Requests no planner may interpret. Returns null when the question may go to a planner. */
export function guard(question: string): Extract<PlanOutcome, { kind: "unsupported" }> | null {
  const q = ` ${question.toLowerCase().replace(/\s+/g, " ")} `;
  if (/\b(select\s.+\sfrom|insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+(table|database)|truncate\s+table|union\s+select|run\s+(this\s+|the\s+|a\s+|raw\s+|arbitrary\s+)?(sql|query)|execute\s+(this\s+|the\s+|raw\s+)?(sql|query)|pg_\w+|information_schema)\b|;\s*--/.test(q)) {
    return { kind: "unsupported", reason: "sql", message: "Analytics does not run SQL. Questions are answered only through the registered metrics, dimensions and filters, and the query is built by the server.", links: [] };
  }
  if (/\b(another|other|different|all|every|any)\s+(workspaces?|tenants?|compan(y|ies)|organi[sz]ations?)\b|\bworkspace\s*(id)?\s*[=:]?\s*[0-9a-f]{8}-/.test(q)) {
    return { kind: "unsupported", reason: "workspace", message: "Analytics always uses the workspace you are signed in to. A question cannot select or combine other workspaces.", links: [] };
  }
  // Removing a filter from the current analysis is not a change to data.
  const withoutFilterEdits = q.replace(/\b(remove|clear|drop|delete|without)( the| all| any)?( merchant| branch| status| band)? filters?\b/g, " ");
  if (/\b(approve|reject|publish|unpublish|roll\s?back|delete|remove|deactivate|rename|re-?map|bulk[- ]approve)\b.*\b(everything|all|every|listings?|mappings?|items?|products?|release|concepts?|categor(y|ies)|merchant|them|those|these)\b|\b(create|add|make)\s+(a\s+|the\s+|new\s+)*(concept|category|release|synonym)\b|\bmap\s+(all|every|everything|these|those|them)\b/.test(withoutFilterEdits)) {
    return {
      kind: "unsupported",
      reason: "mutation",
      message: "Analytics only reads data. It cannot approve mappings, change the taxonomy or publish a release. Those actions stay with reviewers and administrators on their own screens, one decision at a time.",
      links: [REVIEW_LINK, { label: "Open releases", href: "/releases" }],
    };
  }
  if (/\b(revenue|gmv|sales?|sold|sells?|selling|best[- ]sell\w*|earn(s|ed|ings?)?|profit\w*|margin|turnover|engagement|clicks?|views?|conversions?|demand|popular\w*|orders?|purchases?|transactions?)\b/.test(q)) {
    return {
      kind: "unsupported",
      reason: "no_data",
      message: "This workspace holds catalog listings, review decisions and mapping releases. It has no transaction, revenue or engagement data, so this cannot be answered, and it will not be estimated from prices or listing counts.",
      links: [],
    };
  }
  if (/\b(compared?\s+(with|to)|versus|vs\.?|than|change[ds]?\s+(since|from)|since)\s+(last|previous|the\s+previous|yesterday|a\s+(week|month)\s+ago)\b|\b(week[- ]over[- ]week|month[- ]over[- ]month|trend\s+in\s+coverage|coverage\s+(trend|history|over\s+time)|historical\s+coverage)\b/.test(q)) {
    return {
      kind: "unsupported",
      reason: "history",
      message: "This comparison is unavailable. Coverage, pending and listing counts are as-of counts of the current catalogs; past values were not recorded, and they are not reconstructed from current data. Review activity is recorded by date and can be shown by day or week.",
      links: [],
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Demo planner: rule-based phrase matching
// ---------------------------------------------------------------------------------------------

export const DEMO_PLANNER_VERSION = "demo-rules-v1";

export const DEMO_EXAMPLES = [
  "Which merchant has the lowest published coverage?",
  "How many listings are pending review by merchant?",
  "How many listings were reviewed last week by day?",
  "How many active listings by decision status?",
  "What is the median review time?",
  "How many ambiguous listings by signal band?",
] as const;

const STOPWORDS = new Set(
  "a an the is are was were has have had do does did what whats which who how many much me show give tell list of in on at for to by with our my we us there their its it that this these those currently current now right total overall number count counts please and or across all each per listings listing products product items item skus sku catalog catalogs merchants merchant rate percentage percent share mapping mappings been be get see can i you need needs during over from between within any so far yet still review reviews analysis analyses time s as chart table bar line graph plot display view breakdown break down split grouped group one ones per-merchant active valid including include".split(" "),
);
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const FOLLOW_UP_LEAD = /^\s*(what about|how about|and |now |same |also |instead|only |just |but |then |switch|change|make it|narrow|filter|limit|exclude|remove|drop|break|group|split|show (it|that|this|them)|sort|order|as a )/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalize = (s: string) => ` ${s.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9%&\-]+/g, " ").trim()} `;

class Text {
  private rest: string;
  constructor(question: string) {
    this.rest = normalize(question);
  }
  /** Consumes the first match and returns it. */
  take(re: RegExp): RegExpExecArray | null {
    const match = re.exec(this.rest);
    if (match) this.rest = this.rest.slice(0, match.index) + " ".repeat(match[0].length) + this.rest.slice(match.index + match[0].length);
    return match;
  }
  leftovers(): string[] {
    return this.rest.split(" ").filter((t) => t && !STOPWORDS.has(t) && !/^-+$/.test(t));
  }
}

interface Parsed {
  metric: MetricId | "coverage" | null;
  merchants: string[];
  allMerchants: boolean;
  branches: string[];
  unmappedBranch: boolean;
  clearFilters: boolean;
  scope: MappingState | null;
  groupBy: DimensionId | null;
  time: { interval: Interval; label: string } | "all" | null;
  timeClarify: string | null;
  sort: "asc" | "desc" | null;
  limit: number | null;
  chartType: AnalysisSpec["chartType"] | null;
  status: string[];
  bands: string[];
  leftovers: string[];
}

function parse(question: string, vocab: Vocabulary, now: Date): Parsed {
  const t = new Text(question);
  const p: Parsed = { metric: null, merchants: [], allMerchants: false, branches: [], unmappedBranch: false, clearFilters: false, scope: null, groupBy: null, time: null, timeClarify: null, sort: null, limit: null, chartType: null, status: [], bands: [], leftovers: [] };

  // Longest names first so "Harbor Market East" is not read as "Harbor Market".
  for (const m of [...vocab.merchants].sort((a, b) => b.name.length - a.name.length)) if (t.take(new RegExp(`\\b${escapeRe(normalize(m.name).trim())}\\b`))) p.merchants.push(m.id);
  for (const b of [...vocab.branches].sort((a, b) => b.name.length - a.name.length)) if (t.take(new RegExp(`\\b${escapeRe(normalize(b.name).trim())}\\b`))) p.branches.push(b.key);
  if (t.take(/\b(remove|clear|drop|without)( the| all| any)? filters?\b/)) p.clearFilters = true;
  if (t.take(/\b(all|every|any) merchants?\b/)) p.allMerchants = true;

  // Time
  const between = t.take(/\b(?:between|from) (\d{4}-\d{2}-\d{2}) (?:and|to|until|through) (\d{4}-\d{2}-\d{2})\b/);
  const periods: [RegExp, Period][] = [
    [/\b(last|past|previous) (7|seven) days\b|\bpast week\b/, "last_7_days"],
    [/\b(last|past|previous) (30|thirty) days\b|\bpast month\b/, "last_30_days"],
    [/\b(last|previous) week\b/, "last_week"],
    [/\bthis week\b/, "this_week"],
    [/\b(last|previous) month\b/, "last_month"],
    [/\bthis month\b/, "this_month"],
    [/\byesterday\b/, "yesterday"],
    [/\btoday\b/, "today"],
  ];
  if (between) {
    const interval = dateRangeInterval(between[1], between[2], vocab.timezone);
    if (interval) p.time = { interval, label: `${between[1]} to ${between[2]}` };
    else p.timeClarify = "Those dates are not a valid range. Which start and end dates do you mean (YYYY-MM-DD)?";
  }
  for (const [re, period] of periods) {
    if (!p.time && !p.timeClarify) {
      const match = t.take(re);
      if (match) p.time = { interval: periodInterval(period, now, vocab.timezone), label: match[0].trim() };
    }
  }
  const month = t.take(new RegExp(`\\b(${MONTHS.join("|")})(?: (\\d{4}))?\\b`));
  if (month && !p.time) {
    if (month[2]) p.time = { interval: monthInterval(+month[2], MONTHS.indexOf(month[1]) + 1, vocab.timezone), label: `${month[1]} ${month[2]}` };
    else p.timeClarify = `Which year do you mean for ${month[1][0].toUpperCase()}${month[1].slice(1)}?`;
  }
  const vague = t.take(/\b(summer|winter|spring|autumn|fall|q[1-4]|(this|last|next) (quarter|year|season)|recently|lately|holiday season)\b/);
  if (vague && !p.time) p.timeClarify = `"${vague[0].trim()}" has no fixed dates here. Which start and end dates (and year) do you mean?`;
  if (t.take(/\b(all time|ever|so far|to date|in total)\b/)) p.time = p.time ?? "all";

  // Grouping
  const groups: [RegExp, DimensionId][] = [
    [/\b(by|per|for each|each|across|compare|between) merchants?\b|\bwhich merchants?\b|\bmerchant comparison\b|\bmerchants (by|with|ranked by)\b/, "merchant"],
    [/\b(by|per) (decision |review |workflow )?(status|state)(es)?\b/, "decision_status"],
    [/\b(by|per) signal( band)?s?\b|\bby band\b/, "signal_band"],
    [/\b(by|per|for each|each|which) (canonical |top-level )?(branch|category|categories|domain|department)s?\b/, "canonical_branch"],
    [/\b(by|per|each) day\b|\bdaily\b/, "utc_day"],
    [/\b(by|per|each) week\b|\bweekly\b/, "utc_week"],
  ];
  for (const [re, dim] of groups) if (t.take(re) && !p.groupBy) p.groupBy = dim;
  if (t.take(/\bunmapped\b/)) p.unmappedBranch = true;

  // Metric (most specific first)
  const metrics: [RegExp, Parsed["metric"]][] = [
    [/\bmedian( review)?( time| duration| seconds)?\b|\bhow long (does|do|did) (a |an |each )?reviews? take\b|\b(review time|time per review|time to review)\b/, "median_review_seconds"],
    [/\b(were|was|got|been|have been) reviewed\b|\breviewed( listing)?( count)?\b|\breviews? (completed|done|recorded)\b|\b(review completions|completed reviews|review activity|review throughput)\b/, "reviewed_listing_count"],
    [/\b(failed|failing)( analys[ie]s)?( count)?\b|\banalysis (failures?|errors?)\b|\bprovider (failures?|errors?)\b|\bfailures?\b/, "failed_analysis_count"],
    [/\b(ambiguous|ambiguity|ambiguities)( count)?\b/, "ambiguous_count"],
    [/\bpending( review)?( count)?\b|\b(backlog|unresolved|unreviewed|outstanding)\b|\b(left|remaining|waiting)( to (be )?review(ed)?)?\b|\bnot (yet )?approved\b|\bstill needs? review\b/, "pending_review_count"],
    [/\b(mapping )?coverage\b|\bcovered\b|\b(percent|percentage|share|proportion|rate) (of (listings |products |items )?)?mapped\b|\bmapped\b/, "coverage"],
    [/\b(how many|number of|count of|total)( active)?( listings| products| items| skus)\b|\b(active )?listings? counts?\b|\bhow (big|large)\b|\bcatalog size\b/, "listing_count"],
  ];
  for (const [re, metric] of metrics) {
    if (!p.metric) {
      if (t.take(re)) p.metric = metric;
    }
  }
  // Mapping scope, after metrics so "not yet approved" is read as pending rather than as draft scope.
  if (t.take(/\b(approved )?draft\b|\bapproved\b(?! by)/)) p.scope = "draft";
  if (t.take(/\bpublished\b|\breleased\b|\bin (the )?(current )?releases?\b/)) p.scope = p.scope ?? "published";
  // Decision status and signal band values, as filters
  const statuses: [RegExp, string][] = [[/\bdeferred\b/, "deferred"], [/\bstale\b/, "stale"], [/\bsuggested\b/, "suggested"], [/\bneeds? investigation\b/, "needs_investigation"], [/\bno suitable (category|concept)\b/, "no_suitable_category"], [/\bneeds? analysis\b|\bunanaly[sz]ed\b/, "needs_analysis"]];
  for (const [re, value] of statuses) if (t.take(re)) p.status.push(value);
  const bands: [RegExp, string][] = [[/\bhigh signal\b/, "high"], [/\bmedium signal\b/, "medium"], [/\blow signal\b/, "low"]];
  for (const [re, value] of bands) if (t.take(re)) p.bands.push(value);
  // "How many deferred listings": a count of listings narrowed by the status or band just named.
  if (!p.metric && (p.status.length || p.bands.length) && t.take(/\b(how many|number of|count of)\b/)) p.metric = "listing_count";

  // Sort, limit, chart
  const top = t.take(/\b(top|first|bottom|worst|best) (\d{1,3})\b/);
  if (top) {
    p.limit = Math.min(Math.max(+top[2], 1), 1000);
    p.sort = /bottom|worst/.test(top[1]) ? "asc" : "desc";
  }
  if (t.take(/\b(lowest|least|worst|fewest|smallest|bottom|weakest|ascending|behind)\b/)) p.sort = p.sort ?? "asc";
  if (t.take(/\b(highest|most|best|largest|biggest|top|strongest|descending|ahead|leading)\b/)) p.sort = p.sort ?? "desc";
  if (t.take(/\b(as|in) a table\b|\btable only\b/)) p.chartType = "table";
  if (t.take(/\b(bar chart|bars|as a bar)\b/)) p.chartType = "bar";
  if (t.take(/\b(line chart|as a line|over time|trend)\b/)) p.chartType = "line";
  t.take(/\b(only|just|instead|what about|how about|same|also|but|then|switch to|change to|make it|narrow to|filter to|limit to|sorted?|order(ed)?|compare|comparison|versus|vs|have the|has the|with the)\b/);
  while (t.take(/\b(only|just|instead|also|sorted?|ordered?)\b/));
  p.leftovers = t.leftovers();
  return p;
}

const filterOf = (dimension: AnalysisSpec["filters"][number]["dimension"], values: string[]): AnalysisSpec["filters"][number] => ({ dimension, operator: values.length === 1 ? "eq" : "in", values });
const coverageMetric = (scope: MappingState): MetricId => (scope === "published" ? "published_mapping_coverage" : "approved_draft_coverage");
const isCoverage = (id: MetricId) => id === "published_mapping_coverage" || id === "approved_draft_coverage";

function finish(candidate: AnalysisSpec, notes: string[], changes: string[]): PlanOutcome {
  const parsed = analysisSpecSchema.safeParse(candidate);
  if (!parsed.success) return { kind: "unsupported", reason: "combination", message: `${parsed.error.issues[0].message} Choose a different grouping or metric.`, links: [] };
  return { kind: "spec", spec: parsed.data, notes, changes };
}

/** Rule-based interpretation. Exported for tests and the benchmark. */
export function planWithRules({ question, previousSpec, vocabulary, now }: PlanInput): PlanOutcome {
  const blocked = guard(question);
  if (blocked) return blocked;
  const p = parse(question, vocabulary, now);
  const names = (dimension: string, values: string[]) => values.map((v) => (dimension === "merchant" ? vocabulary.merchants.find((m) => m.id === v)?.name : dimension === "canonical_branch" ? (vocabulary.branches.find((b) => b.key === v)?.name ?? v) : v)).join(", ");
  // ANA03: "improvement" needs a baseline, and past values of as-of counts were never recorded.
  if (/\b(improv\w*|better|worse|worsen\w*|progress\w*|declin\w*|grow\w*|increas\w*|decreas\w*)\b/.test(question.toLowerCase())) {
    return {
      kind: "clarify",
      question: "Compared with what? Coverage and backlog are as-of counts: their past values were not recorded, so a change over time cannot be shown. Review activity is recorded by date. Which of these would help?",
      options: [
        { label: "Reviewed listings by week", spec: spec("reviewed_listing_count", { groupBy: ["utc_week"], chartType: "line" }) },
        { label: "Published coverage by merchant, as of now", spec: spec("published_mapping_coverage", { groupBy: ["merchant"], chartType: "bar" }) },
        { label: "Approved draft coverage by merchant, as of now", spec: spec("approved_draft_coverage", { groupBy: ["merchant"], chartType: "bar" }) },
      ],
    };
  }
  if (p.leftovers.length > 0) {
    return {
      kind: "not_understood",
      unrecognized: p.leftovers,
      message: `The demo planner matches a fixed set of phrases and could not account for: ${p.leftovers.map((w) => `"${w}"`).join(", ")}. It does not guess. Rephrase using the metric names, build the analysis with the controls below, or ask an administrator to enable live AI.`,
    };
  }
  const modifiers = p.merchants.length || p.branches.length || p.unmappedBranch || p.allMerchants || p.clearFilters || p.scope || p.groupBy || p.time || p.timeClarify || p.sort || p.limit || p.chartType || p.status.length || p.bands.length;
  const followUp = !!previousSpec && (p.metric === null || FOLLOW_UP_LEAD.test(question.toLowerCase()));
  if (p.metric === null && !followUp) {
    return { kind: "not_understood", unrecognized: [], message: modifiers ? "Which metric do you mean? For example: active listings, published coverage, approved draft coverage, pending review, ambiguous listings, failed analyses, reviewed listings or median review time." : "The demo planner did not recognise a metric in this question. Try one of the examples, or build the analysis with the controls below." };
  }
  if (p.metric === null && !modifiers) return { kind: "not_understood", unrecognized: [], message: "Nothing in this follow-up changes the current analysis. Name a merchant, branch, grouping, period or metric." };

  const base: AnalysisSpec | null = followUp ? structuredClone(previousSpec) : null;
  const changes: string[] = [];
  const notes: string[] = [];
  const branchValues = [...p.branches, ...(p.unmappedBranch && p.metric !== "coverage" ? ["Unmapped"] : [])];

  // Resolve the metric.
  let metricId: MetricId;
  let scope: MappingState | null = p.scope;
  if (p.metric === "coverage" || (p.metric === null && base && isCoverage(base.metricIds[0]))) {
    if (p.groupBy === "canonical_branch" || (p.metric === "coverage" && p.unmappedBranch && p.groupBy === null && branchValues.length === 0 && /categor|branch|domain/.test(question.toLowerCase()))) {
      // AT22: coverage by category has no meaningful denominator.
      const option = (mappingState: MappingState): ClarifyOption => ({ label: `Listings by canonical branch, ${mappingState} mappings (with an Unmapped bucket)`, spec: spec("listing_count", { groupBy: ["canonical_branch"], scope: { population: "current_catalogs", mappingState }, chartType: "bar" }) });
      return {
        kind: "clarify",
        question: "Coverage cannot be broken down by canonical category: an unmapped listing has no category, so every category would show only its already-mapped listings and look fully covered. I can show how many listings sit in each branch, with unmapped listings in their own bucket. Which mappings should that use?",
        options: scope ? [option(scope)] : [option("published"), option("draft")],
      };
    }
    scope = scope ?? (p.metric === null && base ? base.scope.mappingState : null);
    if (!scope) {
      const rest = { groupBy: p.groupBy ? [p.groupBy] : [], filters: [...(p.merchants.length ? [filterOf("merchant", p.merchants)] : []), ...(branchValues.length ? [filterOf("canonical_branch", branchValues)] : [])], chartType: p.groupBy ? ("bar" as const) : ("table" as const) };
      const option = (mappingState: MappingState, label: string): ClarifyOption => {
        const id = coverageMetric(mappingState);
        const candidate = spec(id, { ...rest, sort: p.sort ? { field: id, direction: p.sort } : null, limit: p.limit ?? 100 });
        return { label, spec: analysisSpecSchema.safeParse(candidate).success ? candidate : null };
      };
      return {
        kind: "clarify",
        question: "Which coverage do you mean?",
        options: [option("published", "Published coverage: mapped in each merchant's current release"), option("draft", "Approved draft coverage: approved by a reviewer, published or not")],
      };
    }
    metricId = coverageMetric(scope);
  } else if (p.metric) {
    metricId = p.metric;
  } else {
    metricId = base!.metricIds[0];
  }
  const def = METRICS[metricId];

  if (p.timeClarify) return { kind: "clarify", question: p.timeClarify, options: [] };
  if (p.time && def.family === "snapshot") {
    return {
      kind: "unsupported",
      reason: "history",
      message: `${def.label} is an as-of count of the current catalogs, so it has no time range; past values were not recorded. Review activity (reviewed listings, median review time) can be filtered by date.`,
      links: [],
    };
  }

  let next: AnalysisSpec;
  if (base) {
    next = base;
    if (metricId !== base.metricIds[0]) {
      changes.push(`Metric changed from ${METRICS[base.metricIds[0]].label} to ${def.label}`);
      // A sort on the old metric follows the new one; any other sort is dropped with the grouping below.
      next.sort = next.sort && next.sort.field === base.metricIds[0] ? { field: metricId, direction: next.sort.direction } : next.sort;
      next.metricIds = [metricId];
      const keptGroups = next.groupBy.filter((d) => def.dimensions.includes(d));
      for (const d of next.groupBy) if (!keptGroups.includes(d)) changes.push(`Removed grouping by ${DIMENSION_LABELS[d].toLowerCase()}: not available for ${def.label}`);
      next.groupBy = keptGroups;
      const keptFilters = next.filters.filter((f) => def.filters.includes(f.dimension));
      for (const f of next.filters) if (!keptFilters.includes(f)) changes.push(`Removed the ${DIMENSION_LABELS[f.dimension].toLowerCase()} filter: not available for ${def.label}`);
      next.filters = keptFilters;
      if (def.family === "snapshot" && next.timeRange) {
        next.timeRange = null;
        changes.push("Removed the period: this metric is an as-of count");
      }
      if (def.mappingState) next.scope.mappingState = def.mappingState;
    }
    if (p.scope && p.scope !== next.scope.mappingState) {
      if (def.mappingState && def.mappingState !== p.scope) return { kind: "unsupported", reason: "combination", message: `${def.label} is defined on ${def.mappingState} mappings and cannot use ${p.scope} scope.`, links: [] };
      next.scope.mappingState = p.scope;
      changes.push(`Mapping scope changed to ${p.scope}`);
    }
  } else {
    next = spec(metricId);
    if (scope && !def.mappingState) next.scope.mappingState = scope;
  }

  const setFilter = (dimension: AnalysisSpec["filters"][number]["dimension"], values: string[]) => {
    const had = next.filters.find((f) => f.dimension === dimension);
    next.filters = [...next.filters.filter((f) => f.dimension !== dimension), filterOf(dimension, values)];
    if (base) changes.push(`${DIMENSION_LABELS[dimension]} filter ${had ? `changed from ${names(dimension, had.values)} to` : "added:"} ${names(dimension, values)}`);
  };
  if (p.clearFilters && next.filters.length) {
    next.filters = [];
    changes.push("Removed all filters");
  }
  if (p.allMerchants && next.filters.some((f) => f.dimension === "merchant")) {
    next.filters = next.filters.filter((f) => f.dimension !== "merchant");
    changes.push("Removed the merchant filter");
  }
  if (p.merchants.length) setFilter("merchant", p.merchants);
  if (branchValues.length) setFilter("canonical_branch", branchValues);
  if (p.status.length) setFilter("decision_status", p.status);
  if (p.bands.length) setFilter("signal_band", p.bands);
  if (p.groupBy && !(next.groupBy.length === 1 && next.groupBy[0] === p.groupBy)) {
    if (base) changes.push(`Grouping changed to ${DIMENSION_LABELS[p.groupBy].toLowerCase()}`);
    next.groupBy = [p.groupBy];
    if (next.sort && !next.metricIds.includes(next.sort.field as MetricId)) next.sort = null;
  }
  if (p.time) {
    next.timeRange = p.time === "all" ? null : p.time.interval;
    if (base) changes.push(p.time === "all" ? "Period removed: all recorded activity" : `Period changed to ${p.time.label}`);
    if (p.time !== "all") notes.push(`"${p.time.label}" was read in the workspace timezone (${vocabulary.timezone}): ${formatInstant(p.time.interval.start, vocabulary.timezone)} up to, not including, ${formatInstant(p.time.interval.end, vocabulary.timezone)}.`);
  } else if (!base && def.family === "activity") {
    notes.push("No period was named, so all recorded review activity is included.");
  }
  if (p.sort) {
    next.sort = { field: metricId, direction: p.sort };
    if (base) changes.push(`Sorted by ${def.label}, ${p.sort === "asc" ? "lowest" : "highest"} first`);
  }
  if (p.limit) {
    next.limit = p.limit;
    if (base) changes.push(`Limited to ${p.limit} rows`);
  }
  const time = next.groupBy.find((d) => d.startsWith("utc_"));
  if (p.chartType) {
    if (base && next.chartType !== p.chartType) changes.push(`Shown as a ${p.chartType === "table" ? "table" : `${p.chartType} chart`}`);
    next.chartType = p.chartType === "line" && !time ? (next.groupBy.length ? "bar" : "table") : p.chartType;
  } else {
    next.chartType = time ? "line" : next.groupBy.length ? "bar" : "table";
  }
  if (time) notes.push("Days and weeks are grouped in UTC; weeks start on Monday.");

  // A branch filter or grouping needs a stated mapping scope when the metric does not imply one.
  const usesBranch = next.groupBy.includes("canonical_branch") || next.filters.some((f) => f.dimension === "canonical_branch");
  if (usesBranch && !def.mappingState && !scope && !base) {
    const option = (mappingState: MappingState): ClarifyOption => ({ label: mappingState === "published" ? "Published mappings (current releases)" : "Draft mappings (reviewer-approved, published or not)", spec: { ...next, scope: { population: "current_catalogs", mappingState } } });
    return { kind: "clarify", question: "A canonical branch comes from a mapping. Should the branch be taken from published mappings or from draft approvals?", options: [option("published"), option("draft")] };
  }
  if (base && changes.length === 0) return { kind: "not_understood", unrecognized: [], message: "This follow-up does not change the current analysis." };
  return finish(next, notes, changes);
}

export class DemoPlanner implements Planner {
  readonly id = "demo" as const;
  readonly modelId = null;
  readonly promptVersion = DEMO_PLANNER_VERSION;
  async plan(input: PlanInput) {
    return { outcome: planWithRules(input), usage: null };
  }
}
