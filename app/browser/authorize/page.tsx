type Props = { searchParams: Promise<{ user_code?: string; status?: string }> };

export default async function BrowserAuthorizePage({ searchParams }: Props) {
  const params = await searchParams;
  const code = typeof params.user_code === "string" ? params.user_code.toUpperCase() : "";

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-10">
      <section className="w-full max-w-md rounded-2xl border border-line bg-surface/70 p-6 shadow-xl">
        <p className="text-sm text-ink-dim">YSD Browser</p>
        <h1 className="mt-2 text-xl font-semibold text-ink-strong">Authorize YSD Assistant</h1>
        <p className="mt-3 text-sm leading-6 text-ink-dim">
          This authorizes a short-lived browser session for chat, page context after consent,
          and safe action proposals. It does not share your password or Supabase refresh token.
        </p>
        <form action="/api/browser/v1/auth/authorize" method="post" className="mt-5 space-y-4">
          <label className="block text-sm text-ink-dim">
            User code
            <input
              name="user_code"
              defaultValue={code}
              required
              pattern="[A-Z0-9]{4}-[A-Z0-9]{4}"
              className="mt-2 w-full rounded-xl border border-line bg-black/20 px-3 py-2 text-ink-strong"
            />
          </label>
          <div className="flex gap-3">
            <button
              name="decision"
              value="approve"
              className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white"
            >
              Authorize
            </button>
            <button
              name="decision"
              value="deny"
              className="rounded-xl border border-line px-4 py-2 text-sm text-ink-dim"
            >
              Deny
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
