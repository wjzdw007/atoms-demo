import { getUser, jsonError } from "@/lib/auth";
import { readJson } from "@/lib/body";
import { run, transaction } from "@/lib/db";
import { cancelJob } from "@/lib/jobs";
import { getOwnedProject } from "@/lib/store";

type Params = { params: Promise<{ id: string }> };

async function authorize({ params }: Params) {
  const { id } = await params;
  const user = await getUser();
  if (!user) return { error: jsonError("请先登录", 401) };
  const project = await getOwnedProject(id, user.id);
  if (!project) return { error: jsonError("项目不存在", 404) };
  return { user, project };
}

/** Renames a project. */
export async function PATCH(request: Request, ctx: Params) {
  const auth = await authorize(ctx);
  if (auth.error) return auth.error;
  const body = await readJson(request);
  const title = String(body?.title ?? "").trim().slice(0, 40);
  if (!title) return jsonError("名称不能为空");
  await run("UPDATE projects SET title = ? WHERE id = ? AND user_id = ?", [title, auth.project.id, auth.user.id]);
  return Response.json({ title });
}

export async function DELETE(_request: Request, ctx: Params) {
  const auth = await authorize(ctx);
  if (auth.error) return auth.error;
  const { id } = auth.project;
  cancelJob(id, auth.user.id);
  // All or nothing: a failure halfway must not leave a project without its versions.
  await transaction([
    { sql: "DELETE FROM race_candidates WHERE project_id = ?", args: [id] },
    { sql: "DELETE FROM app_storage WHERE project_id = ?", args: [id] },
    { sql: "DELETE FROM messages WHERE project_id = ?", args: [id] },
    { sql: "DELETE FROM versions WHERE project_id = ?", args: [id] },
    { sql: "DELETE FROM projects WHERE id = ? AND user_id = ?", args: [id, auth.user.id] },
  ]);
  return Response.json({ ok: true });
}
