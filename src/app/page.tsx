import { Brand } from "@/components/Brand";
import { Home } from "@/components/Home";
import { UserMenu } from "@/components/UserMenu";
import { config } from "@/lib/config";
import { getUser } from "@/lib/auth";
import { listProjects } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await getUser();
  const projects = user ? await listProjects(user.id) : [];
  return (
    <div className="home-wash flex flex-1 flex-col">
      <header className="flex items-center justify-between px-5 py-4 sm:px-8">
        <Brand />
        <UserMenu user={user} />
      </header>
      <Home projects={projects} mock={config().llm.mock} />
    </div>
  );
}
