import test from 'node:test'
import assert from 'node:assert/strict'
import { ACTIONS } from '../src/web/actions.js'

// dsh defineTool rejects nested object schemas without an explicit additionalProperties
// (gmail_archive_many silently failed to register: "registered 50 tools (failed=1)").
function objectsMissingAdditional(schema, path, out) {
  if (!schema || typeof schema !== 'object') return out
  if (schema.type === 'object' && typeof schema.additionalProperties !== 'boolean') out.push(path)
  if (schema.items) objectsMissingAdditional(schema.items, `${path}.items`, out)
  for (const [k, v] of Object.entries(schema.properties || {})) objectsMissingAdditional(v, `${path}.${k}`, out)
  return out
}

test('every action tool param schema is registrable (explicit additionalProperties on nested objects)', () => {
  const bad = []
  for (const [name, def] of Object.entries(ACTIONS)) {
    for (const [k, v] of Object.entries(def.params || {})) objectsMissingAdditional(v, `${name}.${k}`, bad)
  }
  assert.deepEqual(bad, [])
})
