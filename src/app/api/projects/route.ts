import { getOrCreateUser, GuestLimitError, jsonError } from "@/lib/auth";
import { config } from "@/lib/config";
import { run } from "@/lib/db";
import { getJob } from "@/lib/jobs";
import { countProjects, createProject, findBlankProject } from "@/lib/store";

/**
 * Creates an empty project. First-time visitors get a guest account here, so there is no login wall.
 *
 * `{ prompt }` names the project after the request (the home page then starts the first build).
 * `{ blank: true }` is "new project" from inside the workspace: the request is typed there. An
 * unused blank project is handed out again instead of piling up empty ones.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const blank = body?.blank === true;
  const prompt = String(body?.prompt ?? "").trim();
  if (!blank && !prompt) return jsonError("请先描述你想做的应用");
  let user;
  try {
    user = await getOrCreateUser();
  } catch (error) {
    if (error instanceof GuestLimitError) return jsonError(error.message, 429);
    throw error;
  }
  if (blank) {
    const unused = await findBlankProject(user.id);
    // A project whose first build has only just been requested has no messages yet either.
    if (unused && !getJob(unused, user.id)) {
      // It may carry the name of a request that never ran; it starts over as a new project.
      await run("UPDATE projects SET title = '新项目', updated_at = ? WHERE id = ?", [Date.now(), unused]);
      return Response.json({ id: unused });
    }
  }
  const limit = config().storage.maxProjectsPerUser;
  if ((await countProjects(user.id)) >= limit) return jsonError(`每个账号最多保留 ${limit} 个项目，请先删除一些。`, 403);
  const id = await createProject(user.id, blank ? "新项目" : prompt.slice(0, 24));
  return Response.json({ id });
}
