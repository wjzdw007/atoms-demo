import Link from "next/link";

/**
 * Sign-in is Google only. Visitors who do not sign in still get a guest identity automatically
 * the moment they create their first app, so nobody is stopped at this page.
 */
export function LoginForm({
  isGuest,
  googleEnabled,
  error,
}: {
  isGuest: boolean;
  googleEnabled: boolean;
  error: string;
}) {
  return (
    <div className="mt-8 w-full max-w-sm rounded-2xl border border-line bg-panel p-6 text-center">
      <h1 className="text-lg font-medium">登录 Atoms Demo</h1>
      <p className="mt-2 text-sm text-muted">
        {isGuest ? "登录后，当前访客身份下的项目会保留在你的账号里。" : "登录后可以跨设备保存项目，并获得更多每日免费次数。"}
      </p>

      {error && <p className="mt-4 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}

      {googleEnabled ? (
        // A full navigation on purpose: this route redirects to Google's consent screen.
        <a
          href="/api/auth/google"
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-full border border-line py-2.5 text-sm font-medium hover:bg-raised"
        >
          <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
            <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z" />
            <path fill="#FBBC05" d="M10.5 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.8l7.9-6.1z" />
            <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.700-6c-2.2 1.5-5 2.3-8.2 2.3-6.3 0-11.6-4.1-13.5-9.800l-7.900 6.100C6.5 42.600 14.600 48 24 48z" />
          </svg>
          使用 Google 账号登录
        </a>
      ) : (
        <p className="mt-6 rounded-lg bg-raised px-3 py-2 text-sm text-muted">
          这个站点还没有配置 Google 登录（需要 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET）。
        </p>
      )}

      <p className="mt-5 text-xs text-muted">
        打不开 Google？
        <Link href="/" className="text-ink underline underline-offset-2">
          直接以访客身份体验
        </Link>
      </p>
      <p className="mt-2 text-xs text-muted">
        登录即表示你已阅读
        <Link href="/privacy" className="text-ink underline underline-offset-2">
          隐私政策
        </Link>
      </p>
    </div>
  );
}
