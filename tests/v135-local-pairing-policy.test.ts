/**
 * أذونُ المتصفّح وفصلُ الرمز القديم.
 *
 * ★ الاقترانُ لا يحتاج ميكروفونًا، فلا يفتح ميكروفونًا.
 *
 *   وهذا نوعٌ من الانزلاق يمرّ بسهولة: تُشعل ميزةً محلّيّةً فتُفتح معها
 *   أذونٌ «قد تلزم لاحقًا». والإذنُ المفتوح احتياطًا يبقى مفتوحًا.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy } from "@/lib/csp";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * ★ والحارسُ يقرأ المُنفَّذ لا المشروح.
 *
 *   أوّلُ صياغةٍ لهذا الملفّ سقطت على `localStorage` وهي مذكورةٌ في تعليقٍ
 *   يشرح **لماذا لا تُستعمل**. وحارسٌ يجد الكلمةَ في شرحٍ يمنعها هو حارسٌ
 *   يقرأ نصًّا لا شيفرة — ولو عُكس الحال لمرّ استعمالٌ حقيقيٌّ في ملفٍّ
 *   بلا تعليق.
 */
function executable(rel: string): string {
  const NL = String.fromCharCode(10);
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(NL)
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join(NL);
}

describe("سياسةُ الأذون", () => {
  const nextConfig = read("next.config.mjs");

  it("الميكروفونُ مغلقٌ في الإعداد الأساس", () => {
    expect(nextConfig).toMatch(/Permissions-Policy/);
    expect(nextConfig).toMatch(/microphone=\(\)/);
  });

  it("★ ولا يذكر الاقترانُ في سياسة الأذون بحال", () => {
    /**
     * الرايةُ تفتح `connect-src` وحدَها. ولو ظهر اسمُها هنا لكان ذلك
     * إمّا توسيعَ أذونٍ بلا سبب، وإمّا اقترانًا بميزةٍ أخرى.
     */
    expect(nextConfig).not.toContain("NEXT_PUBLIC_YSD_LOCAL_PAIRING");
    expect(nextConfig).not.toContain("PAIRING");
  });

  it("والاقترانُ مشتعلٌ لا يُغيّر شيئًا خارج connect-src", () => {
    const off = buildContentSecurityPolicy("n", { isDev: false, localImage: false, localPairing: false });
    const on = buildContentSecurityPolicy("n", { isDev: false, localImage: false, localPairing: true });

    const strip = (p: string) => p.split("; ").filter((d) => !d.startsWith("connect-src")).join("; ");
    expect(strip(on)).toBe(strip(off));
  });
});

describe("فصلُ الرمز القديم", () => {
  const pairingFiles = [
    "lib/local-pairing/client.ts",
    "lib/local-pairing/credential.ts",
    "lib/local-pairing/session.ts",
    "lib/local-pairing/payload.ts",
    "lib/local-pairing/flag.ts",
    "components/local-pairing/pairing-panel.tsx",
  ];

  it("★ لا يقرأ الاقترانُ الرمزَ الملصوق يدويًّا ولا يكتبه", () => {
    for (const file of pairingFiles) {
      const source = executable(file);
      expect(source, file).not.toContain("ysd.localEngineToken");
      expect(source, file).not.toContain("localStorage");
    }
  });

  it("★ ولا سقوطَ من الاقتران إلى الرمز القديم", () => {
    /**
     * ★ وهذا هو موضعُ الخطر بعينه.
     *
     *   بروتوكولٌ سليمٌ يسقط عند الفشل إلى سرٍّ ملصوقٍ يدويًّا ليس
     *   بروتوكولًا سليمًا: يكفي المهاجمَ أن يُفشِل المصادقةَ ليُفتح له
     *   الطريقُ الأضعف.
     */
    const client = executable("lib/local-pairing/client.ts");
    expect(client).not.toMatch(/fallback/i);
    expect(client).not.toMatch(/legacy/i);
  });

  it("وميزةُ الصورة تُبقي طريقَها القديم كما هو — لا انحدار", () => {
    const imageClient = executable("lib/local-image/client.ts");
    /** ما زالت تأخذ الرمزَ وسيطًا صريحًا كما كانت */
    expect(imageClient).toMatch(/export async function fetchCapabilities\(token: string\)/);
    expect(imageClient).toMatch(/authorization: `Bearer \$\{token\}`/);
    /** ولم تُربَط بالاقتران */
    expect(imageClient).not.toContain("local-pairing");
  });

  it("والإعداداتُ تعرض اللوحتين مستقلّتين", () => {
    const page = read("app/(app)/settings/page.tsx");
    expect(page).toContain("<LocalAiSettings />");
    expect(page).toContain("<LocalPairingPanel />");
  });
});

describe("مِنصّةُ القبول — تطويرٌ فقط", () => {
  const route = executable("app/local-pairing-harness/page.tsx");

  /**
   * ★ بوّابتان لا واحدة.
   *
   *   `NODE_ENV` وحدَها تُخرجها من كلّ بناءِ إنتاج؛ والرايةُ تمنع ظهورَها
   *   في تطويرٍ لم تُطلب فيه الميزة. وسقوطُ إحداهما يمرّ صامتًا لولا هذا.
   */
  it("★ المسارُ يسقط في الإنتاج قبل أن يُصيَّر شيء", () => {
    expect(route).toContain('process.env.NODE_ENV === "production"');
    expect(route).toContain("notFound()");
  });

  it("وبالراية أيضًا", () => {
    expect(route).toContain("isLocalPairingEnabled()");
  });

  it("والبوّابتان قبل أيّ تصيير", () => {
    const prodGate = route.indexOf('NODE_ENV === "production"');
    const flagGate = route.indexOf("isLocalPairingEnabled()");
    const render = route.indexOf("<PairingHarness");
    expect(prodGate).toBeGreaterThan(0);
    expect(flagGate).toBeGreaterThan(prodGate);
    expect(render).toBeGreaterThan(flagGate);
  });

  it("★ والمِنصّةُ لا تطبع قيمةَ سرٍّ — تصنيفاتٌ فقط", () => {
    const harness = executable("components/local-pairing/pairing-harness.tsx");
    expect(harness).not.toMatch(/\$\{[^}]*\.token\}/);
    expect(harness).not.toMatch(/console\./);
    /** الرمزُ يُقتطع إلى ثمانيةِ محارف، ولا يُعرض كاملًا */
    expect(harness).toContain("clientId.slice(0, 8)");
  });
});
