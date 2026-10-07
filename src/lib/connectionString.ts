/** Force Supabase session pooler (5432) — transaction mode breaks parameterized queries. */
export function getConnectionString(rawUrl: string): string {
  if (!rawUrl) throw new Error("Database URL is not set");
  if (rawUrl.includes("pooler.supabase.com") && rawUrl.includes(":6543/")) {
    return rawUrl.replace(":6543/", ":5432/");
  }
  return rawUrl;
}
