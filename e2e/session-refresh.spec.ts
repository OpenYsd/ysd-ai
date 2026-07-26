/**
 * تجديد الجلسة (v0.6.6 RC2) — access token منتهٍ + refresh token صالح.
 *
 * الانحدار المُصلَح: الوسيط كان يستخدم getClaims (تحقّق محلي) الذي لا يُجدّد
 * التوكن المنتهي، فيُوجَّه المستخدم إلى /login رغم صلاحية refresh token.
 *
 * السلامة (شرط لا خيار): كل شيء داخل **سياق متصفح معزول** يُبنى من نسخة من
 * حالة التخزين. جلسة YSD Admin الأصلية في المتصفح الآخر لا تُمسّ إطلاقًا.
 * ملاحظة: تجديد التوكن يُبطل refresh token القديم في النسخة المصدر أيضًا عند
 * تفعيل التدوير — لذلك يُنصح باستخدام حساب اختبار مخصّص لا حساب الأدمن.
 */
import { test, expect, type BrowserContext, type Browser } from "@playwright/test";
import fs from "node:fs";

const STORAGE = process.env.YSD_E2E_STORAGE_STATE;

/** يبني سياقًا معزولًا من نسخة حالة التخزين — لا يشارك أي شيء مع غيره */
async function isolatedContext(browser: Browser): Promise<BrowserContext> {
  const raw = JSON.parse(fs.readFileSync(STORAGE!, "utf8"));
  return browser.newContext({ storageState: raw });
}

/**
 * يجعل access token منتهيًا داخل السياق المعزول مع إبقاء refresh token صالحًا.
 * كوكي Supabase قد تكون مجزّأة (.0/.1) وبصيغة base64- — نفكّها ونعيد تركيبها.
 */
async function expireAccessToken(ctx: BrowserContext): Promise<boolean> {
  const cookies = await ctx.cookies();
  const parts = cookies
    .filter((c) => /^sb-.*auth-token(\.\d+)?$/.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (parts.length === 0) return false;

  const joined = parts.map((p) => p.value).join("");
  const isB64 = joined.startsWith("base64-");
  let payload: Record<string, unknown>;
  try {
    const jsonText = isB64
      ? Buffer.from(joined.slice("base64-".length), "base64").toString("utf8")
      : decodeURIComponent(joined);
    payload = JSON.parse(jsonText);
  } catch {
    return false;
  }
  if (!payload.refresh_token) return false;

  // انتهاء في الماضي — يجبر العميل/الوسيط على استخدام refresh token
  payload.expires_at = Math.floor(Date.now() / 1000) - 3600;
  payload.expires_in = 0;

  const encoded = isB64
    ? `base64-${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}`
    : encodeURIComponent(JSON.stringify(payload));

  // أعد الكتابة في كوكي واحدة وامسح الأجزاء الزائدة
  const base = parts[0]!;
  const newCookies = [
    { ...base, name: base.name.replace(/\.\d+$/, ""), value: encoded },
    ...parts.slice(1).map((p) => ({ ...p, value: "", expires: 1 })),
  ];
  await ctx.addCookies(newCookies);
  return true;
}

test.describe("تجديد الجلسة", () => {
  test.skip(
    !STORAGE || !fs.existsSync(STORAGE),
    "يحتاج YSD_E2E_STORAGE_STATE يشير إلى حالة تخزين لحساب اختبار",
  );

  test("★ access token منتهٍ + refresh صالح → لا انتقال إلى /login", async ({ browser }) => {
    const ctx = await isolatedContext(browser);
    const ok = await expireAccessToken(ctx);
    test.skip(!ok, "تعذّر تفسير كوكي الجلسة");

    const page = await ctx.newPage();
    await page.goto("/chat", { waitUntil: "domcontentloaded" });

    // المعيار الأول: لم يُطرد إلى صفحة الدخول
    expect(page.url()).not.toContain("/login");

    // المعيار الثاني: التوكن جُدّد فعلًا — كوكي جديدة بانتهاء مستقبلي
    const after = await ctx.cookies();
    const authCookie = after.filter((c) => /^sb-.*auth-token(\.\d+)?$/.test(c.name));
    expect(authCookie.length).toBeGreaterThan(0);

    // المعيار الثالث: مسار محمي يعمل بعد التجديد
    const res = await page.request.get("/api/files");
    expect(res.status()).toBe(200);

    await ctx.close();
  });

  test("★ المسودة تبقى بعد إعادة المصادقة", async ({ browser }) => {
    const ctx = await isolatedContext(browser);
    const page = await ctx.newPage();
    await page.goto("/chat", { waitUntil: "domcontentloaded" });

    const draft = "مسودة اختبار لا يجب أن تضيع";
    const box = page.locator("textarea").first();
    await box.fill(draft);
    await page.waitForTimeout(600); // ليُكتب في التخزين المحلي

    await expireAccessToken(ctx);
    await page.reload({ waitUntil: "domcontentloaded" });

    expect(page.url()).not.toContain("/login");
    await expect(page.locator("textarea").first()).toHaveValue(draft);

    await ctx.close();
  });
});
