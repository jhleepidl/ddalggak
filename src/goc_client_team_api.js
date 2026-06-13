function asObject(v) {
  return v && typeof v === 'object' ? v : {};
}

function pick(obj, keys) {
  const src = asObject(obj);
  for (const key of keys) {
    const value = src[key];
    if (typeof value === 'undefined' || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
  }
  return null;
}

function normalizeEntity(data, keys = []) {
  const obj = asObject(data);
  for (const key of keys) {
    if (obj[key] && typeof obj[key] === 'object') return asObject(obj[key]);
  }
  return obj;
}

function normalizeTeamTarget(rawTarget = {}, fallback = {}) {
  const row = rawTarget && typeof rawTarget === 'object' ? rawTarget : { thread_id: rawTarget };
  const base = fallback && typeof fallback === 'object' ? fallback : {};
  const threadId = String(
    pick(row, ['thread_id', 'threadId', 'id'])
    || pick(base, ['thread_id', 'threadId', 'id'])
    || ''
  ).trim();
  const conversationId = String(
    pick(row, ['conversation_id', 'conversationId'])
    || pick(base, ['conversation_id', 'conversationId'])
    || ''
  ).trim();
  return {
    thread_id: threadId || undefined,
    conversation_id: conversationId || undefined,
  };
}

export function summarizeTeamTarget(threadTarget, { client } = {}) {
  const fallback = client && typeof client === 'object' ? asObject(client.lastTeamTarget) : {};
  const target = normalizeTeamTarget(threadTarget, fallback);
  if (client && typeof client === 'object' && target.thread_id) {
    client.lastTeamTarget = { ...target };
  }
  return target;
}

function requireThreadId(target) {
  const threadId = String(target.thread_id || '').trim();
  if (!threadId) throw new Error('threadTarget requires threadId');
  return threadId;
}

export async function getTeamConfigApi(client, threadTarget) {
  const threadId = requireThreadId(summarizeTeamTarget(threadTarget, { client }));
  return await client._requestAny({
    method: 'GET',
    attempts: [
      { path: `/api/threads/${encodeURIComponent(threadId)}/team/config` },
      { path: `/threads/${encodeURIComponent(threadId)}/team/config` },
    ],
  });
}

export async function setTeamConfigApi(client, threadTarget, teamConfig = {}) {
  const threadId = requireThreadId(summarizeTeamTarget(threadTarget, { client }));
  return await client._requestAny({
    method: 'PUT',
    attempts: [
      { path: `/api/threads/${encodeURIComponent(threadId)}/team/config`, body: { team_config: teamConfig } },
      { path: `/threads/${encodeURIComponent(threadId)}/team/config`, body: { team_config: teamConfig } },
    ],
  });
}

export async function getTeamBlueprintApi(client, threadTarget) {
  const threadId = requireThreadId(summarizeTeamTarget(threadTarget, { client }));
  const data = await client._requestAny({
    method: 'GET',
    attempts: [
      { path: `/api/threads/${encodeURIComponent(threadId)}/team/blueprint` },
      { path: `/threads/${encodeURIComponent(threadId)}/team/blueprint` },
    ],
  });
  return normalizeEntity(data, ['manifest', 'data']) || asObject(data);
}

export async function validateTeamBlueprintApi(client, threadTarget, blueprint = {}, applyState = 'active') {
  const threadId = requireThreadId(summarizeTeamTarget(threadTarget, { client }));
  return await client._requestAny({
    method: 'POST',
    attempts: [
      { path: `/api/threads/${encodeURIComponent(threadId)}/team/blueprint/validate`, body: { manifest: blueprint, apply_state: applyState } },
      { path: `/threads/${encodeURIComponent(threadId)}/team/blueprint/validate`, body: { manifest: blueprint, apply_state: applyState } },
    ],
  });
}

export async function buildTeamPublishCandidateApi(client, threadTarget, options = {}) {
  const threadId = requireThreadId(summarizeTeamTarget(threadTarget, { client }));
  return await client._requestAny({
    method: 'POST',
    attempts: [
      { path: `/api/threads/${encodeURIComponent(threadId)}/team/blueprint/publish_candidate`, body: options && typeof options === 'object' ? options : {} },
      { path: `/threads/${encodeURIComponent(threadId)}/team/blueprint/publish_candidate`, body: options && typeof options === 'object' ? options : {} },
    ],
  });
}

export async function installTeamBlueprintApi(client, threadTarget, blueprint = {}, applyState = 'active') {
  const threadId = requireThreadId(summarizeTeamTarget(threadTarget, { client }));
  return await client._requestAny({
    method: 'POST',
    attempts: [
      { path: `/api/threads/${encodeURIComponent(threadId)}/team/blueprint/install`, body: { manifest: blueprint, apply_state: applyState } },
      { path: `/threads/${encodeURIComponent(threadId)}/team/blueprint/install`, body: { manifest: blueprint, apply_state: applyState } },
    ],
  });
}

export async function upsertThreadTeamPackageApi(client, threadTarget, teamPackage = {}) {
  const threadId = requireThreadId(summarizeTeamTarget(threadTarget, { client }));
  return await client._requestAny({
    method: 'POST',
    attempts: [
      { path: `/api/threads/${encodeURIComponent(threadId)}/team-packages`, body: { package: teamPackage, source: 'ddalggak' } },
    ],
  });
}

export async function listThreadTeamPackagesApi(client, threadTarget, { limit = 100 } = {}) {
  const threadId = requireThreadId(summarizeTeamTarget(threadTarget, { client }));
  return await client._requestAny({
    method: 'GET',
    attempts: [
      { path: `/api/threads/${encodeURIComponent(threadId)}/team-packages`, query: { limit } },
    ],
  });
}

export async function listTeamLibraryApi(client, { query = '', limit = 100 } = {}) {
  return await client._requestAny({
    method: 'GET',
    attempts: [
      { path: '/api/team-library', query: { q: query || undefined, limit } },
    ],
  });
}

export async function getTeamLibraryPackageApi(client, packageId = '') {
  const id = String(packageId || '').trim();
  if (!id) throw new Error('packageId is required');
  return await client._requestAny({
    method: 'GET',
    attempts: [
      { path: `/api/team-library/${encodeURIComponent(id)}` },
    ],
  });
}

export async function forkTeamLibraryPackagePreviewApi(client, packageId = '', options = {}) {
  const id = String(packageId || '').trim();
  if (!id) throw new Error('packageId is required');
  return await client._requestAny({
    method: 'POST',
    attempts: [
      { path: `/api/team-library/${encodeURIComponent(id)}/fork-preview`, body: options && typeof options === 'object' ? options : {} },
    ],
  });
}
