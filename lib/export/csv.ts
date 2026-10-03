/**
 * Spreadsheet-safe CSV (PRD TAX13, AT25). A cell that a spreadsheet would treat as a formula is
 * prefixed with an apostrophe in the export only; the database keeps the raw value.
 */
const FORMULA = /^[=+\-@\t\r]/;

export function safeCell(value: string | number | null | undefined): string {
  let v = value === null || value === undefined ? "" : String(value);
  if (typeof value === "string" && FORMULA.test(v)) v = `'${v}`;
  return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

export function toSafeCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  return [header, ...rows].map((r) => r.map(safeCell).join(",")).join("\r\n") + "\r\n";
}
