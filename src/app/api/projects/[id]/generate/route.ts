import { getUser, jsonError } from "@/lib/auth";
import { config } from "@/lib/config";
import { cancelJob, finishJob, getJob, startJob, streamJob } from "@/lib/jobs";
import { clientIpHash } from "@/lib/rate-limit";
import { chargeGeneration, getOwnedProject, hasStorageRoom, refundGeneration, type ChargeSource } from "@/lib/store";

export const maxDuration = 800;

type Params = { params: Promise<{ id: string }> };

async function authorize({ params }: Params) {
  const { id } = await params;
  const user = await getUser();
  if (!user) return { error: jsonError("请先登录", 401) };
  const project = await getOwnedProject(id, user.id);
  if (!project) return { error: jsonError("项目不存在", 404) };
  return { user, project };
}

/** Starts a generation job. The job keeps running even if this client goes away. */
export async function POST(request: Request, ctx: Params) {
  const auth = await authorize(ctx);
  if (auth.error) return auth.error;
  const { user, project } = auth;

  const body = await request.json().catch(() => null);
  const prompt = String(body?.prompt ?? "").trim().slice(0, 4000);
  if (!prompt) return jsonError("请输入需求");
  // Only models on the server's allowlist can be requested; anything else falls back to the default
  // (the free model when the site has one).
  const { models } = config().llm;
  const requested = String(body?.model ?? "");
  const choice = models.find((m) => m.id === requested) ?? models[0];
  const model = choice.id;
  if (getJob(project.id, user.id)?.running) return jsonError("这个项目正在生成中，请等它完成或先停止。", 409);

  if (!(await hasStorageRoom(user.id))) {
    return jsonError("账号的存储空间已满，请先删除一些不用的项目。", 403);
  }

  // Race mode: 2-3 different allowlisted models build the same request; each lane is charged
  // like a normal generation on that model.
  const { race } = config();
  const wanted: string[] = Array.isArray(body?.models) ? [...new Set((body.models as unknown[]).map(String))] : [];
  const lanes = wanted.map((id) => models.find((m) => m.id === id)).filter((m) => m !== undefined);
  const racing = wanted.length > 0;
  if (racing && (!race.enabled || lanes.length !== wanted.length || lanes.length < 2 || lanes.length > race.maxLanes)) {
    return jsonError(`竞速模式需要选择 2 到 ${race.maxLanes} 个不同的模型。`);
  }

  // The free allowance covers free models only; premium models always spend a credit.
  const ipHash = await clientIpHash();
  const picks = racing ? lanes : [choice];
  const charged: ChargeSource[] = [];
  for (const pick of picks) {
    const charge = await chargeGeneration(user, pick.premium, ipHash);
    if (charge.ok) {
      charged.push(charge.source);
      continue;
    }
    // Nothing runs unless every lane can be paid for.
    for (const source of charged) await refundGeneration(user.id, source);
    if (charge.reason === "site") return jsonError("今天体验的人太多，全站生成额度已用完，请明天再来。", 429);
    if (charge.reason === "ip") {
      return jsonError("这个网络下的访客今天的免费次数已经用完。用 Google 登录后可以继续使用，或明天再来。", 429);
    }
    if (charge.reason === "user_max") return jsonError("这个账号今天的生成次数已达上限，请明天再来。", 429);
    if (racing) return jsonError(`竞速需要 ${picks.length} 次额度（付费模型消耗积分），当前额度不够。可以少选几个模型，或到「额度」页补充积分。`, 402);
    return pick.premium
      ? jsonError(`「${pick.label}」需要消耗积分，而你的积分不足。可以换回免费模型，或到「额度」页补充积分。`, 402)
      : jsonError("今日免费次数已用完，积分余额也不足。可以到「额度」页补充积分，或明天再来。", 402);
  }

  const outcome = await startJob({
    projectId: project.id,
    userId: user.id,
    projectTitle: project.title,
    prompt,
    model,
    charge: charged[0],
    race: racing ? lanes.map((m, i) => ({ model: m.id, label: m.label, charge: charged[i] })) : undefined,
  });
  if (outcome !== "started") {
    // Nothing ran, so give the units back.
    for (const source of charged) await refundGeneration(user.id, source);
    if (outcome === "user_limit") return jsonError("你同时运行的任务太多了，请等其中一个完成。", 429);
    if (outcome === "server_limit") return jsonError("服务器正忙，请稍等片刻再试。", 503);
    return jsonError("这个项目正在生成中，请等它完成或先停止。", 409);
  }
  return Response.json({ ok: true, race: racing });
}

/** Attaches to the project's job and streams its events from `?from=<index>` (NDJSON). */
export async function GET(request: Request, ctx: Params) {
  const auth = await authorize(ctx);
  if (auth.error) return auth.error;
  const job = getJob(auth.project.id, auth.user.id);
  if (!job) return new Response(null, { status: 204 });
  const from = Number(new URL(request.url).searchParams.get("from") ?? 0) || 0;
  return new Response(streamJob(job, from, request.signal), {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

/** Stops the running job. */
export async function DELETE(request: Request, ctx: Params) {
  const auth = await authorize(ctx);
  if (auth.error) return auth.error;
  // ?finish=1 (race mode): stop waiting for the slower models but keep the finished entries.
  const finish = new URL(request.url).searchParams.get("finish") === "1";
  const stop = finish ? finishJob : cancelJob;
  return Response.json({ cancelled: stop(auth.project.id, auth.user.id) });
}
