#!/usr/bin/env node
/**
 * مزوّد SSE وهمي داخل حاوية — للتحقق التشغيلي فقط (v0.7.0 RC4 gate).
 *   node mock-provider-net.mjs <port> <chunkIntervalMs>
 *
 * يرسل الترويسات فورًا، ثم قطعة **غير مكتملة** كل فترة، ولا يغلق الاتصال
 * أبدًا. يسجّل أرقامًا فقط — لا prompt ولا ترويسات حساسة.
 *
 * /stats يُرجع العدّادات لقراءتها من خارج الحاوية.
 */
import http from "node:http";

const port = Number(process.argv[2] ?? 8080);
const intervalMs = Number(process.argv[3] ?? 250);

const stats = {
  connection_opened_at: null,
  chunks_sent: 0,
  client_aborted: 0,
  socket_closed_at: null,
  active_sockets: 0,
};

const chunk = (t) =>
  `data: ${JSON.stringify({ model: "mock/endless", choices: [{ delta: { content: t } }] })}\n\n`;

const server = http.createServer((req, res) => {
  if (req.url === "/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stats));
    return;
  }

  stats.active_sockets++;
  if (!stats.connection_opened_at) stats.connection_opened_at = Date.now();
  console.log(JSON.stringify({ ev: "open", active: stats.active_sockets }));

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // نص جزئي لا ينتهي بجملة مكتملة — فالقرار الصحيح عند المهلة هو رسالة المهلة
  res.write(chunk("رد جزئي من مزوّد وهمي لا ينتهي"));
  stats.chunks_sent++;

  const t = setInterval(() => {
    try {
      res.write(chunk(" و"));
      stats.chunks_sent++;
    } catch {
      clearInterval(t);
    }
  }, intervalMs);

  let ended = false;
  const onEnd = (why) => {
    if (ended) return;
    ended = true;
    clearInterval(t);
    stats.active_sockets = Math.max(0, stats.active_sockets - 1);
    stats.client_aborted++;
    stats.socket_closed_at = Date.now();
    console.log(
      JSON.stringify({
        ev: "closed",
        why,
        chunks_sent: stats.chunks_sent,
        active: stats.active_sockets,
        open_ms: stats.socket_closed_at - stats.connection_opened_at,
      }),
    );
  };
  req.on("close", () => onEnd("close"));
  req.on("aborted", () => onEnd("aborted"));
  res.on("close", () => onEnd("res_close"));
});

server.listen(port, "0.0.0.0", () =>
  console.log(JSON.stringify({ ev: "listening", port, intervalMs })),
);
