import { clip } from "../../textutil.js";

export function buildGeminiRetryNoticeText({ retryCount = 0, maxRetries = 0, agentId = "" } = {}) {
  const cleanRetry = Math.max(1, Math.floor(Number(retryCount) || 1));
  const cleanMax = Math.max(cleanRetry, Math.floor(Number(maxRetries) || cleanRetry));
  const suffix = String(agentId || "").trim().toLowerCase();
  return suffix
    ? `⏳ Gemini 혼잡으로 재시도 중 (${cleanRetry}/${cleanMax})… (@${suffix})`
    : `⏳ Gemini 혼잡으로 재시도 중 (${cleanRetry}/${cleanMax})…`;
}

export function buildGeminiModelSwitchNoticeText({ toModel = "", agentId = "" } = {}) {
  const modelText = clip(String(toModel || "auto"), 120);
  const suffix = String(agentId || "").trim().toLowerCase();
  return suffix
    ? `🔁 혼잡 회피를 위해 모델을 ${modelText}로 전환했어요. (@${suffix})`
    : `🔁 혼잡 회피를 위해 모델을 ${modelText}로 전환했어요.`;
}

export function buildGeminiGiveUpNoticeText({ reason = "", agentId = "" } = {}) {
  const suffix = String(agentId || "").trim().toLowerCase();
  const cleanReason = String(reason || "").trim().toLowerCase();
  const base = cleanReason === "model_not_found"
    ? "❌ Gemini 모델을 찾을 수 없어요(모델명/권한 문제).\nworkspace 설정(.gemini/settings.json)의 model.name을 제거하거나,\nGEMINI_WORKSPACE_MODEL/GEMINI_MODEL_PRIMARY를 사용 가능한 모델로 설정하세요.\n(gemini CLI에서 /model로 확인 가능)"
    : "❌ Gemini 혼잡이 지속돼요. 잠시 후 재시도하거나 모델/도구를 바꿀게요.";
  return suffix ? `${base} (@${suffix})` : base;
}

