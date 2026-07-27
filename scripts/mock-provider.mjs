#!/usr/bin/env node
/**
 * مزوّد SSE وهمي — للاختبار المحلي فقط (v0.7.0 RC3).
 *
 *   node scripts/mock-provider.mjs <port> <chunkIntervalMs>
 *
 * يرسل الترويسات فورًا ثم دفعات صغيرة على فترات ثابتة، **ولا يغلق الاتصال
 * أبدًا** — فيتجاوز أي سقف كلي بينما يبقى دون مهلة الخمول.
 *
 * النص المُرسَل جزئي غير مكتمل عمدًا (لا ينتهي بعلامة نهاية جملة)، كي يكون
 * القرار الصحيح عند نفاد الوقت هو رسالة المهلة لا الإنهاء الصامت.
 *
 * يطبع سطرًا عند إغلاق العميل للاتصال — دليل عمل AbortController.
 */
import http from "node:http";

const port = Number(process.argv[2] ?? 5599);
const intervalMs = Number(process.argv[3] ?? 100);

let openConnections = 0;
let abortedByClient = 0;

const chunk = (text) =>
  `data: ${JSON.stringify({ model: "mock/endless", choices: [{ delta: { content: text } }] })}\n\n`;

const server = http.createServer((req, res) => {
  openConnections++;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // نص جزئي لا ينتهي بجملة مكتملة
  res.write(chunk("هذا رد جزئي من مزوّد وهمي لا ينتهي"));

  const t = setInterval(() => {
    try {
      res.write(chunk(" و"));
    } catch {
      clearInterval(t);
    }
  }, intervalMs);

  const done = () => {
    clearInterval(t);
    openConnections--;
    abortedByClient++;
    console.log(
      `[mock] client_aborted=true open=${openConnections} total_aborts=${abortedByClient}`,
    );
  };
  req.on("close", done);
  req.on("aborted", done);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock] listening port=${port} interval_ms=${intervalMs}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
