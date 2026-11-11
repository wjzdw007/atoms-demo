import { getOrCreateUser, GuestLimitError, jsonError } from "@/lib/auth";
import { getPublished } from "@/lib/share";
import { config } from "@/lib/config";
import { rateLimit } from "@/lib/rate-limit";
import { addMessage, addVersion, countProjects, createProject, hasStorageRoom } from "@/lib/store";

/** Copies a published app into the visitor's own workspace so they can keep iterating on it. */
export async function POST(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const published = await getPublished(slug);
  if (!published) return jsonError("分享不存在或已取消发布", 404);
  let user;
  try {
    user = await getOrCreateUser();
  } catch (error) {
    if (error instanceof GuestLimitError) return jsonError(error.message, 429);
    throw error;
  }
  const limit = config().storage.maxProjectsPerUser;
  if ((await countProjects(user.id)) >= limit) return jsonError(`每个账号最多保留 ${limit} 个项目，请先删除一些。`, 403);
  if (!rateLimit(`copy:${user.id}`, config().rateLimit.copiesPerHour, 60 * 60_000)) {
    return jsonError("操作太频繁了，请稍后再试。", 429);
  }
  if (!(await hasStorageRoom(user.id, Buffer.byteLength(published.html)))) {
    return jsonError("账号的存储空间已满，请先删除一些不用的项目。", 403);
  }
  const id = await createProject(user.id, `${published.title} · Remix`.slice(0, 40), published.projectId);
  const version = await addVersion(id, published.html, `Remix 自「${published.title}」`);
  await addMessage(id, "assistant", `已从「${published.title}」复制了一份，你可以继续提出修改意见。`, version.id);
  return Response.json({ id });
}
