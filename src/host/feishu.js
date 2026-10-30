// Contract with Feishu's open platform. The SDK is imported lazily inside the sender, never
// at the top of the module: a host that never sends a card, and every test that injects a
// stub sender, must run without the package installed.

export const SDK_PACKAGE = '@larksuiteoapi/node-sdk'
export const DEFAULT_RECEIVE_ID_TYPE = 'open_id'

export function createFeishuSender({ credentials, importSdk = () => import(SDK_PACKAGE), log = () => {} } = {}) {
  let client

  async function clientOf() {
    if (client !== undefined) return client
    const app = credentials?.()
    if (app?.appId === undefined || app?.appSecret === undefined) {
      throw new Error('A Feishu app id and app secret are needed before a card can be sent')
    }
    const sdk = await importSdk()
    const Lark = sdk?.default ?? sdk
    if (typeof Lark?.Client !== 'function') throw new Error(`${SDK_PACKAGE} does not export Client`)
    client = new Lark.Client({ appId: app.appId, appSecret: app.appSecret })
    return client
  }

  return {
    async sendCard({ receiveId, receiveIdType = DEFAULT_RECEIVE_ID_TYPE, card }) {
      if (typeof receiveId !== 'string' || receiveId === '') throw new Error('A card needs a receive_id')
      const im = (await clientOf()).im
      const response = await im.v1.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: receiveId, msg_type: 'interactive', content: JSON.stringify(card) },
      })
      if (response?.code !== undefined && response.code !== 0) {
        throw new Error(`Feishu refused the card: ${response.code} ${response.msg ?? ''}`.trim())
      }
      return response?.data?.message_id
    },

    // Updating in place is what makes a button feel answered: the same message changes,
    // instead of the conversation gaining one more bubble.
    async updateCard({ messageId, card }) {
      if (typeof messageId !== 'string' || messageId === '') throw new Error('An updated card needs a message_id')
      const im = (await clientOf()).im
      const response = await im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      })
      if (response?.code !== undefined && response.code !== 0) {
        log(`update failed: ${response.code} ${response.msg ?? ''}`)
        return false
      }
      return true
    },
  }
}
