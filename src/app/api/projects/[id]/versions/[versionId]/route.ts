import { getUser, jsonError } from "@/lib/auth";
import { config } from "@/lib/config";
import { rateLimit } from "@/lib/rate-limit";
import { addMessage, addVersion, getOwnedProject, getVersion, hasStorageRoom } from "@/lib/store";

type Params = { params: Promise<{ id: string; versionId: string }> };

async function load({ params }: Params) {
  const { id, versionId } = await params;
  const user = await getUser();
  if (!user) return { error: jsonError("请先登录", 401) };
  const project = await getOwnedProject(id, user.id);
  const version = project ? await getVersion(id, versionId) : null;
  if (!project || !version) return { error: jsonError("版本不存在", 404) };
  return { project, version, user };
}

/** Returns one version's HTML (the workspace only preloads the latest). */
export async function GET(_request: Request, ctx: Params) {
  const found = await load(ctx);
  if (found.error) return found.error;
  return Response.json({ html: found.version.html });
}

/** Restores an old version by copying it forward as a new one, so history is never rewritten. */
export async function POST(_request: Request, ctx: Params) {
  const found = await load(ctx);
  if (found.error) return found.error;
  const { project, version, user } = found;
  // Restoring copies a whole document and costs no quota, so it is rate- and size-limited.
  if (!rateLimit(`copy:${user.id}`, config().rateLimit.copiesPerHour, 60 * 60_000)) {
    return jsonError("操作太频繁了，请稍后再试。", 429);
  }
  if (!(await hasStorageRoom(user.id, Buffer.byteLength(version.html)))) {
    return jsonError("账号的存储空间已满，请先删除一些不用的项目。", 403);
  }
  const label = `恢复到 v${version.number}`;
  const restored = await addVersion(project.id, version.html, label);
  const message = await addMessage(project.id, "assistant", `已${label}，并保存为 v${restored.number}。`, restored.id);
  return Response.json({ version: restored, message, html: version.html });
}
