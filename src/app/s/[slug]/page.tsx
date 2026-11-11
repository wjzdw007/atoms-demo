import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ShareView } from "@/components/ShareView";
import { getPublished } from "@/lib/share";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const published = await getPublished(slug);
  return { title: published ? `${published.title} · Atoms Demo` : "分享不存在" };
}

export default async function SharePage({ params }: Props) {
  const { slug } = await params;
  const published = await getPublished(slug);
  if (!published) notFound();
  return <ShareView slug={slug} projectId={published.projectId} title={published.title} author={published.author} html={published.html} />;
}
