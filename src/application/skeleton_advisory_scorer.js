import { execFileSync } from 'node:child_process';
import { buildSkeletonAdvisoryRequest, parseSkeletonAdvisoryLabels, summarizeSkeletonAdvisory } from './skeleton_advisory_dsl.js';

function clean(value = '') { return String(value || '').trim(); }
function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

function boolEnv(name, fallback = false) {
  const v = clean(process.env[name]).toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function splitCommand(value = '') {
  const text = clean(value);
  if (!text) return [];
  return text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^['"]|['"]$/g, '')) || [];
}

function mockOutputForRequest(request = {}) {
  const tokens = asArray(request.tokens);
  const has = (prefix, value = '') => tokens.some((tok) => String(tok) === `${prefix}=${value}` || (!value && String(tok).startsWith(`${prefix}=`)));
  const role = (name) => tokens.includes(`ROLE=${name}`);
  const high = (dim) => has(`P_${dim}`, 'high');
  const manyRoles = tokens.filter((tok) => String(tok).startsWith('ROLE=')).length >= 4;
  const userRequestedReviewer = tokens.includes('U_ROLE=reviewer') || tokens.includes('U_TEAM_STYLE=review');
  const userRequestedResearcher = tokens.includes('U_ROLE=researcher');
  const userRequestedVerifier = tokens.includes('U_ROLE=artifact_verifier');
  const targetPaper = tokens.includes('TARGET_TEAM=paper') || tokens.includes('MEM_PROFILE=paper');
  const targetCoding = tokens.includes('TARGET_TEAM=coding') || tokens.includes('MEM_PROFILE=coding');
  const targetMismatch = (targetPaper && role('builder') && !role('synthesizer')) || (targetCoding && role('synthesizer') && !role('builder'));
  const util = targetMismatch ? 'ok' : ((high('VERIFY') && !role('reviewer')) || (high('ARTIFACT') && !role('artifact_verifier')) ? 'ok' : 'good');
  const debt = manyRoles && !high('RISK') && !high('ARTIFACT') ? 'high' : (manyRoles ? 'med' : 'low');
  return [
    `Y_UTIL=${util}`,
    `Y_DEBT=${debt}`,
    `Y_FRONTIER_NEEDED=${high('RISK') || role('arbiter') ? 'yes' : 'no'}`,
    `Y_ADD_REVIEWER=${(high('VERIFY') || userRequestedReviewer) && !role('reviewer') ? 'yes' : 'no'}`,
    `Y_ADD_RESEARCHER=${(high('CONTEXT') || userRequestedResearcher) && !role('researcher') ? 'yes' : 'no'}`,
    `Y_ADD_ARTIFACT_VERIFIER=${(high('ARTIFACT') || userRequestedVerifier) && !role('artifact_verifier') ? 'yes' : 'no'}`,
    `Y_ADD_ARBITER=${high('RISK') && !role('arbiter') ? 'yes' : 'no'}`,
  ].join(' ');
}

export function scorerConfigFromEnv(env = process.env) {
  return {
    mode: clean(env.TEAM_COMPAT_ADVISORY_MODE || env.DDALGGAK_TEAM_COMPAT_ADVISORY_MODE || 'shadow').toLowerCase(),
    command: clean(env.TEAM_COMPAT_SCORER_CMD || env.DDALGGAK_TEAM_COMPAT_SCORER_CMD || ''),
    timeoutMs: Number(env.TEAM_COMPAT_SCORER_TIMEOUT_MS || env.DDALGGAK_TEAM_COMPAT_SCORER_TIMEOUT_MS || 45000),
    mock: boolEnv('TEAM_COMPAT_SCORER_MOCK', false) || boolEnv('DDALGGAK_TEAM_COMPAT_SCORER_MOCK', false),
  };
}

export function scoreSkeletonAdvisory({ request = '', candidate = {}, stress = {}, runtime = null, config = null } = {}) {
  const cfg = asObject(config || scorerConfigFromEnv());
  const advisoryRequest = buildSkeletonAdvisoryRequest({ request, candidate, stress, runtime });
  if (cfg.mode === 'off') {
    return { kind: 'skeleton_advisory_v1', status: 'disabled', source: 'disabled', request: advisoryRequest };
  }
  if (!cfg.command && !cfg.mock) {
    return { kind: 'skeleton_advisory_v1', status: 'unavailable', source: 'not_configured', request: advisoryRequest };
  }
  let stdout = '';
  let source = 'external';
  try {
    if (cfg.mock) {
      stdout = mockOutputForRequest(advisoryRequest);
      source = 'mock';
    } else {
      const parts = splitCommand(cfg.command);
      const cmd = parts[0];
      const args = parts.slice(1);
      stdout = execFileSync(cmd, args, {
        input: JSON.stringify(advisoryRequest),
        encoding: 'utf8',
        timeout: Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : 45000,
        maxBuffer: 1024 * 1024 * 4,
        env: { ...process.env, TEAM_COMPAT_SCORER_INPUT_FORMAT: 'json_v1' },
      });
    }
    const trimmed = clean(stdout);
    let parsed = null;
    try { parsed = JSON.parse(trimmed); } catch {}
    const labelText = parsed?.label_text || parsed?.text || parsed?.output || trimmed;
    const labels = parsed?.labels && typeof parsed.labels === 'object' ? parsed.labels : parseSkeletonAdvisoryLabels(labelText).labels;
    const diagnostics = parseSkeletonAdvisoryLabels(labelText).diagnostics;
    return {
      ...summarizeSkeletonAdvisory({ labels, diagnostics, source, confidence: parsed?.confidence }),
      status: 'ok',
      request: advisoryRequest,
      raw_output_preview: trimmed.slice(0, 1000),
    };
  } catch (error) {
    return {
      kind: 'skeleton_advisory_v1',
      status: 'error',
      source,
      error_type: error?.name || 'Error',
      error_message: clean(error?.message).slice(0, 500),
      request: advisoryRequest,
    };
  }
}

export function scoreSkeletonAdvisories({ request = '', candidates = [], stress = {}, runtime = null, config = null } = {}) {
  return asArray(candidates).map((candidate) => scoreSkeletonAdvisory({ request, candidate, stress, runtime, config }));
}
