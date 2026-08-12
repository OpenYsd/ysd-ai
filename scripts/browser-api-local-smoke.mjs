import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const baseUrl = "http://127.0.0.1:3030";
const npmScript = process.env.YSD_BROWSER_SMOKE_SERVER === "start" ? "start" : "dev";
const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm";
const args = process.platform === "win32"
  ? ["/d", "/s", "/c", `npm run ${npmScript} -- --hostname 127.0.0.1 --port 3030`]
  : ["run", npmScript, "--", "--hostname", "127.0.0.1", "--port", "3030"];

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function waitForHealth() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/browser/v1/capabilities`, { signal: AbortSignal.timeout(2000) });
      if (response.status === 200) return true;
    } catch {
      // keep polling until the short smoke deadline
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function jsonFetch(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { response, body, text };
}

function print(line) {
  process.stdout.write(`${line}\n`);
}

const child = spawn(command, args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    APP_ORIGIN: baseUrl,
    YSD_BROWSER_TOKEN_SECRET: randomBytes(32).toString("hex"),
    // Keep this smoke from touching any real Supabase project configured in .env.local.
    SUPABASE_SERVICE_ROLE_KEY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let childLog = "";
const appendLog = (chunk) => {
  childLog = `${childLog}${chunk.toString("utf8")}`.slice(-4000);
};
child.stdout?.on("data", appendLog);
child.stderr?.on("data", appendLog);

try {
  const ready = await waitForHealth();
  print(`ready=${ready}`);
  if (!ready) {
    print("serverLogTail=" + childLog.replace(/\r?\n/g, " | ").replace(/(token|secret|key)=([^;\s]+)/gi, "$1=[redacted]"));
    process.exitCode = 1;
  }
  else {
    const health = await jsonFetch("/api/health");
    print(`health=${health.response.status}`);

    const capabilities = await jsonFetch("/api/browser/v1/capabilities");
    const capabilitiesText = capabilities.text.toLowerCase();
    print([
      `capabilities=${capabilities.response.status}`,
      `apiVersion=${capabilities.body?.apiVersion}`,
      `streaming=${capabilities.body?.streaming}`,
      `serviceStatus=${capabilities.body?.serviceStatus}`,
      `hasSecretField=${/(secret|service_role|openrouter|anthropic|api_key)/i.test(capabilitiesText)}`,
    ].join(";"));

    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash("sha256").update(verifier, "ascii").digest());
    const state = base64url(randomBytes(24));
    const device = await jsonFetch("/api/browser/v1/auth/device", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: "ysd-browser",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      }),
    });
    print([
      `device=${device.response.status}`,
      `deviceCodeLength=${device.body?.device_code?.length ?? 0}`,
      `userCodeShape=${/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(device.body?.user_code ?? "")}`,
      `verificationHost=${new URL(device.body?.verification_uri ?? baseUrl).host}`,
    ].join(";"));

    const tokenPending = await jsonFetch("/api/browser/v1/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "ysd-browser",
        device_code: device.body?.device_code,
        code_verifier: verifier,
        state,
      }),
    });
    const tokenPreApprovalOk = tokenPending.response.status === 428;
    const tokenPreApprovalLocalFallbackLimitation =
      tokenPending.response.status === 400 && tokenPending.body?.code === "invalid_code";
    print([
      `tokenPending=${tokenPending.response.status}`,
      `code=${tokenPending.body?.code}`,
      `preApprovalOk=${tokenPreApprovalOk}`,
      `localFallbackLimitation=${tokenPreApprovalLocalFallbackLimitation}`,
    ].join(";"));

    if (
      capabilities.response.status !== 200 ||
      capabilities.body?.apiVersion !== "1" ||
      capabilities.body?.streaming !== true ||
      capabilities.body?.serviceStatus !== "available" ||
      /(secret|service_role|openrouter|anthropic|api_key)/i.test(capabilitiesText) ||
      device.response.status !== 200 ||
      !device.body?.device_code ||
      (!tokenPreApprovalOk && !tokenPreApprovalLocalFallbackLimitation)
    ) {
      process.exitCode = 1;
    }
  }
} finally {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
}
