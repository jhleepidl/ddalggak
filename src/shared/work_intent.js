function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeLower(value = '') {
  return normalizeText(value).toLowerCase();
}

export const CODE_REQUEST_TERMS = [
  'code', 'codex', 'implement', 'fix', 'bug', 'patch', 'refactor', 'notebook', 'script',
  'repository', 'repo', 'workspace', 'python', 'javascript', 'typescript', 'sql', 'bash',
  'shell', 'commit', 'pull request', 'web service', 'web app', 'frontend', 'backend',
  'full stack', 'fullstack', 'api', 'server', 'client', 'ui', 'ux', 'react', 'next.js',
  'nextjs', 'node', 'express', 'fastapi', 'flask', 'django', 'spring', '코드', '구현', '코딩', '코덱스',
  '리팩터', '패치', '스크립트', '파이썬', '자바스크립트', '타입스크립트',
  '레포', '웹 서비스', '웹앱', '프론트엔드', '백엔드', '서버', '클라이언트', '서비스 개발',
];

export const CODE_ARTIFACT_TERMS = [
  'notebook', 'jupyter', 'ipynb', 'codex', 'script', 'patch', 'commit', 'workspace', 'repo',
  'repository', 'python', 'javascript', 'typescript', 'sql', 'bash', 'shell', 'pr',
  'pull request', 'web service', 'web app', 'frontend', 'backend', 'api', 'server', 'react',
  'nextjs', 'node', 'express', 'fastapi', 'flask', 'django', '주피터', '노트북', '스크립트',
  '패치', '커밋', '코딩', '파일', '문서', '산출물', '결과물', '코덱스', '파이썬', '자바스크립트', '타입스크립트', '레포', '웹 서비스', '웹앱',
  '프론트엔드', '백엔드', '서버', 'api', '서비스 개발',
];

const IMPLEMENTATION_LIKE_RE = /(codex|코덱스|implement|patch|refactor|code|코딩|repo|repository|workspace|script|prototype|web\s*service|web\s*app|frontend|backend|api|server|client|full[- ]?stack|react|next(?:\.js)?|node|express|fastapi|flask|django|spring|서비스\s*이름|서비스\s*구현|프로그램\s*개발|앱\s*개발|코드|notebook|jupyter|주피터|python|스크립트|웹\s*서비스|웹앱|프론트엔드|백엔드|서버|클라이언트|서비스\s*개발)/i;
const KOREAN_IMPLEMENTATION_ACTION_RE = /(?:구현|개발)(?:해|하|을|해서|하고|해줘|해주세요|해야|필요)/i;
const WORKSPACE_DELIVERY_RE = /(파일|문서|노트북|리포트|보고서|산출물|결과물|압축본|압축\s*파일).{0,30}(만들|생성|작성|저장|전달|보내|줘)|\.[a-z0-9]{1,8}\b|create.{0,50}(file|document|report|artifact|deliverable)|generate.{0,50}(file|document|report|artifact|deliverable)|save.{0,50}(file|document|artifact)|deliverable|artifact|workspace/i;
const SOFTWARE_DELIVERY_RE = /(web\s*service|web\s*app|frontend|backend|api|server|client|full[- ]?stack|react|next(?:\.js)?|node|express|fastapi|flask|django|spring|웹\s*서비스|웹앱|프론트엔드|백엔드|서버|클라이언트|서비스\s*개발)/i;
const BUILDER_ROLE_RE = /(^|[^a-z])(builder|coder|developer|implementer|frontend|backend|fullstack|engineer)([^a-z]|$)|구현|코더|개발자|빌더/i;
const REVIEWER_ROLE_RE = /(^|[^a-z])(reviewer|review|critic|verifier|quality|qa)([^a-z]|$)|리뷰어|검토|검수|비평|품질/i;
const SYNTHESIZER_ROLE_RE = /(^|[^a-z])(synthesizer|synth|summarizer|summary|writer|delivery)([^a-z]|$)|요약|정리|합성|전달/i;
const OPERATOR_ROLE_RE = /(^|[^a-z])(operator|coordinator|orchestrator|router|manager)([^a-z]|$)|운영|조정|오퍼레이터/i;
const RESEARCHER_ROLE_RE = /(^|[^a-z])(researcher|scout|analyst|investigator|planner|research)([^a-z]|$)|조사|연구|분석|스카우트/i;

export function hasImplementationLikeIntent(text = '') {
  const value = normalizeText(text);
  return IMPLEMENTATION_LIKE_RE.test(value) || KOREAN_IMPLEMENTATION_ACTION_RE.test(value);
}

export function hasWorkspaceDeliveryIntent(text = '') {
  return WORKSPACE_DELIVERY_RE.test(normalizeText(text)) || hasImplementationLikeIntent(text);
}

export function hasSoftwareDeliveryIntent(text = '') {
  return SOFTWARE_DELIVERY_RE.test(normalizeText(text));
}

export function inferExecutionRoleFromText(text = '', { fallback = '' } = {}) {
  const value = normalizeLower(text);
  if (!value) return normalizeLower(fallback);
  if (BUILDER_ROLE_RE.test(value)) return 'builder';
  if (REVIEWER_ROLE_RE.test(value)) return 'reviewer';
  if (SYNTHESIZER_ROLE_RE.test(value)) return 'synthesizer';
  if (OPERATOR_ROLE_RE.test(value)) return 'operator';
  if (RESEARCHER_ROLE_RE.test(value)) return 'researcher';
  return normalizeLower(fallback);
}
