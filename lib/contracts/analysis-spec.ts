import { z } from "zod";
import { DIMENSIONS, METRIC_IDS, METRICS, metricSupportsDimension } from "@/lib/analytics/metric-registry";

/**
 * AnalysisSpec (PRD 13.4). The model may only produce this structure; the server validates it
 * against the metric registry and compiles the query itself. Workspace and permissions are never
 * part of the spec: the server adds them from the session.
 */
const filterSchema = z.strictObject({
  dimension: z.enum(["merchant", "canonical_branch", "decision_status", "signal_band"]),
  operator: z.enum(["eq", "in"]),
  values: z.array(z.string().min(1).max(200)).min(1).max(50),
});

export const analysisSpecSchema = z
  .strictObject({
    metricIds: z.array(z.enum(METRIC_IDS)).min(1).max(4),
    groupBy: z.array(z.enum(DIMENSIONS)).max(2),
    filters: z.array(filterSchema).max(8),
    // Half-open interval [start, end) in UTC.
    timeRange: z.strictObject({ start: z.iso.datetime(), end: z.iso.datetime() }).nullable(),
    scope: z.strictObject({
      population: z.literal("current_catalogs"),
      mappingState: z.enum(["published", "draft"]),
    }),
    sort: z.strictObject({ field: z.string().min(1).max(64), direction: z.enum(["asc", "desc"]) }).nullable(),
    limit: z.number().int().min(1).max(1000),
    chartType: z.enum(["bar", "line", "table"]),
    needsClarification: z.boolean(),
    clarificationQuestion: z.string().max(500).nullable(),
  })
  .superRefine((spec, ctx) => {
    if (spec.needsClarification !== (spec.clarificationQuestion !== null)) {
      ctx.addIssue({ code: "custom", path: ["clarificationQuestion"], message: "A clarification question is required exactly when needsClarification is true." });
    }
    for (const metricId of spec.metricIds) {
      const metric = METRICS[metricId];
      for (const dimension of spec.groupBy) {
        if (!metricSupportsDimension(metricId, dimension)) {
          ctx.addIssue({ code: "custom", path: ["groupBy"], message: `${metric.label} cannot be grouped by ${dimension}.` });
        }
      }
      if (metric.mappingState && metric.mappingState !== spec.scope.mappingState) {
        ctx.addIssue({ code: "custom", path: ["scope", "mappingState"], message: `${metric.label} requires ${metric.mappingState} scope.` });
      }
      if (spec.timeRange && !metric.timestamp) {
        ctx.addIssue({ code: "custom", path: ["timeRange"], message: `${metric.label} is an as-of count and does not accept a time range.` });
      }
    }
    if (spec.timeRange && spec.timeRange.start >= spec.timeRange.end) {
      ctx.addIssue({ code: "custom", path: ["timeRange"], message: "timeRange.start must be before timeRange.end." });
    }
    const sortable = new Set<string>([...spec.metricIds, ...spec.groupBy]);
    if (spec.sort && !sortable.has(spec.sort.field)) {
      ctx.addIssue({ code: "custom", path: ["sort", "field"], message: "Sort field must be a selected metric or dimension." });
    }
  });

export type AnalysisSpec = z.infer<typeof analysisSpecSchema>;
