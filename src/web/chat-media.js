// Muse chat multimodal: validate client uploads, admit them through dsh attachments when available,
// and build sessionController.prompt content. DeepSeek-chat is often text-only — if image input is
// refused we retry with a text description (and inline extractable file text).
import { Buffer } from 'node:buffer'

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const FILE_MAX_BYTES = 20 * 1024 * 1024
export const MAX_IMAGES = 5
export const MAX_FILES = 5
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
export const FILE_EXTS = new Set([
  'pdf', 'txt', 'md', 'markdown', 'csv', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs',
  'html', 'css', 'scss', 'less', 'xml', 'yaml', 'yml', 'toml', 'ini', 'env', 'sh', 'bash',
  'zsh', 'sql', 'log', 'rtf', 'text',
])
const TEXTISH = new Set([...FILE_EXTS].filter(e => e !== 'pdf'))

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const baseName = n => String(n || 'file').replace(/[/\\]/g, '').replace(/[^\w.\u4e00-\u9fff()-]+/g, '_').slice(0, 120) || 'file'
const extOf = n => (String(n || '').split('.').pop() || '').toLowerCase()
/** Canonical base64 only (dsh admission rejects non-canonical / data-URL forms). */
export function canonicalBase64(data) {
  // Allow a data: URL wrapper from FileReader; still require canonical base64 afterward (dsh rule).
  let raw = String(data || '')
  const m = raw.match(/^data:[^;]+;base64,(.*)$/i)
  if (m) raw = m[1]
  if (/\s/.test(raw)) throw Object.assign(new Error('附件编码无效（base64 不能含空白）'), { code: 'INVALID_BASE64' })
  const buf = Buffer.from(raw, 'base64')
  const out = buf.toString('base64')
  if (!raw || out !== raw) throw Object.assign(new Error('附件编码无效（需要标准 base64）'), { code: 'INVALID_BASE64' })
  return { buf: new Uint8Array(buf), b64: out, bytes: buf.byteLength }
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, items: object[] } | { ok: false, error: string }}
 */
export function normalizeAttachments(raw) {
  if (raw == null) return { ok: true, items: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'attachments 必须是数组' }
  if (raw.length > MAX_IMAGES + MAX_FILES) return { ok: false, error: `一次最多附 ${MAX_IMAGES} 张图 + ${MAX_FILES} 个文件` }
  const items = []
  let images = 0, files = 0
  for (const [i, a] of raw.entries()) {
    if (!a || typeof a !== 'object') return { ok: false, error: `附件 #${i + 1} 无效` }
    const kind = a.kind === 'image' || IMAGE_TYPES.has(a.mediaType) ? 'image' : 'file'
    const name = baseName(a.name || (kind === 'image' ? 'image.png' : 'file'))
    let decoded
    try { decoded = canonicalBase64(a.data) } catch (e) { return { ok: false, error: `${name}: ${e.message}` } }
    if (kind === 'image') {
      const mediaType = String(a.mediaType || '').toLowerCase()
      if (!IMAGE_TYPES.has(mediaType)) return { ok: false, error: `${name}: 仅支持 PNG / JPEG / WebP / GIF` }
      if (decoded.bytes > IMAGE_MAX_BYTES) return { ok: false, error: `${name}: 图片超过 ${IMAGE_MAX_BYTES / 1024 / 1024}MB` }
      if (++images > MAX_IMAGES) return { ok: false, error: `一次最多 ${MAX_IMAGES} 张图片` }
      items.push({ kind: 'image', mediaType, name, ...decoded })
    } else {
      const ext = extOf(name)
      if (!FILE_EXTS.has(ext)) return { ok: false, error: `${name}: 不支持的文件类型（.${ext || '?'}）` }
      if (decoded.bytes > FILE_MAX_BYTES) return { ok: false, error: `${name}: 文件超过 ${FILE_MAX_BYTES / 1024 / 1024}MB` }
      if (++files > MAX_FILES) return { ok: false, error: `一次最多 ${MAX_FILES} 个文件` }
      items.push({ kind: 'file', name, ext, ...decoded })
    }
  }
  return { ok: true, items }
}

function attachmentsOf(ctx) {
  try { return typeof ctx?.get === 'function' ? ctx.get('attachments') : ctx?.attachments } catch { return null }
}

function extractText(item) {
  if (item.kind !== 'file' || !TEXTISH.has(item.ext)) return null
  try {
    const t = Buffer.from(item.buf).toString('utf8')
    if (t.includes('\u0000')) return null
    return clip(t, 24_000)
  } catch { return null }
}

/**
 * Build prompt content for sessionController.prompt.
 * @returns {Promise<{ content: object[], meta: object[], mode: 'native'|'text' }>}
 */
export async function buildChatContent(ctx, { text, attachments = [] }, { preferNative = true } = {}) {
  const body = String(text || '').trim()
  const norm = normalizeAttachments(attachments)
  if (!norm.ok) throw Object.assign(new Error(norm.error), { code: 'ATTACH_INVALID' })
  const items = norm.items
  const meta = items.map(it => ({ kind: it.kind, name: it.name, bytes: it.bytes, mediaType: it.mediaType || null }))
  if (!items.length) return { content: [{ type: 'text', text: body || '（空消息）' }], meta, mode: 'text' }

  const store = attachmentsOf(ctx)
  const native = []
  const notes = []
  if (body) native.push({ type: 'text', text: body })

  for (const it of items) {
    if (it.kind === 'image') {
      if (preferNative) native.push({ type: 'image', mediaType: it.mediaType, data: it.b64, name: it.name })
      notes.push(`图片「${it.name}」（${(it.bytes / 1024).toFixed(0)}KB）`)
    } else {
      let ref = null
      if (typeof store?.admitEncodedFile === 'function') {
        try { ref = await store.admitEncodedFile({ data: it.b64, name: it.name }) } catch { /* fall through */ }
      } else if (typeof store?.saveFile === 'function') {
        try { ref = await store.saveFile({ data: it.buf, name: it.name }) } catch { /* */ }
      }
      if (ref && preferNative) native.push({ type: 'file', attachment: ref })
      const extracted = extractText(it)
      if (extracted) notes.push(`文件「${it.name}」全文：\n\`\`\`\n${extracted}\n\`\`\``)
      else notes.push(`文件「${it.name}」（${(it.bytes / 1024).toFixed(0)}KB${ref ? '，已存档' : ''}）`)
    }
  }

  if (preferNative && items.some(i => i.kind === 'image' || i.kind === 'file')) {
    // Ensure there is always a text anchor when only attachments were sent.
    if (!native.some(p => p.type === 'text')) native.unshift({ type: 'text', text: body || `请查看我附上的：${notes.join('；')}` })
    return { content: native, meta, mode: 'native' }
  }

  const textBlock = [body, notes.length ? `【附件】\n${notes.join('\n\n')}` : ''].filter(Boolean).join('\n\n') || '（附件）'
  return { content: [{ type: 'text', text: textBlock }], meta, mode: 'text' }
}

/** True when dsh rejected the prompt because the model cannot take images. */
export function isImageModelError(err) {
  const s = String(err?.message || err || '')
  return /does not support image|MODEL_DOES_NOT_SUPPORT_IMAGES|attachment-invalid|no vision|不能.*图/i.test(s)
}
