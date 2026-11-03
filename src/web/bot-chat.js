// DEPRECATED shim — chat goes through ds-bot (see dsbot-chat.js).
export { BOT_SESSION_ID, chatWithDsBot as chatWithBot, loadDsBotHistory as loadHistory } from './dsbot-chat.js'

export async function loadMemory() {
  return '# Memory\n\n（长期记忆由 ds-bot 自己的 memory 模块管理，不再使用本文件。）\n'
}

export async function saveMemory() {
  throw new Error('bot-chat MEMORY.md removed — use ds-bot memory tools')
}

export async function saveHistory() {
  throw new Error('bot-chat history.json removed — use ds-bot chat transcript')
}
