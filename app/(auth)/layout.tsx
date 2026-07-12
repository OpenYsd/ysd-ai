import { Logo } from "@/components/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rise">
        <div className="flex justify-center mb-8">
          <Logo tagline="منصة الذكاء العربي" />
        </div>
        <div className="rounded-2xl border border-line bg-surface/60 backdrop-blur p-6">
          {children}
        </div>
      </div>
    </main>
  );
}
