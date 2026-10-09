/**
 * Input validation for annotations (HTTP API boundary and the session file on disk).
 * Every string and array is bounded so one note cannot bloat the session file, the
 * agent's context or the Markdown bundle.
 */
import { z } from "zod";
import type { Annotation } from "../shared/types";
import { INTENTS } from "../shared/types";

export const LIMITS = {
  /** Request body for any /__sumi/api route. */
  bodyBytes: 64 * 1024,
  /** Annotations kept per session. */
  annotations: 500,
  note: 4096,
  reply: 4096,
  html: 2048,
  short: 512,
  url: 4096,
  idList: 500,
  regionElements: 24,
  strokePoints: 5000,
  classes: 64,
  components: 32,
  record: 48,
} as const;

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const STATUSES = ["draft", "sent", "needs-input", "resolved"] as const;

const id = z.string().regex(ID_RE, "must be 1-64 characters of A-Z, a-z, 0-9, _ or -");
const num = z.number().finite();
const short = z.string().max(LIMITS.short);
const tiny = z.string().max(128);
const time = z.string().max(64);

const rect = z.object({ x: num, y: num, width: num, height: num });

const record = z
  .record(z.string().max(128), z.string().max(LIMITS.short))
  .refine((r) => Object.keys(r).length <= LIMITS.record, `at most ${LIMITS.record} entries`);

export const elementSchema = z.object({
  selector: short,
  tag: tiny,
  id: short.optional(),
  classes: z.array(z.string().max(256)).max(LIMITS.classes).default([]),
  role: tiny.optional(),
  name: short.optional(),
  text: short.optional(),
  html: z.string().max(LIMITS.html).default(""),
  rect,
  styles: record.default({}),
  attributes: record.default({}),
  components: z.array(z.string().max(256)).max(LIMITS.components).optional(),
  source: short.optional(),
  landmark: short.optional(),
  framework: z.enum(["react", "vue", "svelte", "html", "unknown"]).optional(),
});

const regionSchema = z.object({
  rect,
  tool: z.enum(["marquee", "brush"]).optional(),
  stroke: z
    .object({
      points: z.array(z.object({ x: num, y: num })).max(LIMITS.strokePoints),
      size: num,
    })
    .optional(),
  elements: z.array(elementSchema).max(LIMITS.regionElements).default([]),
  container: elementSchema.optional(),
});

const pageSchema = z.object({
  url: z.string().max(LIMITS.url).default(""),
  path: z.string().max(LIMITS.url).default("/"),
  title: short.default(""),
  viewport: z.object({ width: num, height: num }).default({ width: 0, height: 0 }),
});

export const annotationSchema = z
  .object({
    id,
    n: z.number().int().min(0).max(1_000_000).default(0),
    kind: z.enum(["element", "region"]),
    intent: z.enum(INTENTS as [string, ...string[]]).default("other"),
    note: z.string().max(LIMITS.note).default(""),
    status: z.enum(STATUSES).default("draft"),
    createdAt: time.default(() => new Date().toISOString()),
    sentAt: time.optional(),
    resolvedAt: time.optional(),
    reply: z.string().max(LIMITS.reply).optional(),
    answer: z.string().max(LIMITS.reply).optional(),
    page: pageSchema.default({}),
    target: elementSchema.optional(),
    region: regionSchema.optional(),
  })
  .superRefine((a, ctx) => {
    if (a.kind === "region" && !a.region) ctx.addIssue({ code: "custom", path: ["region"], message: "required when kind is region" });
  });

export const idsSchema = z.array(id).max(LIMITS.idList);

/** One readable line describing the first few problems. */
export function describe(err: z.ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

export type ParseResult = { ok: true; value: Annotation } | { ok: false; error: string };

export function parseAnnotation(input: unknown): ParseResult {
  const r = annotationSchema.safeParse(input);
  return r.success ? { ok: true, value: r.data as Annotation } : { ok: false, error: describe(r.error) };
}

/**
 * Session-file loading: validate, and when that fails try once more after trimming every
 * over-long string and over-long array (older versions did not cap them). Returns null when the
 * item cannot be repaired.
 */
export function repairAnnotation(input: unknown): { value: Annotation; repaired: boolean } | { error: string } {
  const first = parseAnnotation(input);
  if (first.ok) return { value: first.value, repaired: false };
  const second = parseAnnotation(trimDeep(input, 0));
  if (second.ok) return { value: second.value, repaired: true };
  return { error: second.error };
}

function trimDeep(v: unknown, depth: number): unknown {
  if (depth > 8) return undefined;
  if (typeof v === "string") return v.length > LIMITS.short ? v.slice(0, LIMITS.short) : v;
  if (Array.isArray(v)) return v.slice(0, LIMITS.regionElements).map((x) => trimDeep(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, LIMITS.record)) {
      // Long free text keeps its own (larger) limit.
      if ((k === "note" || k === "reply" || k === "answer") && typeof x === "string") out[k] = x.slice(0, LIMITS.note);
      else if (k === "html" && typeof x === "string") out[k] = x.slice(0, LIMITS.html);
      else if ((k === "url" || k === "path") && typeof x === "string") out[k] = x.slice(0, LIMITS.url);
      else if (k === "points" && Array.isArray(x)) out[k] = x.slice(0, LIMITS.strokePoints);
      else out[k] = trimDeep(x, depth + 1);
    }
    return out;
  }
  return v;
}
