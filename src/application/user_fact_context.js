import fs from 'node:fs';
import path from 'node:path';

const USER_FACTS_FILE = 'user_facts.jsonl';
const MAX_VALUE_LEN = 220;

function cleanText(value = '') {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function safeMkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function factsPath(runDir = '') {
  return path.join(String(runDir || '').trim(), USER_FACTS_FILE);
}

function normalizeMenu(value = '') {
  return cleanText(value)
    .replace(/^(?:으로|은|는|을|를|엔|에는|에)\s*/g, '')
    .replace(/(?:을|를)?\s*(?:먹었(?:고|어|다)?|주문했(?:어|다)?|시켜\s*먹었(?:어|다)?|배달시켜\s*먹었(?:어|다)?|먹고\s*싶(?:어|다)?).*$/i, '')
    .replace(/[.?!]+$/g, '')
    .trim()
    .slice(0, MAX_VALUE_LEN);
}

function normalizeRelativeDay(value = '') {
  const text = cleanText(value).toLowerCase();
  if (/그제|그저께/.test(text)) return 'day_before_yesterday';
  if (/어제/.test(text)) return 'yesterday';
  if (/내일/.test(text)) return 'tomorrow';
  if (/오늘/.test(text)) return 'today';
  return '';
}

function normalizeMealSlot(value = '') {
  const text = cleanText(value).toLowerCase();
  if (/아침|조식/.test(text)) return 'breakfast';
  if (/점심|중식|첫\s*끼니|첫끼니/.test(text)) return 'lunch';
  if (/저녁|석식|디너/.test(text)) return 'dinner';
  if (/오전\s*\d{1,2}시/.test(text)) return 'breakfast';
  if (/오후\s*(?:12|1|2|3)시/.test(text)) return 'lunch';
  if (/오후\s*(?:4|5|6|7|8|9|10|11)시|\b(?:18|19|20|21|22|23)시/.test(text)) return 'dinner';
  return '';
}

function inferFactKey(fact = {}) {
  const type = String(fact.type || '').trim();
  if (type === 'profile') return `profile:${fact.field || 'unknown'}`;
  if (type === 'preference') return `preference:${fact.field || String(fact.value || '').slice(0, 40)}`;
  if (type === 'meal') return `meal:${fact.relative_day || 'unknown'}:${fact.meal_slot || fact.time_hint || 'unspecified'}`;
  if (type === 'retraction') return `retraction:${fact.scope || 'global'}:${String(fact.retracted || '').slice(0, 60)}`;
  return `${type || 'fact'}:${String(fact.field || fact.value || fact.scope || '').slice(0, 80)}`;
}

function makeFact(partial = {}, meta = {}) {
  const fact = {
    schema_version: 1,
    id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    type: String(partial.type || 'fact').trim(),
    status: String(partial.status || 'active').trim(),
    source: String(meta.source || partial.source || 'user_message').trim(),
    confidence: Number.isFinite(Number(partial.confidence)) ? Number(partial.confidence) : 1,
    created_at: String(meta.timestamp || partial.created_at || nowIso()),
    observed_text: cleanText(meta.observedText || partial.observed_text || '').slice(0, 500),
    ...partial,
  };
  fact.key = String(partial.key || inferFactKey(fact)).trim();
  return fact;
}

function appendFacts(runDir, facts = []) {
  const cleanFacts = (Array.isArray(facts) ? facts : []).filter((fact) => fact && typeof fact === 'object');
  if (!runDir || cleanFacts.length === 0) return 0;
  safeMkdir(runDir);
  const rows = cleanFacts.map((fact) => JSON.stringify(fact)).join('\n') + '\n';
  fs.appendFileSync(factsPath(runDir), rows, 'utf8');
  return cleanFacts.length;
}

export function readUserFacts(runDir = '') {
  const file = factsPath(runDir);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const row = line.trim();
    if (!row) continue;
    try {
      const obj = JSON.parse(row);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch {}
  }
  return out;
}

export function resolveActiveUserFacts(facts = []) {
  const byKey = new Map();
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (!fact || typeof fact !== 'object') continue;
    const key = String(fact.key || inferFactKey(fact)).trim();
    if (!key) continue;
    const prev = byKey.get(key);
    const ts = Date.parse(fact.created_at || '') || 0;
    const prevTs = Date.parse(prev?.created_at || '') || 0;
    if (!prev || ts >= prevTs) byKey.set(key, { ...fact, key });
  }
  return [...byKey.values()].filter((fact) => !['retracted', 'superseded', 'archived'].includes(String(fact.status || '').toLowerCase()));
}

function parseProfileFacts(text, meta) {
  const out = [];
  const height = text.match(/(?:키|신장)\s*(?:는|은)?\s*(\d{2,3})\s*cm/i);
  if (height) out.push(makeFact({ type: 'profile', field: 'height_cm', value: Number(height[1]), unit: 'cm' }, meta));
  const weight = text.match(/(?:몸무게|체중)\s*(?:는|은)?\s*(\d{2,3}(?:\.\d+)?)\s*kg/i);
  if (weight) out.push(makeFact({ type: 'profile', field: 'weight_kg', value: Number(weight[1]), unit: 'kg' }, meta));
  const age = text.match(/(?:나이|만)\s*(?:는|은)?\s*(?:만\s*)?(\d{1,3})\s*(?:살|세)/i);
  if (age) out.push(makeFact({ type: 'profile', field: 'age_years', value: Number(age[1]), unit: 'years' }, meta));
  if (/남성|남자|male/i.test(text)) out.push(makeFact({ type: 'profile', field: 'gender', value: 'male' }, meta));
  if (/여성|여자|female/i.test(text)) out.push(makeFact({ type: 'profile', field: 'gender', value: 'female' }, meta));
  if (/활동량[^.?!\n]{0,20}(적은|낮은|거의\s*없|sedentary)/i.test(text)) {
    out.push(makeFact({ type: 'profile', field: 'activity_level', value: 'low' }, meta));
  } else if (/활동량[^.?!\n]{0,20}(많은|높은|운동)/i.test(text)) {
    out.push(makeFact({ type: 'profile', field: 'activity_level', value: 'high' }, meta));
  }
  if (/느끼한\s*(?:건|것|음식)?\s*(?:별로\s*)?(?:안\s*)?좋아|느끼한.*싫/i.test(text)) {
    out.push(makeFact({ type: 'preference', field: 'dislikes', value: 'greasy_food' }, meta));
  }
  if (/다양한\s*영양소|영양소를\s*섭취|균형\s*잡힌/i.test(text)) {
    out.push(makeFact({ type: 'preference', field: 'likes', value: 'varied_nutrition' }, meta));
  }
  return out;
}

function parseNoIntakeFacts(text, meta) {
  const out = [];
  const re = /((?:그제|그저께|어제|오늘|내일)?\s*(?:아침|점심|저녁|첫\s*끼니|첫끼니)?)[^.!?\n]{0,30}(?:아무것도\s*)?(?:먹지\s*않았|안\s*먹었|굶었|거르었|걸렀)/gi;
  for (const match of text.matchAll(re)) {
    const phrase = cleanText(match[0]);
    const day = normalizeRelativeDay(phrase) || normalizeRelativeDay(text) || 'unknown';
    const slot = normalizeMealSlot(phrase) || normalizeMealSlot(text) || 'unspecified';
    out.push(makeFact({
      type: 'meal',
      relative_day: day,
      meal_slot: slot,
      value: 'no_intake',
      status: 'verified_no_intake',
      negative_labels: ['unknown_meal'],
      time_hint: phrase,
    }, { ...meta, observedText: phrase }));
  }
  return out;
}

function mealClauseCandidates(text) {
  const normalized = cleanText(text)
    .replace(/먹었고\s*/g, '먹었어. ')
    .replace(/주문했고\s*/g, '주문했어. ')
    .replace(/시켜먹었고\s*/g, '시켜먹었어. ');
  const clauses = normalized.split(/[.!?]\s*/).map((row) => row.trim()).filter(Boolean);
  const out = [];
  for (const clause of clauses) {
    if (/(먹었|주문했|시켜\s*먹|배달시켜\s*먹)/.test(clause)) out.push(clause);
  }
  return out;
}

function parseMealFacts(text, meta) {
  const out = [];
  for (const clause of mealClauseCandidates(text)) {
    if (/(먹지\s*않았|안\s*먹었|아무것도\s*먹지|굶었|걸렀)/.test(clause)) continue;
    const day = normalizeRelativeDay(clause) || normalizeRelativeDay(text) || 'unknown';
    const slot = normalizeMealSlot(clause) || normalizeMealSlot(text) || 'unspecified';
    let menu = '';
    const postTime = clause.match(/(?:그제|그저께|어제|오늘|내일)?\s*(?:아침|점심|저녁)?\s*(?:오전|오후)?\s*\d{1,2}시(?:엔|에는|에|쯤|경)?\s*([^.!?]+)$/i);
    const postSlot = clause.match(/(?:그제|그저께|어제|오늘|내일)\s*(?:아침|점심|저녁|첫\s*끼니|첫끼니)(?:엔|에는|에|은|는)?\s*([^.!?]+)$/i);
    const orderAt = clause.match(/(?:오늘|어제|내일)?\s*(?:아침|점심|저녁)?[^.!?]{0,20}(?:에서|의)\s*([^.!?]+?)(?:을|를)?\s*(?:주문했|배달시켜\s*먹|시켜\s*먹)/i);
    if (orderAt) menu = normalizeMenu(orderAt[1]);
    if (!menu && postTime) menu = normalizeMenu(postTime[1]);
    if (!menu && postSlot) menu = normalizeMenu(postSlot[1]);
    if (!menu) {
      const beforeVerb = clause.match(/([^.!?]{2,160}?)(?:을|를)?\s*(?:먹었|주문했|시켜\s*먹|배달시켜\s*먹)/i);
      menu = normalizeMenu(beforeVerb?.[1] || '');
    }
    menu = menu.replace(/^(?:그제|그저께|어제|오늘|내일)\s*(?:아침|점심|저녁)?\s*/g, '').trim();
    if (!menu || /내일.*추천|추천해/.test(menu)) continue;
    out.push(makeFact({
      type: 'meal',
      relative_day: day,
      meal_slot: slot,
      value: menu,
      status: 'active',
      time_hint: clause.match(/(?:오전|오후)?\s*\d{1,2}시(?:엔|에는|에|쯤|경)?/)?.[0] || '',
    }, { ...meta, observedText: clause }));
  }
  return out;
}

export function extractUserFactEvents(text = '', options = {}) {
  const clean = cleanText(text);
  if (!clean) return [];
  const meta = {
    source: options.source || 'user_message',
    timestamp: options.timestamp || nowIso(),
    observedText: clean,
  };
  return [
    ...parseProfileFacts(clean, meta),
    ...parseNoIntakeFacts(clean, meta),
    ...parseMealFacts(clean, meta),
  ];
}

export function recordUserFactEvents(runDir = '', text = '', options = {}) {
  const facts = extractUserFactEvents(text, options);
  return appendFacts(runDir, facts);
}

function labelDay(day) {
  return {
    day_before_yesterday: '그제',
    yesterday: '어제',
    today: '오늘',
    tomorrow: '내일',
    unknown: '날짜 미상',
  }[day] || day || '날짜 미상';
}

function labelSlot(slot) {
  return {
    breakfast: '아침',
    lunch: '점심',
    dinner: '저녁',
    unspecified: '끼니 미상',
  }[slot] || slot || '끼니 미상';
}

export function summarizeActiveUserFacts(runDir = '') {
  const facts = resolveActiveUserFacts(readUserFacts(runDir));
  const profile = new Map();
  const preferences = [];
  const meals = [];
  for (const fact of facts) {
    if (fact.type === 'profile') profile.set(String(fact.field || ''), fact.value);
    else if (fact.type === 'preference') preferences.push(fact);
    else if (fact.type === 'meal') meals.push(fact);
  }
  meals.sort((a, b) => String(a.relative_day || '').localeCompare(String(b.relative_day || '')) || String(a.meal_slot || '').localeCompare(String(b.meal_slot || '')));
  return { profile, preferences, meals, facts };
}

export function formatActiveUserFactContext(runDir = '', { maxChars = 1800 } = {}) {
  const { profile, preferences, meals } = summarizeActiveUserFacts(runDir);
  const lines = [];
  const profileParts = [];
  if (profile.has('height_cm')) profileParts.push(`height=${profile.get('height_cm')}cm`);
  if (profile.has('weight_kg')) profileParts.push(`weight=${profile.get('weight_kg')}kg`);
  if (profile.has('age_years')) profileParts.push(`age=${profile.get('age_years')}`);
  if (profile.has('gender')) profileParts.push(`gender=${profile.get('gender')}`);
  if (profile.has('activity_level')) profileParts.push(`activity=${profile.get('activity_level')}`);
  if (profileParts.length > 0) lines.push(`- profile: ${profileParts.join(', ')}`);
  const prefParts = preferences.map((p) => `${p.field}=${p.value}`).filter(Boolean);
  if (prefParts.length > 0) lines.push(`- preferences: ${[...new Set(prefParts)].join(', ')}`);
  for (const meal of meals.slice(-12)) {
    const status = String(meal.status || 'active');
    const value = String(meal.value || '').trim() || '(unknown)';
    lines.push(`- meal: ${labelDay(meal.relative_day)} ${labelSlot(meal.meal_slot)} = ${value} (status=${status})`);
  }
  if (lines.length === 0) return '';
  lines.push('- governance: do not infer unrecorded meals; answer unknown/insufficient record when absent.');
  const block = `[ACTIVE USER FACT CONTEXT]\n${lines.join('\n')}`;
  return block.length > maxChars ? `${block.slice(0, Math.max(0, maxChars - 40))}\n…(user facts truncated)` : block;
}
