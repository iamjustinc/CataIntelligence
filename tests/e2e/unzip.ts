import { inflateRawSync } from "node:zlib";

/** Reads the entries of a ZIP produced by lib/export/zip.ts. */
export function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let o = 0;
  while (o + 30 <= buf.length && buf.readUInt32LE(o) === 0x04034b50) {
    const size = buf.readUInt32LE(o + 18);
    const nameLen = buf.readUInt16LE(o + 26);
    const name = buf.subarray(o + 30, o + 30 + nameLen).toString("utf8");
    out[name] = inflateRawSync(buf.subarray(o + 30 + nameLen, o + 30 + nameLen + size)).toString("utf8");
    o += 30 + nameLen + size;
  }
  return out;
}
