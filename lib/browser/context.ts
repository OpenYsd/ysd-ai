export type BrowserProviderContext = {
  mode: "chat" | "page" | "selection";
  message: string;
  context?: {
    pageOrigin?: string;
    pageText?: string;
    selectedText?: string;
  };
};

export function buildUserContent(body: BrowserProviderContext) {
  if (body.mode === "selection") {
    return `Mode: selection\nOrigin: ${sanitizeOrigin(body.context?.pageOrigin)}\nSelected text:\n${body.context?.selectedText ?? ""}\n\nUser request:\n${body.message}`;
  }
  if (body.mode === "page") {
    return `Mode: page\nOrigin: ${sanitizeOrigin(body.context?.pageOrigin)}\nPage text excerpt:\n${body.context?.pageText ?? ""}\n\nUser request:\n${body.message}`;
  }
  return `Mode: chat\nUser request:\n${body.message}`;
}

export function sanitizeOrigin(origin?: string) {
  if (!origin) return "not-sent";
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "invalid";
    if (url.username || url.password) return "invalid";
    return `${url.protocol}//${url.host}`;
  } catch {
    return "invalid";
  }
}
