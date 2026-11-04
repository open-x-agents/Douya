// What the user's chat bubble shows, kept apart from what Chief is prompted with.
// The prompt carries model-only context (【当前视图】, 【当前卡片】, the 【附件】 note with inlined file
// bodies, merge / steer notes). The bubble shows only the user's own words plus attachment thumbnails / chips.
// Recorded per prompt request id (ds-bot keeps it on the user message as source.rpcId), so history
// rehydrate maps a session user message back to its display form structurally. Images are saved by
// content hash and served back for thumbnails.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const ATTACH_MARK = '【附件】'
const MAX_ENTRIES = 400
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
export const MIME_OF_EXT = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]))

const b64Of = (a) => String(a?.data || '').replace(/^data:[^,]*,/, '')

/** Bubble-safe attachment meta (no bytes). Images get `ref` = sha256 of the bytes when saved. */
export function attachmentMeta(a, ref = null) {
  const b64 = b64Of(a)
  const bytes = Number(a?.bytes) || (b64 ? Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0) : 0)
  const kind = a?.kind === 'image' || /^image\//.test(a?.mediaType || '') ? 'image' : 'file'
  return { kind, name: String(a?.name || (kind === 'image' ? '图片' : '文件')).slice(0, 120), bytes, mediaType: a?.mediaType || null, ...(ref ? { ref } : {}) }
}

export function createChatDisplay({ home = '.odm-data', now = () => Date.now() } = {}) {
  const file = join(home, 'chat-display.json')
  const dir = join(home, 'chat-attachments')
  let state = null
  const load = () => {
    if (state) return state
    try { state = JSON.parse(readFileSync(file, 'utf8')) } catch { state = null }
    if (!state || typeof state !== 'object' || !state.byRpc) state = { byRpc: {}, order: [] }
    return state
  }
  const save = () => {
    try { mkdirSync(home, { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(state)); renameSync(tmp, file) } catch {}
  }

  function saveImage(a) {
    const b64 = b64Of(a)
    if (!b64) return null
    const buf = Buffer.from(b64, 'base64')
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null
    const ext = EXT[String(a.mediaType || '').toLowerCase()] || 'png'
    const ref = `${createHash('sha256').update(buf).digest('hex')}.${ext}`
    try { mkdirSync(dir, { recursive: true }); const p = join(dir, ref); if (!existsSync(p)) writeFileSync(p, buf) } catch { return null }
    return ref
  }

  /** items: [{ text, attachments: raw [{kind,name,mediaType,data}] }] — one per user bubble this prompt stands for. */
  function record(rpcId, items = []) {
    if (!rpcId) return null
    const s = load()
    const clean = items.map(it => ({
      text: String(it?.text ?? '').trim(),
      attachments: (Array.isArray(it?.attachments) ? it.attachments : []).map(a => attachmentMeta(a, attachmentMeta(a).kind === 'image' ? saveImage(a) : null)),
    })).filter(it => it.text || it.attachments.length)
    if (!clean.length) return null
    if (!s.byRpc[rpcId]) s.order.push(rpcId)
    s.byRpc[rpcId] = { at: now(), items: clean }
    while (s.order.length > MAX_ENTRIES) delete s.byRpc[s.order.shift()]
    save()
    return clean
  }

  const lookup = (rpcId) => (rpcId && load().byRpc[rpcId]?.items) || null

  /** Path of a saved image for the thumbnail route; null for anything that is not one of ours. */
  function imagePath(ref) {
    if (!/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(String(ref || ''))) return null
    const p = join(dir, ref)
    return existsSync(p) ? p : null
  }

  return { record, lookup, saveImage, imagePath, file, dir }
}

/** Legacy history (before display records): our own prompt layout puts the note after the user's words. */
export function stripAttachNote(text) {
  const s = String(text || '')
  const i = s.indexOf(`\n\n${ATTACH_MARK}\n`)
  if (i >= 0) return s.slice(0, i).trim()
  return s.startsWith(`${ATTACH_MARK}\n`) ? '' : s
}

/** Attachment chips for a legacy user message, from its structured image/file parts (+ names from the note). */
export function legacyAttachments(parts = [], text = '') {
  const names = [...String(text || '').matchAll(/(图片|文件)「([^」]+)」/g)].map(m => ({ kind: m[1] === '图片' ? 'image' : 'file', name: m[2] }))
  const out = []
  const imgNames = names.filter(n => n.kind === 'image'), fileNames = names.filter(n => n.kind === 'file')
  let ii = 0, fi = 0
  for (const p of Array.isArray(parts) ? parts : []) {
    if (p?.type === 'image') { const a = p.attachment || {}; out.push({ kind: 'image', name: imgNames[ii++]?.name || '图片', bytes: Number(a.bytes) || 0, mediaType: a.mediaType || null }) }
    else if (p?.type === 'file') { const a = p.attachment || p.file || {}; out.push({ kind: 'file', name: fileNames[fi++]?.name || a.name || '文件', bytes: Number(a.bytes) || 0, mediaType: a.mediaType || null }) }
  }
  // Text-fallback turns carry no parts, only the note: chips from the note alone.
  if (!out.length) for (const n of names) out.push({ kind: n.kind, name: n.name, bytes: 0, mediaType: null })
  return out
}
