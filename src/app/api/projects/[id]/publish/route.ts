import { nanoid } from "nanoid";
import { readJson } from "@/lib/body";
import { getUser, jsonError } from "@/lib/auth";
import { run } from "@/lib/db";
import { getLatestVersion, getOwnedProject } from "@/lib/store";

/** Publishes the latest version under a public /s/<slug> link, or unpublishes with { unpublish: true }. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getUser();
  if (!user) return jsonError("请先登录", 401);
  const project = await getOwnedProject(id, user.id);
  if (!project) return jsonError("项目不存在", 404);

  const body = await readJson(request);
  if (body?.unpublish) {
    await run("UPDATE projects SET published_slug = NULL, published_version_id = NULL WHERE id = ?", [id]);
    return Response.json({ slug: null, versionId: null });
  }

  const latest = await getLatestVersion(id);
  if (!latest) return jsonError("还没有可发布的版本");
  const slug = project.published_slug ?? nanoid(10);
  await run("UPDATE projects SET published_slug = ?, published_version_id = ? WHERE id = ?", [slug, latest.id, id]);
  return Response.json({ slug, versionId: latest.id });
}
