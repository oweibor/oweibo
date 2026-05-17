// Minimal DLP re-check — same patterns as core-engine's LessonDLPFilter.
// Kept as a separate copy so the aggregator has no dep on core-engine.

const PATTERNS: RegExp[] = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /(?:^|\s)\/(?:[a-zA-Z0-9._\-]+\/)+[a-zA-Z0-9._\-]+/,
  /\b[0-9a-f]{40}\b/i,
  /[A-Za-z0-9+/]{32,}={0,2}/,
  /https?:\/\/[^\s"'<>]{4,}/,
];

export function applyDLPFilter(text: string): { pass: boolean; rejections: string[] } {
  const rejections: string[] = [];
  PATTERNS.forEach((re, i) => { if (re.test(text)) rejections.push(`pattern:${i}`); });
  return { pass: rejections.length === 0, rejections };
}
