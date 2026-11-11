import { queryOne } from "./db";

export async function getPublished(slug: string) {
  const row = await queryOne<{ project_id: string; title: string; html: string; author: string; number: number }>(
    `SELECT p.id AS project_id, p.title, v.html, v.number, u.name AS author
     FROM projects p
     JOIN versions v ON v.id = p.published_version_id
     JOIN users u ON u.id = p.user_id
     WHERE p.published_slug = ?`,
    [slug],
  );
  if (!row) return null;
  return { projectId: row.project_id, title: row.title, html: row.html, author: row.author, number: Number(row.number) };
}
