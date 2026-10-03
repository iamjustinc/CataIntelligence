export interface CsvRecord {
  /** 1-based source row number; the header is row 1. */
  row: number;
  cells: string[];
}

export interface ParsedCsv {
  header: string[];
  records: CsvRecord[];
}

export class CsvError extends Error {
  constructor(
    readonly code: "empty" | "unterminated_quote" | "invalid_encoding" | "too_large",
    message: string,
  ) {
    super(message);
  }
}

/** Decodes bytes as strict UTF-8. Invalid sequences are rejected rather than replaced. */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CsvError("invalid_encoding", "The file is not valid UTF-8. Re-export it as UTF-8 CSV.");
  }
}

/**
 * RFC 4180 style parser: quoted fields, doubled quotes, embedded newlines, CRLF or LF, optional
 * BOM. Fully blank lines are skipped but still counted so row numbers match the source file.
 */
export function parseCsv(text: string): ParsedCsv {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const all: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let row = 1;
  let sawAny = false;

  const endRecord = () => {
    cells.push(cell);
    if (cells.some((c) => c.trim() !== "")) all.push({ row, cells });
    cells = [];
    cell = "";
    row += 1;
    sawAny = false;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") {
      inQuotes = true;
      sawAny = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
      sawAny = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRecord();
    } else {
      cell += ch;
      sawAny = true;
    }
  }
  if (inQuotes) throw new CsvError("unterminated_quote", "The file has a quoted value that is never closed.");
  if (sawAny || cell !== "" || cells.length > 0) endRecord();
  if (all.length === 0) throw new CsvError("empty", "The file is empty.");

  const [head, ...records] = all;
  return { header: head.cells.map((h) => h.trim()), records };
}
