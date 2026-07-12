import { createBrowserClient } from "@supabase/ssr";

/** عميل Supabase للمتصفح — المفتاح العام anon فقط */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
