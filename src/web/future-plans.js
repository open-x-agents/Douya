// Long-horizon plans are user state, not digest cards. No embeddings or new service.
import { randomUUID } from 'node:crypto'
import { listOpenVikingMemories } from '../digest/openviking.js'

const text = (value, max = 500) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
const fail = error => ({ ok: false, error })
export function createFutureService({ store, memories = listOpenVikingMemories, emit = () => {} }) {
  let queue = Promise.resolve()
  async function context() {
    try {
      const result = await memories({ limit: 40 })
      return { available: result.available !== false, interests: (result.memories || []).filter(m => m.text).map(m => ({ id: m.id, text: m.text, tags: m.tags })), error: result.error || null }
    } catch (err) { return { available: false, interests: [], error: err.message } }
  }
  function snapshot() { return { ok: true, plans: structuredClone(store.get().futurePlans || []) } }
  async function apply(input = {}, { by = 'chief' } = {}) {
    const op = input.op
    if (by === 'user' && !['accept', 'step', 'archive'].includes(op)) return fail('Use Chief to propose or edit a plan.')
    const plans = structuredClone(store.get().futurePlans || [])
    const now = new Date().toISOString()
    let plan = plans.find(p => p.id === input.id)
    if (op === 'propose' || op === 'create') {
      if (plans.filter(p => p.status !== 'archived').length >= 20) return fail('Archive a plan before adding more (limit 20).')
      if (op === 'create' && input.userAgreed !== true) return fail('Ask the user to agree first, or propose a draft.')
      const title = text(input.title, 100), goal = text(input.goal), step = text(input.step, 240)
      if (!title || !goal || !step) return fail('title, goal and one concrete step are required.')
      // Same goal again (Chief "creating" what it just proposed) must not leave a twin card on Future.
      const key = t => String(t || '').replace(/\s+/g, '').toLowerCase()
      const twin = plans.find(p => p.status !== 'archived' && key(p.title) === key(title))
      if (twin && op === 'create' && twin.status === 'proposed') {
        twin.status = 'active'; twin.acceptedAt = now; twin.updatedAt = now
        await store.save({ futurePlans: plans }, { futurePlans: true })
        emit({ kind: 'future', reason: 'accept' })
        return { ok: true, plan: structuredClone(twin), note: 'Activated the existing proposal with this title instead of adding a second plan.' }
      }
      if (twin) return fail(`A plan titled "${twin.title}" already exists (id ${twin.id}, ${twin.status}); update${twin.status === 'proposed' ? ' or accept' : ''} it instead.`)
      let basis
      if (input.memoryId) {
        const ctx = await context()
        const memory = ctx.interests.find(m => m.id === input.memoryId)
        if (!memory) return fail('Memory not found. Refresh interests or ask the user; never invent a reason.')
        basis = { source: 'memory', id: memory.id, text: memory.text.slice(0, 600) }
      } else {
        const quote = text(input.interestQuote, 600)
        if (!quote) return fail('A real memoryId or the user’s verbatim interestQuote is required.')
        basis = { source: 'user', text: quote }
      }
      plan = { id: randomUUID(), title, goal, basis, status: op === 'create' ? 'active' : 'proposed', steps: [{ id: randomUUID(), text: step, done: false }], createdAt: now, updatedAt: now }
      if (op === 'create') plan.acceptedAt = now
      plans.push(plan)
    } else {
      if (!plan) return fail('Plan not found.')
      if (plan.status === 'archived') return fail('This plan is archived.')
      if (op === 'accept') {
        if (by !== 'user' && input.userAgreed !== true) return fail('User agreement is required to activate a proposal.')
        if (plan.status !== 'proposed') return fail('Only a proposal can be accepted.')
        plan.status = 'active'; plan.acceptedAt = now
      } else if (op === 'update') {
        if (!text(input.title, 100) && !text(input.goal) && !text(input.step, 240)) return fail('Supply a title, goal or step to update.')
        if (text(input.title, 100)) plan.title = text(input.title, 100)
        if (text(input.goal)) plan.goal = text(input.goal)
        if (text(input.step, 240)) {
          if (input.stepId) {
            const step = plan.steps.find(s => s.id === input.stepId)
            if (!step) return fail('Step not found.')
            step.text = text(input.step, 240)
          } else {
            if (plan.steps.length >= 100) return fail('Step limit reached (100).')
            plan.steps.push({ id: randomUUID(), text: text(input.step, 240), done: false })
          }
        }
      } else if (op === 'step') {
        if (plan.status !== 'active') return fail('Accept the proposal before checking off steps.')
        const step = plan.steps.find(s => s.id === input.stepId)
        if (!step) return fail('Step not found.')
        step.done = input.done !== false
        step.doneAt = step.done ? now : null
      } else if (op === 'archive') { plan.status = 'archived' }
      else return fail('Unknown plan operation.')
      plan.updatedAt = now
    }
    await store.save({ futurePlans: plans }, { futurePlans: true })
    emit({ kind: 'future', reason: op })
    return { ok: true, plan: structuredClone(plan) }
  }
  return {
    async get() { return { ...snapshot(), ...await context() } },
    snapshot,
    apply(input, opts) {
      const task = queue.then(() => apply(input, opts))
      queue = task.catch(() => {})
      return task
    },
  }
}
