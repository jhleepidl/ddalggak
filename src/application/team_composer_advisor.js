import { buildTeamSeedFromTaskArchetype, listTeamBlueprintTemplateSeeds } from './team_blueprint_templates.js';
import { attachTeamBlueprint, inferTaskArchetype, summarizeExecutableTeamDefinition } from './team_blueprint.js';

function asObject(v){return v&&typeof v==='object'&&!Array.isArray(v)?v:{}}
function asArray(v){return Array.isArray(v)?v:[]}
function clean(v=''){return String(v||'').trim()}
function cleanId(v=''){return clean(v).toLowerCase().replace(/[^a-z0-9._:-]+/g,'_')}
function uniq(values=[], limit=16){ const out=[]; const seen=new Set(); for (const raw of asArray(values)){ const value=clean(raw); if(!value) continue; const key=value.toLowerCase(); if(seen.has(key)) continue; seen.add(key); out.push(value); if(out.length>=limit) break; } return out; }
function tokenize(text=''){ return uniq(clean(text).toLowerCase().split(/[^a-z0-9가-힣._:-]+/g).filter(Boolean), 64).map((v)=>v.toLowerCase()); }
function overlapScore(left='', right=''){ const a=new Set(tokenize(left)); let score=0; for (const token of tokenize(right)) if (a.has(token)) score += 1; return score; }

function summarizeTopologyFitness(blueprint = {}) {
  const topology = asObject(blueprint.topology);
  const pattern = clean(topology.pattern || 'hybrid') || 'hybrid';
  const participantCount = asArray(topology.participants).length || asArray(blueprint.structure?.participants).length;
  const edgeCount = asArray(topology.edges).length;
  const reviewLike = ['reviewer', 'critic', 'judge'].some((term) => JSON.stringify(blueprint).toLowerCase().includes(term));
  return {
    pattern,
    participant_count: participantCount,
    edge_count: edgeCount,
    review_present: reviewLike,
    topology_label: `${pattern}:${participantCount || 0}p/${edgeCount || 0}e`,
  };
}

function summarizeMemoryFit(blueprint = {}) {
  const memoryPlan = asObject(blueprint.memory_plan);
  const surfaces = asArray(memoryPlan.surfaces);
  const sharedSurfaceCount = surfaces.filter((surface) => cleanId(surface.write_policy || 'shared') === 'shared').length;
  const finalAnswerSurface = surfaces.find((surface) => cleanId(surface.surface_id) === 'final_answer' || asArray(surface.semantic_slots).map((entry) => cleanId(entry)).includes('final_answer'));
  return {
    surface_count: surfaces.length,
    shared_surface_count: sharedSurfaceCount,
    final_answer_surface_ready: !!finalAnswerSurface,
    write_modes: uniq(surfaces.map((surface) => cleanId(surface.write_policy || 'shared') || 'shared'), 8),
  };
}

export function scoreTeamBlueprintCandidate({ taskText = '', blueprint = null } = {}) {
  const row = asObject(blueprint);
  const title = clean(row.title || row.team_name || row.blueprint_id || 'team');
  const description = clean(row.description || '');
  const serialized = JSON.stringify(row);
  const archetype = clean(row.task_archetype || inferTaskArchetype({ team: { task_brief: taskText }, structure: asObject(row.structure), memoryPlan: asObject(row.memory_plan) }));
  const topology = summarizeTopologyFitness(row);
  const memoryFit = summarizeMemoryFit(row);
  const semantic = overlapScore(`${title} ${description} ${serialized}`, taskText);
  const implementationBoost = /implement|code|patch|fix|repo|workspace|build|구현|코드|패치|수정/.test(taskText.toLowerCase()) && archetype === 'implementation' ? 4 : 0;
  const reviewBoost = /review|audit|repair|critic|bug|regression|검토|감사|회귀|오류/.test(taskText.toLowerCase()) && archetype === 'review_repair' ? 4 : 0;
  const researchBoost = /research|analy|brief|memo|survey|investigate|조사|분석|리서치/.test(taskText.toLowerCase()) && archetype === 'research' ? 4 : 0;
  const topologyBoost = topology.review_present ? 1 : 0;
  const memoryBoost = memoryFit.final_answer_surface_ready ? 1 : 0;
  const score = semantic + implementationBoost + reviewBoost + researchBoost + topologyBoost + memoryBoost;
  return {
    score,
    semantic_score: semantic,
    archetype,
    topology,
    memory_fit: memoryFit,
    rationale: uniq([
      archetype ? `archetype=${archetype}` : '',
      semantic ? `keyword_overlap=${semantic}` : '',
      topology.topology_label ? `topology=${topology.topology_label}` : '',
      memoryFit.final_answer_surface_ready ? 'final_answer_surface_ready' : 'final_answer_surface_missing',
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
