export type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "invalid_json" | "too_large" };

export type BoundedTextResult =
  | { ok: true; value: string }
  | { ok: false; reason: "invalid_text" | "too_large" };

export async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<BoundedTextResult> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, reason: "too_large" };
  }

  if (!request.body) return { ok: false, reason: "invalid_text" };

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("request_too_large");
        return { ok: false, reason: "too_large" };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, value: text };
  } catch {
    return { ok: false, reason: "invalid_text" };
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<BoundedJsonResult> {
  const bounded = await readBoundedText(request, maxBytes);
  if (!bounded.ok) {
    return { ok: false, reason: bounded.reason === "too_large" ? "too_large" : "invalid_json" };
  }
  try {
    return { ok: true, value: JSON.parse(bounded.value) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}
