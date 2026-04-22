export function sanitizePlanSlug(raw: string): string {
  const lower = raw.toLowerCase().trim();
  const cleaned = lower
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned;
}
