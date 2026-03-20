import {
  detectCapabilityGapsFromExecution,
  detectTeamCapabilityGaps,
  formatCapabilityGapLines,
  normalizeCapabilityGapList,
} from './capability_gap_detector.js';
import {
  buildManifestInstallHints,
  buildManifestRequirements,
  formatManifestRequirementLines,
  normalizeManifestRequirements,
} from '../shared/manifest_requirements.js';
import {
  buildInstallRequirementActions,
  formatInstallRequirementActionLines,
  normalizeInstallRequirementActions,
} from '../shared/install_requirement_actions.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '') {
  return String(value || '').trim();
}

function unique(values = [], { max = 12 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const value = clean(raw);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function hasBlockingEntries(requirements = {}) {
  const row = normalizeManifestRequirements(requirements);
  return [...row.tools, ...row.credentials, ...row.skills].some((entry) => String(entry?.severity || 'blocking').trim().toLowerCase() === 'blocking');
}

function buildSuggestedCommands({ hasThreadTarget = false, applyState = 'pending', requirements = {} } = {}) {
  const row = normalizeManifestRequirements(requirements);
  const hasRequirements = row.summary.tool_count > 0 || row.summary.credential_count > 0 || row.summary.skill_count > 0;
  const out = [];
  if (hasRequirements) {
    out.push('/team requirements');
    out.push('/team export');
    if (applyState !== 'active') out.push('/team apply');
  }
  if (row.summary.credential_count > 0) out.push('/credential pending');
  if (hasThreadTarget && hasRequirements) out.push('/team push');
  if (row.summary.tool_count > 0) out.push('/team refine <필요 tool/skill을 반영한 수정 요청>');
  return unique(out, { max: 8 });
}

export function buildTeamInstallProposal({
  team = {},
  runtime = null,
  execution = null,
  skillRegistry = null,
  applyState = 'pending',
} = {}) {
  const execGaps = execution ? detectCapabilityGapsFromExecution(execution) : [];
  const teamGaps = team && typeof team === 'object' ? detectTeamCapabilityGaps({ team, runtime, skillRegistry }) : [];
  const explicitGaps = asArray(team?.capability_gaps || team?.capabilityGaps || []);
  const gaps = normalizeCapabilityGapList([...execGaps, ...teamGaps, ...explicitGaps]);
  const requirements = normalizeManifestRequirements(buildManifestRequirements({
    team,
    capabilityGaps: gaps,
  }));
  const hasThreadTarget = !!clean(runtime?.map?.threadId || runtime?.threadId || '');
  const installHints = buildManifestInstallHints(requirements, { hasGocThreadTarget: hasThreadTarget });
  const suggestedCommands = buildSuggestedCommands({ hasThreadTarget, applyState, requirements });
  const actions = normalizeInstallRequirementActions(buildInstallRequirementActions(requirements));
  return {
    kind: 'capability_install_proposal',
    version: 1,
    source: execution ? 'execution_gap' : 'team_requirement',
    blocking: hasBlockingEntries(requirements),
    apply_state: String(applyState || '').trim().toLowerCase() === 'active' ? 'active' : 'pending',
    gap_count: gaps.length,
    requirements: {
      ...requirements,
      install_hints: installHints,
    },
    actions,
    suggested_commands: suggestedCommands,
    gap_preview_lines: formatCapabilityGapLines(gaps, { maxLines: 4 }),
  };
}

export function formatTeamInstallProposalMessage(proposal = {}, { maxLines = 8 } = {}) {
  const row = proposal && typeof proposal === 'object' ? proposal : {};
  const requirements = normalizeManifestRequirements(row.requirements || {});
  const actions = normalizeInstallRequirementActions(row.actions || {});
  const lines = [
    `Install proposal · ${row.blocking ? 'blocking' : 'advisory'}`,
    `source: ${clean(row.source || 'team_requirement')}`,
    `requirements: tools=${requirements.summary.tool_count} · credentials=${requirements.summary.credential_count} · skills=${requirements.summary.skill_count}`,
    `actions: tool_installs=${actions.summary.tool_install_count} · credential_requests=${actions.summary.credential_request_count} · generated_skills=${actions.summary.generated_skill_count}`,
    ...(asArray(row.gap_preview_lines).length > 0 ? ['', 'Capability gaps', ...asArray(row.gap_preview_lines)] : []),
    ...(formatManifestRequirementLines(requirements, { maxLines }).length > 0 ? ['', 'Requirements', ...formatManifestRequirementLines(requirements, { maxLines })] : []),
    ...(formatInstallRequirementActionLines(actions, { maxLines }).length > 0 ? ['', 'Action proposals', ...formatInstallRequirementActionLines(actions, { maxLines })] : []),
    ...(asArray(row.suggested_commands).length > 0 ? ['', 'Suggested commands', ...asArray(row.suggested_commands).map((entry) => `- ${entry}`)] : []),
  ].filter(Boolean);
  return lines.join('\n');
}
