function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', maxLen = 500) {
  return String(value || '').trim().slice(0, maxLen);
}

function normalizeCommandList(response = {}) {
  if (Array.isArray(response)) return response;
  const row = asObject(response);
  return asArray(row.items || row.commands || row.data);
}

export class RuntimeCommandProcessor {
  constructor({
    client = null,
    workerId = '',
    handlers = {},
    resolveAggregateRevision = null,
    logger = null,
  } = {}) {
    this.client = client || null;
    this.workerId = clean(workerId || process.env.DDALGGAK_RUNTIME_WORKER_ID || 'ddalggak-runtime', 160);
    this.handlers = new Map(Object.entries(asObject(handlers)).map(([key, value]) => [clean(key, 120).toLowerCase(), value]));
    this.resolveAggregateRevision = typeof resolveAggregateRevision === 'function' ? resolveAggregateRevision : null;
    this.logger = typeof logger === 'function' ? logger : null;
  }

  _log(message = '') {
    if (!this.logger) return;
    try { this.logger(String(message || '')); } catch {}
  }

  register(commandType = '', handler = null) {
    const type = clean(commandType, 120).toLowerCase();
    if (!type || typeof handler !== 'function') throw new Error('runtime command handler requires command type and function');
    this.handlers.set(type, handler);
    return this;
  }

  async _ack(commandId, status, { result = {}, errorMessage = '' } = {}) {
    if (!this.client || typeof this.client.acknowledgeRuntimeCommand !== 'function') return null;
    return await this.client.acknowledgeRuntimeCommand(commandId, {
      status,
      worker_id: this.workerId,
      result: asObject(result),
      error_message: clean(errorMessage, 4000),
    });
  }

  async process(command = {}) {
    const row = asObject(command.command || command);
    const commandId = clean(row.command_id, 200);
    const commandType = clean(row.command_type, 120).toLowerCase();
    if (!commandId || !commandType) return { status: 'ignored', reason: 'invalid_command' };
    const handler = this.handlers.get(commandType);
    if (!handler) {
      await this._ack(commandId, 'rejected', { errorMessage: `unsupported command_type: ${commandType}` });
      return { command_id: commandId, status: 'rejected', reason: 'unsupported_command_type' };
    }
    const expectedRevision = Math.max(0, Math.floor(Number(row.expected_revision || 0)));
    if (this.resolveAggregateRevision) {
      const actualRevision = Math.max(0, Math.floor(Number(await this.resolveAggregateRevision({
        aggregateType: clean(row.aggregate_type, 80),
        aggregateId: clean(row.aggregate_id, 200),
        command: row,
      })) || 0));
      if (expectedRevision !== actualRevision) {
        const result = { expected_revision: expectedRevision, actual_revision: actualRevision };
        await this._ack(commandId, 'rejected', { result, errorMessage: 'aggregate revision conflict' });
        return { command_id: commandId, status: 'rejected', reason: 'revision_conflict', ...result };
      }
    }
    try {
      await this._ack(commandId, 'accepted');
    } catch (error) {
      const status = Number(error?.status || 0);
      const message = clean(error?.message || error, 4000);
      if (status === 409) {
        this._log(`[runtime-command] claim skipped id=${commandId}: ${message}`);
        return { command_id: commandId, status: 'skipped', reason: 'claim_conflict' };
      }
      throw error;
    }
    try {
      const result = asObject(await handler({
        commandId,
        commandType,
        threadId: clean(row.thread_id, 160),
        aggregateType: clean(row.aggregate_type, 80),
        aggregateId: clean(row.aggregate_id, 200),
        expectedRevision,
        payload: asObject(row.payload),
        command: row,
      }));
      await this._ack(commandId, 'applied', { result });
      return { command_id: commandId, status: 'applied', result };
    } catch (error) {
      const message = clean(error?.message || error, 4000);
      await this._ack(commandId, 'failed', { errorMessage: message });
      this._log(`[runtime-command] failed id=${commandId} type=${commandType}: ${message}`);
      return { command_id: commandId, status: 'failed', error: message };
    }
  }

  async pollOnce({ limit = 50 } = {}) {
    if (!this.client || typeof this.client.listPendingRuntimeCommands !== 'function') {
      return { processed: 0, skipped: true, results: [] };
    }
    const response = await this.client.listPendingRuntimeCommands({ limit, workerId: this.workerId });
    const commands = normalizeCommandList(response);
    const results = [];
    for (const command of commands) {
      results.push(await this.process(command));
    }
    return { processed: results.length, results };
  }
}
