function normalizeBaseUrl(raw = "") {
  return String(raw || "").trim().replace(/\/+$/, "");
}

export function resolveGocUiBase({ env = process.env } = {}) {
  const source = env && typeof env === "object" ? env : {};
  const publicBase = normalizeBaseUrl(source.GOC_UI_PUBLIC_BASE || "");
  const internalBase = normalizeBaseUrl(source.GOC_UI_BASE || "");
  return publicBase || internalBase;
}

export function isHttpsLink(url = "") {
  return /^https:\/\//i.test(String(url || "").trim());
}

export function isTelegramWebAppHttpsError(error = null) {
  const code = String(error?.code || "").trim().toUpperCase();
  const desc = String(error?.response?.body?.description || "");
  const msg = String(error?.message || error || "");
  const merged = `${desc}\n${msg}`;
  return code === "ETELEGRAM" && /Only HTTPS links are allowed/i.test(merged);
}

export function buildGocUiLink({
  threadId,
  ctxId,
  token = "",
  base = "",
  withToken = null,
  page = "",
  linkMode = "telegram_auth",
} = {}) {
  const resolvedBase = normalizeBaseUrl(base || resolveGocUiBase());
  if (!resolvedBase) throw new Error("Missing GOC_UI_BASE (or GOC_UI_PUBLIC_BASE)");
  const cleanPage = String(page || "").trim().toLowerCase();
  const cleanThreadId = String(threadId || "").trim();
  const cleanCtxId = String(ctxId || "").trim();
  let query = "";
  if (cleanPage === "agents") {
    const agentsBase = `${resolvedBase}/agents`;
    const qs = new URLSearchParams();
    if (cleanThreadId) qs.set("thread", cleanThreadId);
    if (cleanCtxId) qs.set("ctx", cleanCtxId);
    query = qs.toString() ? `${agentsBase}?${qs.toString()}` : agentsBase;
  } else {
    const baseForQuery = resolvedBase.endsWith("/") ? resolvedBase : `${resolvedBase}/`;
    const qs = new URLSearchParams();
    qs.set("thread", cleanThreadId);
    qs.set("ctx", cleanCtxId);
    query = `${baseForQuery}?${qs.toString()}`;
  }

  const useToken = typeof withToken === "boolean"
    ? withToken
    : String(linkMode || "").trim().toLowerCase() === "bearer_token";
  if (useToken && token) {
    return `${query}#token=${encodeURIComponent(String(token || ""))}`;
  }
  return query;
}

export async function buildContextLinks(client, {
  threadId,
  ctxId,
  page = "",
  linkMode = "telegram_auth",
  uiTokenTtlSec = 21600,
  browserTokenTtlSec = 3600,
  base = "",
} = {}) {
  const resolvedBase = normalizeBaseUrl(base || resolveGocUiBase());
  if (!resolvedBase) throw new Error("Missing GOC_UI_BASE (or GOC_UI_PUBLIC_BASE)");
  const mode = String(linkMode || "").trim().toLowerCase();
  let miniAppToken = null;
  if (mode === "bearer_token") {
    miniAppToken = await client.mintUiToken(uiTokenTtlSec);
  }
  const browserToken = await client.mintUiToken(browserTokenTtlSec);

  const miniAppLink = buildGocUiLink({
    threadId,
    ctxId,
    token: miniAppToken?.token || "",
    base: resolvedBase,
    page,
    withToken: mode === "bearer_token",
    linkMode: mode,
  });
  const browserLink = buildGocUiLink({
    threadId,
    ctxId,
    token: browserToken?.token || "",
    base: resolvedBase,
    page,
    withToken: true,
    linkMode: mode,
  });
  return {
    miniAppLink,
    browserLink,
    miniAppTokenExp: miniAppToken?.exp || null,
    browserTokenExp: browserToken?.exp || null,
    miniAppSupported: isHttpsLink(miniAppLink),
  };
}

export function buildContextLinkButtons({
  miniAppLink = "",
  browserLink = "",
} = {}) {
  const hasMiniApp = isHttpsLink(miniAppLink);
  const buttons = [];
  if (hasMiniApp) {
    buttons.push({ text: "Open GoC (Mini App)", web_app: { url: miniAppLink } });
  }
  if (browserLink) {
    buttons.push({ text: "Open GoC (Browser)", url: browserLink });
  } else if (miniAppLink) {
    buttons.push({ text: "Open GoC (Browser)", url: miniAppLink });
  }
  return {
    hasMiniApp,
    buttons,
  };
}
