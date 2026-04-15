import process from 'node:process';

import { sendLong as sendLongAdapter } from '../adapters/telegram/send.js';
import {
  buildGeminiRetryNoticeText as buildGeminiRetryNoticeTextShared,
  buildGeminiModelSwitchNoticeText as buildGeminiModelSwitchNoticeTextShared,
  buildGeminiGiveUpNoticeText as buildGeminiGiveUpNoticeTextShared,
} from '../adapters/telegram/status_messages.js';
import { clip } from '../textutil.js';

export function sendLong(bot, chatId, text, options = undefined) {
  return sendLongAdapter(bot, chatId, text, options);
}

export function useCompactProgressUpdates(verbose = false) {
  if (verbose) return false;
  return String(process.env.TELEGRAM_PROGRESS_DETAIL_MODE || '').trim().toLowerCase() !== 'full';
}

export function buildCompactExecutionUpdateText({ displayName = '', output = '', routeSignals = [], final = false } = {}) {
  const lines = [
    final ? '🧩 최종 합성 완료' : '🤖 실행 완료',
    displayName ? `- agent: ${displayName}` : '',
    Array.isArray(routeSignals) && routeSignals.length > 0 ? `- route_signals: ${routeSignals.join(', ')}` : '',
    output ? `- preview: ${clip(String(output || '').trim(), 500)}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

export function summarizeUserSafeGocFallbackReason(raw = '') {
  const reason = String(raw || '').trim();
  if (!reason) return 'projection_unavailable';
  if (/timeout|timed out|deadline|etimedout/i.test(reason)) return 'projection_timeout';
  if (/401|403|forbidden|unauthori[sz]ed|token/i.test(reason)) return 'projection_access_denied';
  if (/404|not found|missing/i.test(reason)) return 'projection_missing';
  if (/connect|econn|network|socket|dns|fetch/i.test(reason)) return 'projection_network_error';
  return 'projection_unavailable';
}

function resolveReplyId(replyToMessageId = null, getFallbackReplyId = null) {
  const fallbackReply = typeof getFallbackReplyId === 'function' ? getFallbackReplyId() : null;
  if (Number.isFinite(Number(replyToMessageId)) && Number(replyToMessageId) > 0) return Number(replyToMessageId);
  if (Number.isFinite(Number(fallbackReply)) && Number(fallbackReply) > 0) return Number(fallbackReply);
  return null;
}

function resolveAgentLabel(agentId = '', resolveAgentLabel = null) {
  if (!agentId || typeof resolveAgentLabel !== 'function') return '';
  try {
    return String(resolveAgentLabel(agentId) || '').trim();
  } catch {
    return '';
  }
}

export async function sendGeminiRetryMessage(
  bot,
  chatId,
  {
    retryCount = 0,
    maxRetries = 0,
    agentId = '',
    replyToMessageId = null,
    getFallbackReplyId = null,
    resolveAgentLabel: resolveAgentLabelFn = null,
  } = {}
) {
  const replyId = resolveReplyId(replyToMessageId, getFallbackReplyId);
  const agentLabel = resolveAgentLabel(agentId, resolveAgentLabelFn);
  await bot.sendMessage(
    chatId,
    buildGeminiRetryNoticeTextShared({ retryCount, maxRetries, agentId, agentLabel }),
    replyId ? { reply_to_message_id: replyId } : undefined,
  );
}

export async function sendGeminiModelSwitchMessage(
  bot,
  chatId,
  {
    toModel = '',
    agentId = '',
    replyToMessageId = null,
    getFallbackReplyId = null,
    resolveAgentLabel: resolveAgentLabelFn = null,
  } = {}
) {
  const replyId = resolveReplyId(replyToMessageId, getFallbackReplyId);
  const agentLabel = resolveAgentLabel(agentId, resolveAgentLabelFn);
  await bot.sendMessage(
    chatId,
    buildGeminiModelSwitchNoticeTextShared({ toModel, agentId, agentLabel }),
    replyId ? { reply_to_message_id: replyId } : undefined,
  );
}

export async function sendGeminiGiveUpMessage(
  bot,
  chatId,
  {
    reason = '',
    agentId = '',
    replyToMessageId = null,
    getFallbackReplyId = null,
    resolveAgentLabel: resolveAgentLabelFn = null,
  } = {}
) {
  const replyId = resolveReplyId(replyToMessageId, getFallbackReplyId);
  const agentLabel = resolveAgentLabel(agentId, resolveAgentLabelFn);
  await bot.sendMessage(
    chatId,
    buildGeminiGiveUpNoticeTextShared({ reason, agentId, agentLabel }),
    replyId ? { reply_to_message_id: replyId } : undefined,
  );
}

export async function notifyAndConsumeGocFallback(
  bot,
  chatId,
  {
    notify = true,
    takeFallbackReason = null,
    summarizeFallbackReason = summarizeUserSafeGocFallbackReason,
  } = {}
) {
  if (typeof takeFallbackReason !== 'function') return '';
  const rawReason = String(takeFallbackReason() || '').trim();
  if (!rawReason) return '';
  if (notify) {
    const cleanReason = typeof summarizeFallbackReason === 'function'
      ? summarizeFallbackReason(rawReason)
      : summarizeUserSafeGocFallbackReason(rawReason);
    await bot.sendMessage(
      chatId,
      `⚠️ GoC 컨텍스트 조회 실패로 local fallback 사용 중입니다.\nreason=${cleanReason}`,
    );
  }
  return rawReason;
}
