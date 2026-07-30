/**
 * اختبار حارس الشبكة نفسه.
 *
 * حارسٌ لا يُطلق أبدًا لا يُثبت شيئًا: مجموعةٌ خضراء بلا محاولة خارجية واحدة
 * تبدو كما لو أن الحارس يعمل، وتبدو كذلك تمامًا لو كان معطّلًا بالكامل. هذه
 * الاختبارات تُطلقه عمدًا لتثبت أنه يحجب فعلًا، ويسمح بالمحلي، ولا يسرّب
 * تفاصيل في رسالته.
 *
 * لا اتصال فعلي يقع هنا: الحارس يرمي **قبل** أي إرسال.
 */
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: http.Server;
let localUrl = "";

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("محلي");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  localUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("★ حارس الشبكة — لا اتصال خارجي في الاختبارات", () => {
  it("★ يحجب fetch إلى مضيف خارجي", async () => {
    await expect(fetch("https://openrouter.ai/api/v1/chat/completions")).rejects.toThrow(
      /حارس الشبكة/,
    );
  });

  it("★ يحجب أي نطاق خارجي آخر لا openrouter وحده", async () => {
    await expect(fetch("https://example.com/anything")).rejects.toThrow(/حارس الشبكة/);
  });

  it("★ الرسالة تذكر اسم المضيف فقط — لا مسار ولا query", async () => {
    let msg = "";
    try {
      await fetch("https://openrouter.ai/api/v1/chat/completions?key=SHOULD_NOT_APPEAR");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("host=openrouter.ai");
    expect(msg).not.toContain("SHOULD_NOT_APPEAR");
    expect(msg).not.toContain("/api/v1/chat/completions");
    expect(msg).not.toContain("?");
  });

  it("★ يسمح بـ127.0.0.1", async () => {
    const res = await fetch(localUrl);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("محلي");
  });

  it("★ يسمح بـlocalhost", async () => {
    const res = await fetch(localUrl.replace("127.0.0.1", "localhost"));
    expect(res.status).toBe(200);
  });

  // الطبقة الثانية: أي مسار لا يمرّ بـfetch — أو اختبار يستبدل fetch بstub
  // خاص به فيتجاوز الطبقة الأولى — يبقى محجوبًا عند المقبس.
  it("★ يحجب المقبس الخام إلى مضيف خارجي", () => {
    expect(() => net.connect({ host: "openrouter.ai", port: 443 })).toThrow(/حارس الشبكة/);
  });

  it("★ يسمح بالمقبس الخام إلى 127.0.0.1", async () => {
    const port = (server.address() as AddressInfo).port;
    const sock = net.connect({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", resolve);
      sock.once("error", reject);
    });
    expect(sock.destroyed).toBe(false);
    sock.destroy();
  });
});
