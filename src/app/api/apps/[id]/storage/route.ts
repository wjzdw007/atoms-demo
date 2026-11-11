import { getOrCreateUser, getUser, GuestLimitError, jsonError } from "@/lib/auth";
import { config } from "@/lib/config";
import { queryOne, run } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

/**
 * Key-value storage for a generated app, one private copy per (app, signed-in user).
 * The app's own code never calls this: it runs in a sandbox without credentials. The host page
 * relays the app's localStorage through here, so the user id always comes from the session cookie
 * and an app cannot read or write another user's data.
 */
async function authorize({ params }: Params, createGuest = false) {
  const { id } = await params;
  const project = await queryOne<{ user_id: string; published_slug: string | null }>(
    "SELECT user_id, published_slug FROM projects WHERE id = ?",
    [id],
  );
  let user = await getUser();
  if (!user && createGuest && project?.published_slug) {
    // Someone opened a shared app without ever using the site. Give them a guest identity on
    // their first save, so their data is kept in the cloud like everyone else's.
    try {
      user = await getOrCreateUser();
    } catch (error) {
      if (!(error instanceof GuestLimitError)) throw error;
    }
  }
  if (!user) return { error: jsonError("未登录，数据仅保存在本机", 401) };
  // Owners can use their own apps; anyone can use a published app (with their own data).
  if (!project || (project.user_id !== user.id && !project.published_slug)) {
    return { error: jsonError("应用不存在", 404) };
  }
  return { projectId: id, userId: user.id };
}

export async function GET(_request: Request, ctx: Params) {
  const auth = await authorize(ctx);
  if (auth.error) return auth.error;
  const row = await queryOne<{ data: string }>("SELECT data FROM app_storage WHERE project_id = ? AND user_id = ?", [
    auth.projectId,
    auth.userId,
  ]);
  let data: Record<string, string> = {};
  try {
    data = row ? JSON.parse(row.data) : {};
  } catch {
    /* corrupted row: start empty */
  }
  return Response.json({ data });
}

export async function PUT(request: Request, ctx: Params) {
  const auth = await authorize(ctx, true);
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => null);
  const input = body?.data;
  if (!input || typeof input !== "object" || Array.isArray(input)) return jsonError("数据格式不正确");
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) data[key] = String(value);
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json) > config().storage.maxAppDataBytes) return jsonError("应用数据超过大小上限", 413);
  const existing = await queryOne("SELECT 1 AS x FROM app_storage WHERE project_id = ? AND user_id = ?", [
    auth.projectId,
    auth.userId,
  ]);
  if (!existing) {
    const rows = await queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM app_storage WHERE user_id = ?", [auth.userId]);
    if (Number(rows?.n ?? 0) >= config().storage.maxAppDataRowsPerUser) return jsonError("保存数据的应用数量已达上限", 403);
  }
  await run(
    `INSERT INTO app_storage (project_id, user_id, data, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id, user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    [auth.projectId, auth.userId, json, Date.now()],
  );
  return Response.json({ ok: true });
}
