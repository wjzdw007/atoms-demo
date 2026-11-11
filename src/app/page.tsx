import { Brand } from "@/components/Brand";
import { Home } from "@/components/Home";
import { UserMenu } from "@/components/UserMenu";
import { config } from "@/lib/config";
import { getUser } from "@/lib/auth";
import { jobSnapshot } from "@/lib/jobs";
import { getQuota, listProjects } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await getUser();
  const [rows, quota] = user ? await Promise.all([listProjects(user.id), getQuota(user)]) : [[], null];
  const projects = rows.map((row) => ({
    id: row.id,
    title: row.title,
    versionCount: Number(row.version_count),
    lastPrompt: row.last_prompt,
    updatedAt: Number(row.updated_at),
    publishedSlug: row.published_slug,
    remixed: Boolean(row.remixed_from),
    running: Boolean(user && jobSnapshot(row.id, user.id)),
    racePending: Number(row.candidate_count) > 0,
  }));
  const { llm, race, storage } = config();
  return (
    <div className="home-wash flex flex-1 flex-col">
      <header className="flex items-center justify-between px-5 py-4 sm:px-8">
        <Brand />
        <UserMenu user={user} />
      </header>
      <Home
        projects={projects}
        maxProjects={storage.maxProjectsPerUser}
        isGuest={Boolean(user?.is_guest)}
        mock={llm.mock}
        models={llm.models}
        raceMax={race.enabled ? race.maxLanes : 0}
        credits={quota?.credits ?? 0}
        freeLeft={quota?.freeLeft ?? config().quota.guestDaily}
      />
    </div>
  );
}
