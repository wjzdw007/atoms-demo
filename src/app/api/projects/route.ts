import { getOrCreateUser, GuestLimitError, jsonError } from "@/lib/auth";
import { config } from "@/lib/config";
import { countProjects, createProject } from "@/lib/store";

/** Creates an empty project. First-time visitors get a guest account here, so there is no login wall. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const prompt = String(body?.prompt ?? "").trim();
  if (!prompt) return jsonError("请先描述你想做的应用");
  let user;
  try {
    user = await getOrCreateUser();
  } catch (error) {
    if (error instanceof GuestLimitError) return jsonError(error.message, 429);
    throw error;
  }
  const limit = config().storage.maxProjectsPerUser;
  if ((await countProjects(user.id)) >= limit) return jsonError(`每个账号最多保留 ${limit} 个项目，请先删除一些。`, 403);
  const id = await createProject(user.id, prompt.slice(0, 24));
  return Response.json({ id });
}
