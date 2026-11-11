import type { Metadata } from "next";
import Link from "next/link";
import { Brand } from "@/components/Brand";
import { config } from "@/lib/config";

export const metadata: Metadata = { title: "隐私政策 · Atoms Demo" };

export const dynamic = "force-dynamic";

export default function PrivacyPage() {
  const contact = config().site.contactEmail;
  return (
    <>
      <header className="px-5 py-4 sm:px-8">
        <Brand />
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-5 pb-20 text-sm leading-relaxed sm:px-8">
        <h1 className="mt-6 text-2xl font-medium">隐私政策</h1>
        <p className="mt-2 text-muted">最后更新：2026 年 11 月 10 日</p>

        <p className="mt-6">
          Atoms Demo 是一个个人开发的演示项目：你描述需求，它生成可运行的网页应用。本页说明它会保存哪些数据、用来做什么，以及你如何删除它们。
        </p>

        <Section title="我们保存的数据">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <b>账号信息</b>：登录只支持 Google。登录时只从 Google 获取你的邮箱和显示名称，不获取密码、联系人或其他
              Google 数据；本站不保存任何密码。访客身份只保存一个随机标识。
            </li>
            <li>
              <b>你创建的内容</b>：你输入的需求、对话记录、生成的应用代码和历史版本。
            </li>
            <li>
              <b>应用内数据</b>：你在生成的应用里产生的数据（例如待办事项），按“应用 + 账号”单独保存。
            </li>
            <li>
              <b>用量计数</b>：每个账号每天的生成次数，以及访客所在网络地址的当日次数（地址只保存不可逆的哈希值），用于限流。
            </li>
            <li>
              <b>登录 Cookie</b>：一个仅用于保持登录状态的 Cookie。不使用广告或第三方统计 Cookie。
            </li>
          </ul>
        </Section>

        <Section title="数据的用途">
          <p>这些数据只用于提供本服务：让你登录、保存和恢复你的项目、展示你发布的应用，以及防止滥用。不会出售，也不会用于广告。</p>
        </Section>

        <Section title="会交给第三方的数据">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <b>模型服务</b>：为了生成应用，你输入的需求和当前应用代码会发送给腾讯云的大模型服务。请不要在需求里填写敏感的个人信息。
            </li>
            <li>
              <b>Google</b>：仅在你选择用 Google 登录时，用于完成身份验证。
            </li>
            <li>
              <b>公开分享</b>：只有你主动点击“发布”的应用会通过公开链接被他人访问；发布页会显示你的显示名称。
            </li>
          </ul>
        </Section>

        <Section title="存储位置与保留时间">
          <p>数据保存在位于中国大陆的服务器上。这是一个演示项目，数据可能在项目下线时被整体删除，请不要把它当作长期存储。</p>
        </Section>

        <Section title="删除你的数据">
          <p>
            你可以在首页删除任意项目，其对话、版本和应用内数据会一并删除。
            {contact ? (
              <>
                如需删除整个账号，请发邮件到{" "}
                <a className="text-accent underline underline-offset-2" href={`mailto:${contact}`}>
                  {contact}
                </a>
                。
              </>
            ) : (
              "如需删除整个账号，请联系站点管理员。"
            )}
            使用 Google 登录的用户也可以随时在 Google 账号的“第三方应用和服务”里撤销授权。
          </p>
        </Section>

        <p className="mt-10">
          <Link href="/" className="text-accent underline underline-offset-2">
            返回首页
          </Link>
        </p>
      </main>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-base font-medium">{title}</h2>
      {children}
    </section>
  );
}
