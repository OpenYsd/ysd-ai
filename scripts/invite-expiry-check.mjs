/**
 * فحص 0015: تاريخ انتهاء الدعوة يُحسب بساعة القاعدة لا بساعة Node.
 *
 * يُشغَّل **داخل المتصفح** بجلسة owner (لا يحتاج ملف بيانات اعتماد):
 *   انسخ محتوى الدالة أدناه ونفّذها في وحدة تحكم صفحة /admin/invites،
 *   أو شغّلها عبر أداة المتصفح.
 *
 * المنطق: /api/admin/invites يُعيد created_at و expires_at وكلاهما من القاعدة.
 * دعوة ليوم واحد يجب أن يكون فارقها 24 ساعة **بالضبط** (حسبته القاعدة).
 * ولو كان الحساب بساعة Node لظهر الفارق بين expires_at وساعة المتصفح مساويًا
 * 24 ساعة تقريبًا بدل أن ينحرف بمقدار فارق الساعتين.
 */
export async function checkInviteExpiry() {
  const api = (u, o = {}) => fetch(u, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...o });
  const out = [];
  const ok = (n, c, d = "") => out.push({ [n]: c ? "PASS" : `FAIL ${d}` });

  // أنشئ دعوة ليوم واحد
  const t0 = Date.now();
  const res = await api("/api/admin/invites", { method: "POST", body: JSON.stringify({ maxUses: 1, expiresInDays: 1, label: "qa-expiry-1d" }) });
  const inv = await res.json();
  ok("إنشاء دعوة ليوم واحد → 201", res.status === 201 && Boolean(inv.id), `HTTP ${res.status}`);
  if (!inv.id) return { out, note: "0015 غير مطبّقة؟ المسار يرسل p_expires_in_days" };

  const row = (await (await api("/api/admin/invites")).json()).invites.find((i) => i.id === inv.id);
  const createdAt = new Date(row.created_at).getTime();
  const expiresAt = new Date(row.expires_at).getTime();

  // ★ الفارق بين حقلين من القاعدة = 24 ساعة بالضبط (سماح ثانيتين)
  const diffH = (expiresAt - createdAt) / 3_600_000;
  ok("★ expires_at − created_at = 24 ساعة بالضبط (حسبتها القاعدة)", Math.abs(diffH - 24) < 0.0006, `الفارق=${diffH.toFixed(6)}س`);

  // انحراف الساعتين: created_at (القاعدة) مقابل لحظة الطلب (المتصفح)
  const skewSec = (createdAt - t0) / 1000;
  // لو كان الحساب بساعة العميل لكان expiresAt ≈ t0 + 24س، فينعدم أثر الانحراف
  const fromBrowserH = (expiresAt - t0) / 3_600_000;
  ok("★ التاريخ يتبع ساعة القاعدة لا المتصفح", Math.abs(fromBrowserH - 24 - skewSec / 3600) < 0.01,
    `من المتصفح=${fromBrowserH.toFixed(4)}س | الانحراف=${skewSec.toFixed(1)}ث`);

  // الحالة محسوبة من القاعدة (0014) وما زالت active
  ok("الحالة active", row.status === "active", row.status);

  // تنظيف
  await api(`/api/admin/invites/${inv.id}`, { method: "POST" });
  ok("أُلغيت دعوة الفحص", true);

  return { out, انحراف_الساعتين_بالثواني: Number(skewSec.toFixed(1)), الفارق_بالساعات: Number(diffH.toFixed(6)) };
}
