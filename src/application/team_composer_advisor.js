import { buildTeamSeedFromTaskArchetype, listTeamBlueprintTemplateSeeds } from './team_blueprint_templates.js';
import { attachTeamBlueprint, inferTaskArchetype, summarizeExecutableTeamDefinition } from './team_blueprint.js';

function asObject(v){return v&&typeof v==='object'&&!Array.isArray(v)?v:{}}
function asArray(v){return Array.isArray(v)?v:[]}
function clean(v=''){return String(v||'').trim()}
function cleanId(v=''){return clean(v).toLowerCase().replace(/[^a-z0-9._:-]+/g,'_')}
function uniq(values=[], limit=16){ const out=[]; const seen=new Set(); for (const raw of asArray(values)){ const value=clean(raw); if(!value) continue; const key=value.toLowerCase(); if(seen.has(key)) continue; seen.add(key); out.push(value); if(out.length>=limit) break; } return out; }
function tokenize(text=''){ return uniq(clean(text).toLowerCase().split(/[^a-z0-9가-힣._:-]+/g).filter(Boolean), 128).map((v)=>v.toLowerCase()); }
function overlapScore(left='', right=''){ const a=new Set(tokenize(left)); let score=0; for (const token of tokenize(right)) if (a.has(token)) score += 1; return score; }

function summarizeTopologyFitness(blueprint = {}) {
  const topology = asObject(blueprint.topology);
  const structure = asObject(blueprint.structure);
  const participants = asArray(topology.participants).length ? asArray(topology.participants) : asArray(structure.participants);
  const pattern = clean(topology.pattern || structure.topology?.pattern || 'hybrid') || 'hybrid';
  const edgeCount = asArray(topology.edges).length;
  const roles = uniq(participants.map((participant) => asObject(participant).role || asObject(participant).kind || ''), 12);
  const reviewLike = roles.some((role) => ['reviewer', 'critic', 'judge'].includes(cleanId(role)));
  return {
    pattern,
    participant_count: participants.length,
    edge_count: edgeCount,
    review_present: reviewLike,
    topology_label: `${pattern}:${participants.length || 0}p/${edgeCount || 0}e`,
    participant_roles: roles,
  };
}

function summarizeMemoryFit(blueprint = {}) {
  const memoryPlan = asObject(blueprint.memory_plan);
  const surfaces = asArray(memoryPlan.surfaces).map((surface) => asObject(surface));
  const sharedSurfaceCount = surfaces.filter((surface) => cleanId(surface.write_policy || 'shared') === 'shared').length;
  const appendOnlySurfaceCount = surfaces.filter((surface) => cleanId(surface.write_policy || '') === 'append_only').length;
  const finalAnswerSurface = surfaces.find((surface) => cleanId(surface.surface_id) === 'final_answer' || asArray(surface.semantic_slots).map((entry) => cleanId(entry)).includes('final_answer'));
  return {
    surface_count: surfaces.length,
    shared_surface_count: sharedSurfaceCount,
    append_only_surface_count: appendOnlySurfaceCount,
    final_answer_surface_ready: !!finalAnswerSurface,
    write_modes: uniq(surfaces.map((surface) => cleanId(surface.write_policy || 'shared') || 'shared'), 8),
    surface_ids: uniq(surfaces.map((surface) => cleanId(surface.surface_id || '')), 16),
    semantic_slots: uniq(surfaces.flatMap((surface) => asArray(surface.semantic_slots).map((slot) => cleanId(slot))), 16),
  };
}

function blueprintSearchText(blueprint = {}) {
  const row = asObject(blueprint);
  const structure = asObject(row.structure);
  const topology = asObject(row.topology);
  const memoryPlan = asObject(row.memory_plan);
  const participants = asArray(topology.participants).length ? asArray(topology.participants) : asArray(structure.participants);
  const roles = participants.map((participant) => clean(asObject(participant).role || asObject(participant).kind || ''));
  const purposes = participants.map((participant) => clean(asObject(participant).purpose || asObject(participant).name || ''));
  const surfaces = asArray(memoryPlan.surfaces).map((surface) => asObject(surface));
  const surfaceTerms = surfaces.flatMap((surface) => [
    clean(surface.surface_id),
    clean(surface.write_policy),
    ...asArray(surface.semantic_slots).map((slot) => clean(slot)),
  ]);
  const catalog = asObject(row.catalog);
  return [
    clean(row.title),
    clean(row.description),
    clean(row.task_archetype),
    clean(topology.pattern || structure.topology?.pattern || ''),
    ...roles,
    ...purposes,
    ...surfaceTerms,
    ...asArray(catalog.tags).map((value) => clean(value)),
    ...asArray(catalog.good_for).map((value) => clean(value)),
  ].filter(Boolean).join(' ');
}

export function scoreTeamBlueprintCandidate({ taskText = '', blueprint = null } = {}) {
  const row = asObject(blueprint);
  const title = clean(row.title || row.team_name || row.blueprint_id || 'team');
  const description = clean(row.description || '');
  const archetype = clean(row.task_archetype || inferTaskArchetype({ team: { task_brief: taskText }, structure: asObject(row.structure), memoryPlan: asObject(row.memory_plan) }));
  const topology = summarizeTopologyFitness(row);
  const memoryFit = summarizeMemoryFit(row);
  const featureText = blueprintSearchText(row);
  const keywordOverlap = overlapScore(`${title} ${description} ${featureText}`, taskText);
  const taskLower = clean(taskText).toLowerCase();
  const implementationBoost = /implement|code|patch|fix|repo|workspace|build|구현|코드|패치|수정/.test(taskLower) && archetype === 'implementation' ? 4 : 0;
  const reviewBoost = /review|audit|repair|critic|bug|regression|검토|감사|회귀|오류/.test(taskLower) && archetype === 'review_repair' ? 4 : 0;
  const researchBoost = /research|analy|brief|memo|survey|investigate|조사|분석|리서치/.test(taskLower) && archetype === 'research' ? 4 : 0;
  const topologyBoost = topology.review_present ? 1 : 0;
  const memoryBoost = memoryFit.final_answer_surface_ready ? 1 : 0;
  const score = keywordOverlap + implementationBoost + reviewBoost + researchBoost + topologyBoost + memoryBoost;
  return {
    score,
    semantic_score: keywordOverlap,
    feature_score_breakdown: {
      keyword_overlap: keywordOverlap,
      implementation_boost: implementationBoost,
      review_boost: reviewBoost,
      research_boost: researchBoost,
      topology_boost: topologyBoost,
      memory_boost: memoryBoost,
    },
    archetype,
    topology,
    memory_fit: memoryFit,
    rationale: uniq([
      archetype ? `archetype=${archetype}` : '',
      keywordOverlap ? `keyword_overlap=${keywordOverlap}` : 'keyword_overlap=0',
      topology.topology_label ? `topology=${topology.topology_label}` : '',
      memoryFit.final_answer_surface_ready ? 'final_answer_surface_ready' : 'final_answer_surface_missing',
      memoryFit.surface_count ? `memory_surfaces=${memoryFit.surface_count}` : '',
    ], 8),
  };
}

export function recommendTeamBlueprintCandidates({ taskText = '', runtime = null, limit = 3 } = {}) {
  const templates = listTeamBlueprintTemplateSeeds();
  const candidates = templates.map((template) => {
    const seed = buildTeamSeedFromTaskArchetype(template.task_archetype || template.id || 'research', {
      taskBrief: taskText,
      title: clean(template.title || template.blueprint_document?.summary?.title || template.id || 'team'),
      description: clean(template.description || ''),
    });
    const attached = attachTeamBlueprint(seed, { runtime, applyState: 'pending', source: 'team_composer_advisor' });
    const score = scoreTeamBlueprintCandidate({ taskText, blueprint: attached.team_blueprint });
    return {
      template_id: clean(template.id || attached.blueprint_id || attached.team_blueprint?.blueprint_id || 'team_template'),
      blueprint_id: clean(attached.blueprint_id || attached.team_blueprint?.blueprint_id || ''),
      title: clean(attached.team_blueprint?.title || attached.team_name || template.title || template.id || 'Configured Team'),
      task_archetype: clean(attached.team_blueprint?.task_archetype || template.task_archetype || ''),
      score: score.score,
      semantic_score: score.semantic_score,
      feature_score_breakdown: score.feature_score_breakdown,
      topology: score.topology,
      memory_fit: score.memory_fit,
      rationale: score.rationale,
      team_blueprint: attached.team_blueprint,
      team_seed: attached,
      executable_definition: summarizeExecutableTeamDefinition({ blueprint: attached.team_blueprint, memoryAclSummary: attached.memory_acl_summary }),
    };
  });
  return candidates.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, Math.max(1, limit));
}

export function buildTeamComposerRecommendationEnvelope({ taskText = '', runtime = null, limit = 3 } = {}) {
  const candidates = recommendTeamBlueprintCandidates({ taskText, runtime, limit });
  return {
    kind: 'team_composer_recommendation_v1',
    task_text: clean(taskText),
    candidate_count: candidates.length,
    candidates,
  };
}
