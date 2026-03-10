const TEAM_CONFIGURATION_PATTERNS = [
  /팀\s*구성/,
  /팀\s*재구성/,
  /팀\s*다시\s*짜/,
  /에이전트\s*팀/,
  /agent\s*team/,
  /reconfigure\s+team/,
  /configure\s+team/,
  /team\s*setup/,
  /team\s*composition/,
  /스레드\s*팀/,
  /멤버\s*재정리/,
];

const WORK_EXECUTION_PATTERNS = [
  /만들어/,
  /작성/,
  /구현/,
  /수정/,
  /분석/,
  /조사/,
  /리서치/,
  /코드/,
  /실행/,
  /과제/,
  /research/,
  /analy/,
  /implement/,
  /build/,
  /code/,
  /fix/,
  /run/,
  /task/,
];

export function isExplicitTeamConfigurationIntentMessage(taskText = "") {
  const text = String(taskText || "").trim().toLowerCase();
  if (!text) return false;
  return TEAM_CONFIGURATION_PATTERNS.some((pattern) => pattern.test(text));
}

export function isLikelyWorkExecutionIntentMessage(taskText = "") {
  const text = String(taskText || "").trim().toLowerCase();
  if (!text) return false;
  return WORK_EXECUTION_PATTERNS.some((pattern) => pattern.test(text));
}

function normalizeForceMode(raw = "") {
  return String(raw || "").trim().toLowerCase() === "work" ? "work" : "normal";
}

export function isTeamSetupOnlyRequest(taskText = "", {
  forceMode = "normal",
  workLikeHint = false,
} = {}) {
  if (normalizeForceMode(forceMode) === "work") return false;
  const teamIntent = isExplicitTeamConfigurationIntentMessage(taskText);
  if (!teamIntent) return false;
  if (workLikeHint === true) return false;
  return !isLikelyWorkExecutionIntentMessage(taskText);
}
