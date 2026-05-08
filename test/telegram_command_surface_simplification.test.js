import test from 'node:test'
import assert from 'node:assert/strict'

import { createTelegramCommandHandler } from '../src/adapters/telegram/commands.js'

function makeBot(sent) {
  return {
    async sendMessage(chatId, text) {
      sent.push({ chatId, text })
      return { message_id: sent.length }
    },
  }
}

test('/help shows compact command surface and points to /help more', async () => {
  const sent = []
  const handler = createTelegramCommandHandler({
    bot: makeBot(sent),
  })

  const handled = await handler({ msg: { chat: { id: 'chat-1' }, from: { id: 'user-1' } }, text: '/help', chatId: 'chat-1', userId: 'user-1' })

  assert.equal(handled, true)
  assert.match(sent[0].text, /\/chat <text>/)
  assert.match(sent[0].text, /\/task loop <목표>/)
  assert.match(sent[0].text, /\/agents suggest <목표>/)
  assert.match(sent[0].text, /\/review/)
  assert.match(sent[0].text, /\/help more/)
  assert.doesNotMatch(sent[0].text, /\/team suggest/)
  assert.doesNotMatch(sent[0].text, /\/outputs/)
})

test('public agent room and legacy artifact aliases return compact guidance', async () => {
  const sent = []
  const handler = createTelegramCommandHandler({
    bot: makeBot(sent),
  })

  await handler({ msg: { chat: { id: 'chat-1' }, from: { id: 'user-1' } }, text: '/agents', chatId: 'chat-1', userId: 'user-1' })
  await handler({ msg: { chat: { id: 'chat-1' }, from: { id: 'user-1' } }, text: '/outputs', chatId: 'chat-1', userId: 'user-1' })
  await handler({ msg: { chat: { id: 'chat-1' }, from: { id: 'user-1' } }, text: '/sendfile foo.txt', chatId: 'chat-1', userId: 'user-1' })

  assert.match(sent[0].text, /Agent Room/)
  assert.match(sent[0].text, /\/agents suggest/)
  assert.match(sent[1].text, /\/artifacts/)
  assert.match(sent[2].text, /\/send <번호\|path>/)
})


test('/team defaults to a compact summary and details are explicit', async () => {
  const sent = []
  const sessionStore = new Map()
  sessionStore.set('chat-1', {
    team_config: {
      status: 'configured',
      active_team: {
        team_name: 'starter_team',
        composition_mode: 'structured',
        agents: [{ agent_id: 'research_lead' }],
      },
      pending_team: {
        team_name: 'review_team',
        composition_mode: 'freeform',
        agents: [{ agent_id: 'research_lead' }, { agent_id: 'reviewer' }],
      },
    },
  })
  const handler = createTelegramCommandHandler({
    bot: makeBot(sent),
    sendLong: async (_bot, chatId, text) => {
      sent.push({ chatId, text })
      return { message_id: sent.length }
    },
    chatSessionStore: sessionStore,
    resolveLiveJobIdForChat: () => null,
  })

  await handler({ msg: { chat: { id: 'chat-1' }, from: { id: 'user-1' } }, text: '/team', chatId: 'chat-1', userId: 'user-1' })

  assert.ok(sent[0].text.startsWith('Advanced team topology'))
  assert.match(sent[0].text, /active: starter_team/)
  assert.match(sent[0].text, /pending: review_team/)
  assert.match(sent[0].text, /\/agents 권장/)
  assert.doesNotMatch(sent[0].text, /Team commands:/)
})

test('/team details still exposes the fuller state view', async () => {
  const sent = []
  const sessionStore = new Map()
  sessionStore.set('chat-1', {
    team_config: {
      status: 'configured',
      active_team: {
        team_name: 'starter_team',
        composition_mode: 'structured',
        agents: [{ agent_id: 'research_lead' }],
      },
      pending_team: null,
    },
  })
  const handler = createTelegramCommandHandler({
    bot: makeBot(sent),
    sendLong: async (_bot, chatId, text) => {
      sent.push({ chatId, text })
      return { message_id: sent.length }
    },
    chatSessionStore: sessionStore,
    resolveLiveJobIdForChat: () => null,
  })

  await handler({ msg: { chat: { id: 'chat-1' }, from: { id: 'user-1' } }, text: '/team details', chatId: 'chat-1', userId: 'user-1' })

  assert.match(sent[0].text, /Runtime state/)
  assert.match(sent[0].text, /Team commands/)
  assert.match(sent[0].text, /advanced alias/)
})
