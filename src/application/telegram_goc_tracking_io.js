export function createGocTrackingIo({
  clip,
  jobs,
  tracking,
  runDir,
  memoryModeWithFallback,
  requireGocClient,
  ensureJobThread,
  ensureKnowledgeBaseMemorySurfacesInGoc,
  buildGocMemoryNodePayload,
  invalidateRoleScopedContextCache = null,
} = {}) {
  if (typeof clip !== 'function') throw new TypeError('clip function is required');
  if (!jobs || typeof jobs.log !== 'function') throw new TypeError('jobs.log is required');
  if (!tracking || typeof tracking.appendWithContract !== 'function' || typeof tracking.append !== 'function') {
    throw new TypeError('tracking append APIs are required');
  }
  if (typeof runDir !== 'function') throw new TypeError('runDir is required');
  if (typeof memoryModeWithFallback !== 'function') throw new TypeError('memoryModeWithFallback is required');
  if (typeof requireGocClient !== 'function') throw new TypeError('requireGocClient is required');
  if (typeof ensureJobThread !== 'function') throw new TypeError('ensureJobThread is required');
  if (typeof ensureKnowledgeBaseMemorySurfacesInGoc !== 'function') {
    throw new TypeError('ensureKnowledgeBaseMemorySurfacesInGoc is required');
  }
  if (typeof buildGocMemoryNodePayload !== 'function') {
    throw new TypeError('buildGocMemoryNodePayload is required');
  }

  function deriveGocMemoryNodePayload({ jobId = '', markdown = '', provider = '', roleId = '', purpose = '', writeEvent = null } = {}) {
    const event = writeEvent && typeof writeEvent === 'object' ? writeEvent : {};
    const targetSurfaceId = String(event?.target_surface_id || event?.requested_surface_id || '').trim().toLowerCase();
    const cleanPurpose = String(purpose || event?.purpose || '').trim().toLowerCase() || undefined;
    return buildGocMemoryNodePayload({
      clip,
      jobId,
      markdown,
      provider: String(provider || event?.provider || '').trim().toLowerCase(),
      roleId: String(roleId || event?.role_id || '').trim().toLowerCase(),
      purpose: cleanPurpose,
      eventType: String(event?.event_type || event?.eventType || '').trim().toLowerCase(),
      actorKind: String(event?.actor_kind || event?.actorKind || '').trim().toLowerCase(),
      pipelineStage: String(event?.pipeline_stage || event?.pipelineStage || '').trim().toLowerCase(),
      semanticKind: String(event?.semantic_kind || event?.semanticKind || '').trim().toLowerCase(),
      requestedDoc: String(event?.requested_doc || '').trim(),
      resolvedDoc: String(event?.resolved_doc || '').trim(),
      requestedSurfaceId: String(event?.requested_surface_id || '').trim().toLowerCase(),
      targetSurfaceId,
      memoryWriteStatus: String(event?.status || '').trim().toLowerCase(),
      defaultConfidence: event?.status === 'rerouted' ? 0.75 : 0.85,
      nodeTypeHint: ['final', 'artifact'].includes(String(cleanPurpose || '').trim().toLowerCase()) || ['final_answer', 'artifact_index'].includes(targetSurfaceId) ? 'decision' : '',
    });
  }

  async function syncRoleAwareMemoryWriteToGoc(jobId, markdown, { provider = '', roleId = '', purpose = '', writeEvent = null } = {}) {
    if (memoryModeWithFallback() !== 'goc') return null;
    const cleanMarkdown = String(markdown || '').trim();
    if (!cleanMarkdown) return null;
    const event = writeEvent && typeof writeEvent === 'object' ? writeEvent : {};
    const surfaceId = String(event?.target_surface_id || event?.requested_surface_id || '').trim().toLowerCase();
    if (!surfaceId || event?.policy_blocked === true || event?.status === 'rejected') return null;
    try {
      const client = requireGocClient();
      const map = await ensureJobThread(client, {
        jobId,
        jobDir: runDir(jobId),
        title: `job:${jobId}`,
      });
      await ensureKnowledgeBaseMemorySurfacesInGoc(jobId, { client, threadId: map.threadId });
      const created = await client.createMemoryNode(map.threadId, deriveGocMemoryNodePayload({
        jobId,
        markdown: cleanMarkdown,
        provider,
        roleId,
        purpose,
        writeEvent: event,
      }));
      if (typeof invalidateRoleScopedContextCache === 'function') {
        invalidateRoleScopedContextCache({ threadId: map.threadId, jobId });
      }
      return created;
    } catch (error) {
      jobs.log(jobId, `GoC memory node sync failed (${surfaceId}): ${String(error?.message || error)}`);
      return null;
    }
  }

  function recordBlockedMemoryWriteAudit(jobId, { provider = '', roleId = '', purpose = '', writeEvent = null, error = null } = {}) {
    const event = writeEvent && typeof writeEvent === 'object' ? writeEvent : {};
    const lines = [
      '## memory_write_blocked',
      `- provider: ${String(provider || event?.provider || '').trim().toLowerCase() || '(unknown)'}`,
      `- role_id: ${String(roleId || event?.role_id || '').trim().toLowerCase() || '(unknown)'}`,
      `- purpose: ${String(purpose || event?.purpose || '').trim().toLowerCase() || '(unknown)'}`,
      `- requested_surface: ${String(event?.requested_surface_id || event?.requested_doc || '').trim() || '(unknown)'}`,
      `- reason: ${String(event?.reason || error?.message || error || 'memory write rejected').trim()}`,
    ];
    try {
      tracking.append(jobId, 'decisions', lines.join('\n'));
    } catch {
      jobs.log(jobId, lines.join(' | '));
    }
  }

  function appendRoleAwareTrackingWithStatus(jobId, markdown, { provider = '', roleId = '', purpose = 'worklog', fallbackDoc = 'progress', requestedDoc = '' } = {}) {
    const cleanMarkdown = String(markdown || '').trim();
    if (!cleanMarkdown) return { writeEvent: null, blocked: false, skipped: true };
    try {
      const writeEvent = tracking.appendWithContract(jobId, requestedDoc || fallbackDoc, cleanMarkdown, {
        provider,
        roleId,
        purpose,
        fallbackDoc,
        strict: true,
        source: 'agent_output',
      });
      void syncRoleAwareMemoryWriteToGoc(jobId, cleanMarkdown, {
        provider,
        roleId,
        purpose,
        writeEvent,
      });
      return { writeEvent, blocked: false, skipped: false };
    } catch (error) {
      const writeEvent = error?.memory_write_event && typeof error.memory_write_event === 'object'
        ? error.memory_write_event
        : { status: 'rejected', reason: String(error?.message || error || 'append_with_contract_failed') };
      recordBlockedMemoryWriteAudit(jobId, {
        provider,
        roleId,
        purpose,
        writeEvent,
        error,
      });
      return { writeEvent, blocked: true, skipped: false };
    }
  }

  function appendRoleAwareTracking(jobId, markdown, options = {}) {
    return appendRoleAwareTrackingWithStatus(jobId, markdown, options).writeEvent;
  }

  return {
    deriveGocMemoryNodePayload,
    syncRoleAwareMemoryWriteToGoc,
    recordBlockedMemoryWriteAudit,
    appendRoleAwareTracking,
    appendRoleAwareTrackingWithStatus,
  };
}
