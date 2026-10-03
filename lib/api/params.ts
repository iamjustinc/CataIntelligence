import { z } from "zod";
import { notFound } from "./errors";

/** A malformed ID cannot name an accessible resource, so it is reported exactly like a missing one. */
export function uuidParam(value: string | undefined, what: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw notFound(what);
  return parsed.data;
}
