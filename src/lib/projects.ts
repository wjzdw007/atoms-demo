import type { ProjectCard } from "@/components/ProjectList";
import { jobSnapshot } from "./jobs";
import { listProjects } from "./store";

/** A user's projects as the home page list and the workspace sidebar show them, newest first. */
export async function listProjectCards(userId: string): Promise<ProjectCard[]> {
  const rows = await listProjects(userId);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    versionCount: Number(row.version_count),
    lastPrompt: row.last_prompt,
    updatedAt: Number(row.updated_at),
    publishedSlug: row.published_slug,
    remixed: Boolean(row.remixed_from),
    running: Boolean(jobSnapshot(row.id, userId)),
    racePending: Number(row.candidate_count) > 0,
  }));
}
