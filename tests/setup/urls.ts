/** Tests always run against a dedicated `<database>_test` database, never the development one. */
export function testUrl(raw: string | undefined): string {
  if (!raw) return "";
  const url = new URL(raw);
  if (!url.pathname.endsWith("_test")) url.pathname = `${url.pathname}_test`;
  return url.toString();
}
