/**
 * Server-action fetch wrapper that throws on non-2xx instead of silently
 * redirecting on failure. The naked `await fetch(...)` followed by
 * `redirect(...)` pattern (flagged across F.7 review) hid backend
 * validation/auth failures from users -- they saw a successful
 * navigation on a request that had actually 4xx'd. Throwing surfaces
 * the failure to Next.js's error boundary so the operator sees the
 * problem.
 */
export async function fetchOrThrow(
  label: string,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} failed: ${res.status}${body ? ` ${body.slice(0, 256)}` : ''}`);
  }
  return res;
}
