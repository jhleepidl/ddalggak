function clean(value = '', { maxLen = 4000 } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}
function countMatches(text = '', re) { const m = String(text || '').match(re); return m ? m.length : 0; }

export function isLikelyInternalRuntimeText(text = '') {
  const src = clean(text, { maxLen: 6000 });
  if (!src) return false;
  const strongMarkers = [
    /\[LANGUAGE POLICY\]/i,
    /\[KNOWLEDGE BASE CONTRACT\]/i,
    /\[ADAPTIVE MEMORY TOPOLOGY\]/i,
    /\[ASSIGNED TASK\]/i,
    /\[AVAILABLE MEMORY/i,
    /\[ROOM CONTEXT SNAPSHOT\]/i,
    /OUTPUT CONTRACT/i,
    /CONTROL PLANE TASK:/i,
    /profile=.+\bKB\)/i,
  ];
  const markerCount = strongMarkers.reduce((n, re) => n + (re.test(src) ? 1 : 0), 0);
  if (markerCount >= 1 && src.length > 220) return true;
  return markerCount >= 2;
}
export const SUPPORTED_SURFACE_LOCALES = ['en', 'ko'];
export const DEFAULT_INTERNAL_LANGUAGE = 'en';
export function normalizeLocale(value = '', fallback = 'ko') {
  const raw = String(value || '').trim().toLowerCase().replace('_', '-');
  if (/^(en|en-us|en-gb|english)$/.test(raw)) return 'en';
  if (/^(ko|ko-kr|korean|한국어|한글)$/.test(raw)) return 'ko';
  const f = String(fallback || '').trim().toLowerCase();
  return SUPPORTED_SURFACE_LOCALES.includes(f) ? f : 'ko';
}
export function detectExplicitLocaleRequest(text = '', fallback = '') {
  const src = clean(text, { maxLen: 1200 }).toLowerCase();
  if (!src) return fallback ? normalizeLocale(fallback) : '';
  if (/\b(reply|respond|answer|write|speak)\s+(in\s+)?(english|en)\b/.test(src) || /영어로\s*(답|대답|작성|말|응답)/.test(src)) return 'en';
  if (/\b(reply|respond|answer|write|speak)\s+(in\s+)?(korean|ko)\b/.test(src) || /한국어로|한글로/.test(src)) return 'ko';
  return fallback ? normalizeLocale(fallback) : '';
}
export function detectTextLanguage(text = '', fallback = 'ko') {
  const src = clean(text, { maxLen: 8000 });
  if (!src) return normalizeLocale(fallback);
  const explicit = detectExplicitLocaleRequest(src, '');
  if (explicit) return explicit;
  const hangul = countMatches(src, /[가-힣]/g);
  const latin = countMatches(src, /[A-Za-z]/g);
  if (hangul >= 2 && hangul >= Math.max(2, latin * 0.15)) return 'ko';
  if (latin >= 8 && hangul === 0) return 'en';
  if (latin >= 12 && latin > hangul * 3) return 'en';
  return normalizeLocale(fallback);
}
export function resolveUserSurfaceLocale({ message = '', request = '', session = null, runtime = null, fallback = '' } = {}) {
  const envFallback = normalizeLocale(process.env.DEFAULT_USER_LOCALE || process.env.USER_SURFACE_LOCALE || fallback || 'ko', 'ko');
  const surfaceText = [message, request].filter(Boolean).join('\n');
  const runtimeLocale = runtime?.user_surface_locale || runtime?.userSurfaceLocale || runtime?.locale || runtime?.runtimeSessionState?.user_surface_locale || runtime?.runtime_session_state?.user_surface_locale;
  const sessionLocale = session?.user_surface_locale || session?.userSurfaceLocale || session?.locale;

  // Telegram/user surface language should be inferred from raw user text, not from
  // generated runtime prompts. Workbench prompts often contain English control
  // contracts such as [LANGUAGE POLICY] or [KNOWLEDGE BASE CONTRACT]; treating
  // those as the user request was the main cause of occasional English replies
  // in Korean chats. When the candidate text looks runtime-authored, trust the
  // persisted room/session locale or the Korean default instead.
  const internalRuntimeText = isLikelyInternalRuntimeText(surfaceText);
  if (!internalRuntimeText) {
    const explicit = detectExplicitLocaleRequest(surfaceText, '');
    if (explicit) return explicit;
  }
  if (runtimeLocale) return normalizeLocale(runtimeLocale, envFallback);
  if (sessionLocale) return normalizeLocale(sessionLocale, envFallback);
  if (internalRuntimeText) return envFallback;
  return detectTextLanguage(surfaceText, envFallback);
}
export function localeDisplayName(locale = 'ko') { return normalizeLocale(locale) === 'en' ? 'English' : 'Korean'; }
export function userSurfaceLanguageDirective(locale = 'ko', { terse = false } = {}) {
  const l = normalizeLocale(locale);
  if (l === 'en') return terse ? 'Respond in natural English.' : 'Write the user-facing response in natural English, matching the user’s tone. This is a hard requirement for the final user-visible answer. Do not switch to Korean unless the user asks.';
  return terse ? 'Respond in natural Korean.' : 'Write the user-facing response in natural Korean, matching the user’s tone. This is a hard requirement for the final user-visible answer. Do not switch to English unless the user asks.';
}
export function internalLanguagePolicyBlock({ surfaceLocale = 'ko', preserveOriginal = true } = {}) {
  return [
    '[LANGUAGE POLICY]',
    '- Internal operating language: English.',
    `- User-facing surface language for this turn: ${localeDisplayName(surfaceLocale)} (${normalizeLocale(surfaceLocale)}).`,
    `- ${userSurfaceLanguageDirective(surfaceLocale)}`,
    preserveOriginal ? '- Preserve raw user-provided memory/rules/quotes in their original language; add English canonical projections separately when needed.' : '',
    '- Skill, role, team, policy, schema, and execution contracts should use English canonical fields.',
  ].filter(Boolean).join('\n');
}
export function buildLocalizedSurfaceLabels(locale = 'ko') {
  if (normalizeLocale(locale) === 'en') return { finalAnswer: 'Final answer:', userRequest: 'User request:', rules: 'Rules:', task: 'Task:', outputGuide: 'Output guide:', conciseDirectAnswer: 'Answer the latest user request directly and concisely.' };
  return { finalAnswer: '최종 답변:', userRequest: '사용자 요청:', rules: '규칙:', task: '작업:', outputGuide: '출력 지침:', conciseDirectAnswer: '사용자의 최신 요청에 직접 간결하게 답하라.' };
}
export function normalizeLanguageMetadata({ text = '', displayText = '', locale = '', canonicalTextEn = '', source = '' } = {}) {
  const originalText = clean(text || displayText, { maxLen: 12000 });
  const originalLanguage = normalizeLocale(locale || detectTextLanguage(originalText || displayText, 'ko'));
  const canonical = clean(canonicalTextEn, { maxLen: 12000 });
  return {
    original_language: originalLanguage,
    source_original_language: originalLanguage,
    source_original_text: originalText,
    display_text: clean(displayText || originalText, { maxLen: 12000 }),
    canonical_language: 'en',
    canonical_text_en: originalLanguage === 'en' ? (canonical || originalText) : canonical,
    canonical_projection_status: originalLanguage === 'en' || canonical ? 'ready' : 'pending_translation',
    language_source: clean(source, { maxLen: 80 }) || 'runtime_language_policy',
  };
}
