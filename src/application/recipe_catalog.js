import fs from 'node:fs';
import path from 'node:path';
import { getCurrentRecipeEvidence } from '../evaluation/recipe_evidence_store.js';
import { getCollaborationProfile } from './collaboration_profile_catalog.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '', maxLen = 2000) {
  const text = String(value ?? '').trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function defaultCatalogPath() {
  const explicit = clean(process.env.RECIPE_CATALOG_PATH || '', 1200);
  return explicit || path.resolve(process.cwd(), 'config', 'recipe_catalog.json');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeEvidenceRow(raw = {}) {
  const row = asObject(raw);
  const liveRuns = Math.max(0, Number(row.live_runs || 0));
  const passedRuns = Math.max(0, Number(row.passed_runs || 0));
  const successRate = Number.isFinite(Number(row.success_rate))
    ? Math.max(0, Math.min(1, Number(row.success_rate)))
    : (liveRuns > 0 ? passedRuns / liveRuns : 0);
  return {
    source: clean(row.source, 300),
    provider: clean(row.provider, 80),
    model: clean(row.model, 200),
    reasoning_effort: clean(row.reasoning_effort, 80),
    cli_version: clean(row.cli_version, 300),
    live_runs: liveRuns,
    passed_runs: passedRuns,
    success_rate: successRate,
    average_score: Number.isFinite(Number(row.average_score)) ? Number(row.average_score) : null,
    policy_violations: Math.max(0, Number(row.policy_violations || 0)),
    current: row.current === true,
    runtime_signature: clean(row.runtime_signature, 1200),
    last_observed_at: clean(row.last_observed_at, 100),
  };
}

export function deriveRecipeEvidenceStatus(recipe = {}, catalog = {}) {
  const evaluation = asObject(recipe.evaluation);
  const allEvidence = asArray(evaluation.evidence).map(normalizeEvidenceRow);
  const currentEvidence = allEvidence.filter((row) => row.current === true);
  const evidence = currentEvidence.length > 0 ? currentEvidence : allEvidence;
  const statusPolicy = asObject(catalog.status_policy);
  const recommended = asObject(statusPolicy.recommended);
  const evaluated = asObject(statusPolicy.evaluated);
  const totals = evidence.reduce((acc, row) => {
    acc.live_runs += row.live_runs;
    acc.passed_runs += row.passed_runs;
    acc.policy_violations += row.policy_violations;
    acc.weighted_score += (row.average_score ?? 0) * row.live_runs;
    return acc;
  }, { live_runs: 0, passed_runs: 0, policy_violations: 0, weighted_score: 0 });
  const successRate = totals.live_runs > 0 ? totals.passed_runs / totals.live_runs : 0;
  const averageScore = totals.live_runs > 0 ? totals.weighted_score / totals.live_runs : null;
  const scope = clean(evaluation.evidence_scope || 'none', 80).toLowerCase();

  let status = 'experimental';
  let reason = '아직 충분한 Live Scenario evidence가 없습니다.';
  if (evaluation.revalidation_required === true && totals.live_runs > 0) {
    status = 'revalidation_needed';
    reason = clean(evaluation.revalidation_reason || '모델, CLI, harness 또는 recipe 버전이 변경되어 재검증이 필요합니다.', 1000);
  } else if (
    totals.live_runs >= Number(recommended.min_live_runs || 8)
    && successRate >= Number(recommended.min_success_rate || 0.85)
    && totals.policy_violations <= Number(recommended.max_policy_violations || 0)
    && asArray(recommended.required_evidence_scope).map((v) => clean(v, 80).toLowerCase()).includes(scope)
  ) {
    status = 'recommended';
    reason = '대표성 있는 Live Scenario evidence가 현재 추천 기준을 충족합니다.';
  } else if (
    totals.live_runs >= Number(evaluated.min_live_runs || 3)
    && successRate >= Number(evaluated.min_success_rate || 0.8)
    && totals.policy_violations <= Number(evaluated.max_policy_violations || 0)
  ) {
    status = 'evaluated';
    reason = scope === 'narrow'
      ? '제한된 시나리오 범위에서 평가 기준을 통과했습니다. 범위를 넓히면 Recommended 후보가 될 수 있습니다.'
      : 'Live Scenario evidence가 최소 평가 기준을 충족합니다.';
  }

  return {
    status,
    reason,
    evidence_scope: scope,
    live_runs: totals.live_runs,
    passed_runs: totals.passed_runs,
    success_rate: successRate,
    average_score: averageScore,
    policy_violations: totals.policy_violations,
    evidence,
  };
}

function normalizeRecipe(raw = {}, catalog = {}) {
  const row = asObject(raw);
  const fields = asArray(row.input_fields).map((entry) => {
    const field = asObject(entry);
    return {
      id: clean(field.id, 120),
      label: clean(field.label, 180),
      required: field.required === true,
      placeholder: clean(field.placeholder, 600),
    };
  }).filter((field) => field.id && field.label);
  const recipe = {
    id: clean(row.id, 160),
    version: Math.max(1, Number(row.version || 1)),
    title: clean(row.title, 240),
    title_ko: clean(row.title_ko, 240),
    category: clean(row.category, 100),
    description: clean(row.description, 1200),
    description_ko: clean(row.description_ko, 1200),
    recommended_room_package: clean(row.recommended_room_package, 200),
    recommended_collaboration_profile: clean(row.recommended_collaboration_profile || row.collaboration_profile, 160) || 'auto',
    alternative_collaboration_profiles: asArray(row.alternative_collaboration_profiles).map((v) => clean(v, 160)).filter(Boolean),
    tags: asArray(row.tags).map((v) => clean(v, 100)).filter(Boolean),
    input_fields: fields,
    example: clean(row.example, 3000),
    task_contract_template: asObject(row.task_contract_template),
    evaluation: asObject(row.evaluation),
  };
  const runtimeEvidence = getCurrentRecipeEvidence(recipe.id);
  if (runtimeEvidence) {
    recipe.evaluation = {
      ...recipe.evaluation,
      revalidation_required: false,
      active_runtime_signature: runtimeEvidence.runtime_signature,
      evidence: [...asArray(recipe.evaluation.evidence), runtimeEvidence],
    };
  }
  return {
    ...recipe,
    evidence_summary: deriveRecipeEvidenceStatus(recipe, catalog),
  };
}

export function loadRecipeCatalog({ catalogPath = '' } = {}) {
  const filePath = path.resolve(catalogPath || defaultCatalogPath());
  const parsed = readJson(filePath);
  const catalog = asObject(parsed);
  const recipes = asArray(catalog.recipes)
    .map((recipe) => normalizeRecipe(recipe, catalog))
    .filter((recipe) => recipe.id && recipe.title);
  return {
    schema_version: clean(catalog.schema_version || 'ai_rooms.recipe_catalog/v1', 120),
    catalog_version: clean(catalog.catalog_version || 'unknown', 160),
    source_path: filePath,
    status_policy: asObject(catalog.status_policy),
    recipes,
  };
}

export function listRecipes({ query = '', category = '', catalogPath = '' } = {}) {
  const catalog = loadRecipeCatalog({ catalogPath });
  const q = clean(query, 300).toLowerCase();
  const categoryKey = clean(category, 100).toLowerCase();
  const recipes = catalog.recipes.filter((recipe) => {
    if (categoryKey && recipe.category.toLowerCase() !== categoryKey) return false;
    if (!q) return true;
    const haystack = [
      recipe.id,
      recipe.title,
      recipe.title_ko,
      recipe.category,
      recipe.description,
      recipe.description_ko,
      ...recipe.tags,
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  });
  return { ...catalog, recipes };
}

export function getRecipe(recipeId = '', options = {}) {
  const id = clean(recipeId, 160).toLowerCase();
  if (!id) return null;
  return loadRecipeCatalog(options).recipes.find((recipe) => recipe.id.toLowerCase() === id) || null;
}

export function formatRecipeStatusBadge(status = '') {
  const key = clean(status, 80).toLowerCase();
  if (key === 'recommended') return '✅ Recommended';
  if (key === 'evaluated') return '📊 Evaluated';
  if (key === 'revalidation_needed') return '⚠️ Revalidation needed';
  if (key === 'deprecated') return '🗄 Deprecated';
  return '🧪 Experimental';
}

function compactPercent(value = 0) {
  return `${Math.round(Math.max(0, Math.min(1, Number(value || 0))) * 100)}%`;
}

export function formatRecipeListForTelegram({ query = '', catalogPath = '' } = {}) {
  const catalog = listRecipes({ query, catalogPath });
  if (catalog.recipes.length === 0) {
    return [
      '📚 Recipe Catalog',
      '',
      `검색 결과가 없습니다${query ? `: ${query}` : ''}.`,
      '/examples 로 전체 목록을 확인하세요.',
    ].join('\n');
  }
  const grouped = new Map();
  for (const recipe of catalog.recipes) {
    const rows = grouped.get(recipe.category) || [];
    rows.push(recipe);
    grouped.set(recipe.category, rows);
  }
  const lines = [
    `📚 Recipe Catalog · ${catalog.catalog_version}`,
    '사용자는 목표와 제약만 채우고, provider별 harness는 AI Rooms가 별도로 선택합니다.',
    '',
  ];
  for (const [category, recipes] of grouped.entries()) {
    lines.push(`【${category}】`);
    for (const recipe of recipes) {
      const evidence = recipe.evidence_summary;
      const evidenceText = evidence.live_runs > 0
        ? ` · ${evidence.live_runs} live runs / ${compactPercent(evidence.success_rate)}`
        : '';
      lines.push(`- ${formatRecipeStatusBadge(evidence.status)} ${recipe.id} · ${recipe.title_ko || recipe.title}${evidenceText}`);
    }
    lines.push('');
  }
  lines.push('상세: /example <recipe_id>');
  lines.push('작성 틀: /use <recipe_id>');
  lines.push('검색: /examples <keyword>');
  return lines.join('\n');
}

export function formatRecipeDetailForTelegram(recipe) {
  if (!recipe) return 'Recipe를 찾지 못했습니다.';
  const evidence = recipe.evidence_summary || {};
  const lines = [
    `${formatRecipeStatusBadge(evidence.status)} ${recipe.title_ko || recipe.title}`,
    `ID: ${recipe.id} · v${recipe.version}`,
    '',
    recipe.description_ko || recipe.description,
    '',
    `추천 Room Package: ${recipe.recommended_room_package || 'task-adaptive'}`,
    `추천 협업: ${recipe.recommended_collaboration_profile || 'auto'}`,
    asArray(recipe.alternative_collaboration_profiles).length
      ? `대안 협업: ${asArray(recipe.alternative_collaboration_profiles).join(', ')}`
      : '',
    '',
    '입력 항목:',
    ...recipe.input_fields.map((field) => `- ${field.required ? '필수' : '선택'} · ${field.label}${field.placeholder ? ` — ${field.placeholder}` : ''}`),
    '',
    '예시:',
    recipe.example || '(예시 없음)',
    '',
    'Evidence:',
    `- 상태: ${formatRecipeStatusBadge(evidence.status)}`,
    `- live runs: ${Number(evidence.live_runs || 0)} · success: ${compactPercent(evidence.success_rate || 0)} · policy violations: ${Number(evidence.policy_violations || 0)}`,
    `- scope: ${evidence.evidence_scope || 'none'}`,
    `- 이유: ${evidence.reason || '평가 정보 없음'}`,
    '',
    `작성 틀 보기: /use ${recipe.id}`,
  ];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function formatRecipeTemplateForTelegram(recipe) {
  if (!recipe) return 'Recipe를 찾지 못했습니다.';
  const lines = [
    `🧩 ${recipe.title_ko || recipe.title} 작성 템플릿`,
    `Recipe: ${recipe.id} v${recipe.version}`,
    `추천 협업: ${recipe.recommended_collaboration_profile || 'auto'}`,
    '',
    ...recipe.input_fields.flatMap((field) => [
      `${field.label}:`,
      field.placeholder ? `  ${field.placeholder}` : '  ',
      '',
    ]),
    '작성한 뒤 일반 메시지나 /chat으로 보내도 됩니다.',
    `상세 evidence: /example ${recipe.id}`,
  ];
  return lines.join('\n').trim();
}

function fieldLookup(recipe) {
  const map = new Map();
  for (const field of asArray(recipe?.input_fields)) {
    map.set(String(field.id || '').toLowerCase(), field.id);
    map.set(String(field.label || '').toLowerCase(), field.id);
  }
  return map;
}

export function parseRecipeForm(recipe, text = '') {
  const lookup = fieldLookup(recipe);
  const values = {};
  let currentField = '';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const match = line.match(/^\s*([^:：]{1,80})\s*[:：]\s*(.*)$/);
    if (match) {
      const key = clean(match[1], 80).toLowerCase();
      const fieldId = lookup.get(key);
      if (fieldId) {
        currentField = fieldId;
        values[fieldId] = clean(match[2], 4000);
        continue;
      }
    }
    if (currentField && line.trim()) {
      values[currentField] = clean(`${values[currentField] || ''}\n${line.trim()}`, 4000);
    }
  }
  return values;
}

export function buildRecipeTaskContract(recipe, values = {}) {
  if (!recipe) return null;
  const normalizedValues = {};
  for (const field of asArray(recipe.input_fields)) {
    normalizedValues[field.id] = clean(values?.[field.id] || '', 5000);
  }
  const requiredMissing = asArray(recipe.input_fields)
    .filter((field) => field.required && !normalizedValues[field.id])
    .map((field) => field.id);
  const contract = {};
  for (const [key, template] of Object.entries(asObject(recipe.task_contract_template))) {
    let value = clean(template, 5000);
    value = value.replace(/\{\{([^}]+)\}\}/g, (_match, fieldId) => normalizedValues[String(fieldId || '').trim()] || '');
    value = value.trim();
    if (value) contract[key] = value;
  }
  return {
    schema_version: 'ai_rooms.recipe_task_contract/v1',
    recipe_id: recipe.id,
    recipe_version: recipe.version,
    recommended_room_package: recipe.recommended_room_package || null,
    recommended_collaboration_profile: recipe.recommended_collaboration_profile || 'auto',
    collaboration_profile: getCollaborationProfile(recipe.recommended_collaboration_profile || 'auto'),
    values: normalizedValues,
    required_missing: requiredMissing,
    ready: requiredMissing.length === 0,
    contract,
  };
}

export function formatRecipeContractForTelegram(recipe, parsed) {
  const result = buildRecipeTaskContract(recipe, parsed);
  if (!result) return 'Recipe를 찾지 못했습니다.';
  if (!result.ready) {
    const labels = new Map(asArray(recipe.input_fields).map((field) => [field.id, field.label]));
    return [
      `⚠️ ${recipe.title_ko || recipe.title} 입력이 아직 부족합니다.`,
      `필수 누락: ${result.required_missing.map((id) => labels.get(id) || id).join(', ')}`,
      '',
      formatRecipeTemplateForTelegram(recipe),
    ].join('\n');
  }
  const labels = {
    goal: '목표',
    context: '배경/증상',
    reproduction: '재현 정보',
    requirements: '필수 요구사항',
    non_goals: '비요구사항',
    allowed_scope: '허용 범위',
    scope: '범위',
    constraints: '제약/금지 사항',
    freshness: '최신성',
    source_bar: '출처 기준',
    criteria: '평가 기준',
    preserve: '유지할 결정',
    done_when: '완료 조건',
    current_context: '현재 상황',
    preferences_and_exclusions: '선호/제외 조건',
    options: '선택지',
    source_scope: '사용할 자료 범위',
    source_of_truth: '충돌 시 기준',
    diversity_contract: '다양성 계약',
    novelty_bar: '새로움 기준',
    resources: '사용 가능한 자원',
    checkpoints: '단계별 산출물',
    stop_conditions: '중단/검토 조건',
    core_user_journey: '핵심 사용자 흐름',
    deliverable: '산출물',
    evidence_bar: '근거 수준',
    risk_limits: '위험 한도',
    uncertainty_policy: '불확실성 처리',
  };
  const lines = [
    `✅ ${recipe.title_ko || recipe.title} task contract`,
    `Recipe: ${recipe.id} v${recipe.version}`,
    `Room package hint: ${result.recommended_room_package || 'task-adaptive'}`,
    `Collaboration hint: ${result.recommended_collaboration_profile || 'auto'}`,
    '',
  ];
  for (const [key, value] of Object.entries(result.contract)) {
    lines.push(`${labels[key] || key}:`);
    lines.push(String(value));
    lines.push('');
  }
  lines.push('이 contract를 일반 메시지 또는 /chat 뒤에 붙여 실행할 수 있습니다.');
  return lines.join('\n').trim();
}
