import { Brand } from "@/components/Brand";
import { Home } from "@/components/Home";
import { UserMenu } from "@/components/UserMenu";
import { config } from "@/lib/config";
import { getUser } from "@/lib/auth";
import { listProjectCards } from "@/lib/projects";
import { getQuota } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await getUser();
  const [projects, quota] = user ? await Promise.all([listProjectCards(user.id), getQuota(user)]) : [[], null];
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
