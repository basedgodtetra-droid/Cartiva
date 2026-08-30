import { getKrogerAuthClient, KrogerAuthError } from "@/lib/kroger-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]!);
}

function page(title: string, message: string, success: boolean, status = 200) {
  const color = success ? "#258b34" : "#b42318";
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${safeTitle}</title><style>body{margin:0;background:#f6f8f2;color:#10271a;font:600 18px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}.card{background:#fff;border:1px solid #d8e2d5;border-radius:24px;box-shadow:0 20px 60px #173c2222;max-width:540px;padding:42px;text-align:center}h1{font-size:32px;margin:0 0 12px;color:${color}}p{font-weight:450;line-height:1.55;margin:0}</style></head>
<body><main class="card"><h1>${safeTitle}</h1><p>${safeMessage}</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  if (parameters.has("error")) {
    return page(
      "Kroger wasn't connected",
      "Kroger authorization was cancelled or declined. You can close this tab and try again from Cartiva.",
      false,
      400,
    );
  }
  const code = parameters.get("code") ?? "";
  const state = parameters.get("state") ?? "";
  if (code.length < 1 || code.length > 4_096 || !/^[A-Za-z0-9_-]{32}$/.test(state)) {
    return page(
      "Kroger wasn't connected",
      "This connection response was incomplete or invalid. Close this tab and start again from Cartiva.",
      false,
      400,
    );
  }
  try {
    await getKrogerAuthClient().exchangeAuthorizationCode(code, state);
    return page(
      "Kroger connected",
      "Cartiva can now add verified products to your Kroger-family cart. You can close this tab and return to Cartiva.",
      true,
    );
  } catch (error) {
    const status = error instanceof KrogerAuthError ? error.status : 500;
    return page(
      "Kroger wasn't connected",
      error instanceof KrogerAuthError && error.code === "oauth_state"
        ? "This connection request expired or could not be verified. Close this tab and start again from Cartiva."
        : "Kroger could not finish the connection. Close this tab and try again from Cartiva.",
      false,
      status,
    );
  }
}
