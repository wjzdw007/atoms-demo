import { notFound, redirect } from "next/navigation";
import { Workspace } from "@/components/Workspace";
import { config } from "@/lib/config";
import { getUser } from "@/lib/auth";
import { jobSnapshot } from "@/lib/jobs";
import { listProjectCards } from "@/lib/projects";
import { getLatestVersion, getOwnedProject, getQuota, listCandidates, listMessages, listVersions } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getUser();
  if (!user) redirect("/login");
  const project = await getOwnedProject(id, user.id);
  if (!project) notFound();

  const [messages, versions, latest, quota, projects] = await Promise.all([
    listMessages(id),
    listVersions(id),
    getLatestVersion(id),
    getQuota(user),
    listProjectCards(user.id),
  ]);
  const candidates = await listCandidates(id);
  return (
    <Workspace
      // Moving between projects through the sidebar keeps this page mounted: a new key gives
      // each project its own fresh workspace state instead of the previous one's.
      key={project.id}
      projects={projects}
      project={{
        id: project.id,
        title: project.title,
        publishedSlug: project.published_slug,
        publishedVersionId: project.published_version_id,
      }}
      initialMessages={messages}
      initialVersions={versions.map((v) => ({ ...v, number: Number(v.number), created_at: Number(v.created_at) }))}
      initialHtml={latest?.html ?? ""}
      initialJob={jobSnapshot(id, user.id)}
      initialCandidates={candidates}
      raceMax={config().race.enabled ? config().race.maxLanes : 0}
      initialQuota={quota}
      models={config().llm.models}
      mock={config().llm.mock}
    />
  );
}
