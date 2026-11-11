import { getUser, jsonError } from "@/lib/auth";
import { run } from "@/lib/db";
import { addMessage, addVersion, clearCandidates, getCandidate, getLatestVersion, getOwnedProject, hasStorageRoom } from "@/lib/store";

type Params = { params: Promise<{ id: string }> };

async function authorize({ params }: Params) {
  const { id } = await params;
  const user = await getUser();
  if (!user) return { error: jsonError("请先登录", 401) };
  const project = await getOwnedProject(id, user.id);
  if (!project) return { error: jsonError("项目不存在", 404) };
  return { user, project };
}

/** Keeps one race entry: it becomes the project's next version, the others are discarded. */
export async function POST(request: Request, ctx: Params) {
  const auth = await authorize(ctx);
  if (auth.error) return auth.error;
  const { user, project } = auth;
  const body = await request.json().catch(() => null);
  const candidate = await getCandidate(project.id, String(body?.candidateId ?? ""));
  if (!candidate?.html) return jsonError("这个候选版本不存在或没有生成成功", 404);
  if (!(await hasStorageRoom(user.id, Buffer.byteLength(candidate.html)))) {
    return jsonError("账号的存储空间已满，请先删除一些不用的项目。", 403);
  }

  const first = !(await getLatestVersion(project.id));
  const version = await addVersion(project.id, candidate.html, candidate.prompt);
  let title = project.title;
  if (first && candidate.title) {
    title = candidate.title;
    await run("UPDATE projects SET title = ? WHERE id = ?", [title, project.id]);
  }
  const message = await addMessage(project.id, "assistant", `🏁 已采用「${candidate.label}」的版本，保存为 v${version.number}。`, version.id);
  await clearCandidates(project.id);
  return Response.json({ version, message, html: candidate.html, title });
}

/** Dismisses all race entries without keeping any. */
export async function DELETE(_request: Request, ctx: Params) {
  const auth = await authorize(ctx);
  if (auth.error) return auth.error;
  await clearCandidates(auth.project.id);
  return Response.json({ ok: true });
}
