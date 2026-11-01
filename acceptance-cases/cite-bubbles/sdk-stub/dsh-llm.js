// Stand-in so the cite runtime test can load the group host without the DeepSeek SDK.
export function createUserMessage(message) {
  return { role: 'user', ...message }
}
