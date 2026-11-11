/**
 * Reads a JSON request body without trusting its size. The app's own requests are small; a
 * reverse proxy usually caps bodies too (see deploy/nginx.conf.example), but the app must not
 * depend on one being there: an unbounded `request.json()` would buffer whatever is sent.
 *
 * Returns null for a body that is missing, too large or not JSON.
 */
export async function readJson(request: Request, maxBytes = 32_000): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
