import test from 'node:test'
import assert from 'node:assert/strict'
import { isPersonaTemplate } from '../src/digest/openviking.js'

test('Recall hides unfilled OpenViking persona templates, keeps real memories', () => {
  const base = 'viking://user/default/memories/'
  assert.equal(isPersonaTemplate({ uri: base + 'soul.md', text: "# soul.md - Who You Are _You're not a chatbot. You're becoming someone._" }), true)
  assert.equal(isPersonaTemplate({ uri: base + 'identity.md', text: '# identity.md - Who Am I?  _Fill this in during your first conversation. Make it yours._' }), true)
  assert.equal(isPersonaTemplate({ uri: base + 'identity.md', text: 'Danyang, researcher in Shanghai; ships Douya.' }), false)
  assert.equal(isPersonaTemplate({ uri: base + 'experiences/shipped.md', text: 'Fill this in later: shipped Recall photos' }), false)
  assert.equal(isPersonaTemplate({ uri: base + 'events/merged.md', text: 'Merged timetable fix' }), false)
})
