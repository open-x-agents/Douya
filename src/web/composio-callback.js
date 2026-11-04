// Composio OAuth lands here (popup). Tell the opener / other 豆芽 tabs, then close or go to 信源.
// The callback URL is derived from the origin the user's browser actually uses for 豆芽, so the popup
// is same-origin with the app (cookies, postMessage, BroadcastChannel all work) whatever host/port it runs on.

// Public exact route on the dsh web server (outside the /api auth fence; see dsh-host-routes.js).
export const CALLBACK_PATH = '/composio-callback'
export const MESSAGE_TYPE = 'odm-composio-connected'

const LOGO = "<svg class=\"douya douya-idle\" width=\"64\" height=\"64\" viewBox=\"3 7 58 58\" aria-hidden=\"true\">\n  <defs>\n    <radialGradient id=\"dy-cb-b\" cx=\"22\" cy=\"39\" r=\"38\" gradientUnits=\"userSpaceOnUse\"><stop offset=\"0\" stop-color=\"#b7c4ff\"/><stop offset=\".42\" stop-color=\"#8090f4\"/><stop offset=\".8\" stop-color=\"#6c62d6\"/><stop offset=\"1\" stop-color=\"#5747b4\"/></radialGradient>\n    <radialGradient id=\"dy-cb-rim\" cx=\"42\" cy=\"59\" r=\"22\" gradientUnits=\"userSpaceOnUse\"><stop offset=\"0\" stop-color=\"#e0d0ff\" stop-opacity=\".8\"/><stop offset=\"1\" stop-color=\"#e0d0ff\" stop-opacity=\"0\"/></radialGradient>\n    <radialGradient id=\"dy-cb-in\" cx=\"30\" cy=\"44\" r=\"30\" gradientUnits=\"userSpaceOnUse\"><stop offset=\".7\" stop-color=\"#2a1f6b\" stop-opacity=\"0\"/><stop offset=\"1\" stop-color=\"#2a1f6b\" stop-opacity=\".34\"/></radialGradient>\n    <linearGradient id=\"dy-cb-l\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0\" stop-color=\"#9df2b7\"/><stop offset=\".55\" stop-color=\"#4cc283\"/><stop offset=\"1\" stop-color=\"#23895a\"/></linearGradient>\n    <linearGradient id=\"dy-cb-s\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0\" stop-color=\"#fff\" stop-opacity=\"0\"/><stop offset=\".5\" stop-color=\"#fff\" stop-opacity=\".6\"/><stop offset=\"1\" stop-color=\"#fff\" stop-opacity=\"0\"/></linearGradient>\n    <radialGradient id=\"dy-cb-sh\" cx=\".5\" cy=\".5\" r=\".5\"><stop offset=\"0\" stop-color=\"#4b3ca8\" stop-opacity=\".36\"/><stop offset=\"1\" stop-color=\"#4b3ca8\" stop-opacity=\"0\"/></radialGradient>\n    <radialGradient id=\"dy-cb-gl\" cx=\".5\" cy=\".5\" r=\".5\"><stop offset=\".35\" stop-color=\"#8f86ff\" stop-opacity=\".45\"/><stop offset=\"1\" stop-color=\"#8f86ff\" stop-opacity=\"0\"/></radialGradient>\n    <clipPath id=\"dy-cb-c\"><path d=\"M32 35.4 C38.2 32.2 49.8 31.6 55.2 37.2 C59.4 41.6 59 50 53.4 54.8 C47.2 60 16.8 60 10.6 54.8 C5 50 4.6 41.6 8.8 37.2 C14.2 31.6 25.8 32.2 32 35.4Z\"/></clipPath>\n  </defs>\n  <ellipse class=\"dy-glow\" cx=\"32\" cy=\"47\" rx=\"31\" ry=\"18\" fill=\"url(#dy-cb-gl)\"/>\n  <ellipse class=\"dy-shadow\" cx=\"32\" cy=\"61.8\" rx=\"21\" ry=\"2.6\" fill=\"url(#dy-cb-sh)\"/>\n  <g class=\"dy-all\">\n    <g class=\"dy-sprout\">\n      <path d=\"M32 35.6 C32 29.6 31.2 24.6 32 20.2\" fill=\"none\" stroke=\"#2f9e6b\" stroke-width=\"3\" stroke-linecap=\"round\"/>\n      <g class=\"dy-leaf-l\"><path d=\"M31.4 23.4 C27.6 16.2 19.6 14.4 13.8 17.4 C17.2 24.6 25.6 27.2 31.4 23.4Z\" fill=\"url(#dy-cb-l)\"/><path d=\"M30.4 22.8 C26 19.8 20.6 18.4 16.4 18.2\" fill=\"none\" stroke=\"#d2ffe0\" stroke-opacity=\".6\" stroke-width=\".9\" stroke-linecap=\"round\"/></g>\n      <g class=\"dy-leaf-r\"><path d=\"M32.6 21.4 C35.4 13.6 43.6 10.2 50.6 12.2 C48.6 20.2 40.2 24.4 32.6 21.4Z\" fill=\"url(#dy-cb-l)\"/><path d=\"M33.8 20.4 C38.4 16.8 43.4 14.4 48.6 13.2\" fill=\"none\" stroke=\"#d2ffe0\" stroke-opacity=\".6\" stroke-width=\".9\" stroke-linecap=\"round\"/></g>\n    </g>\n    <g class=\"dy-body\" transform=\"rotate(-4 32 47)\">\n      <path d=\"M32 35.4 C38.2 32.2 49.8 31.6 55.2 37.2 C59.4 41.6 59 50 53.4 54.8 C47.2 60 16.8 60 10.6 54.8 C5 50 4.6 41.6 8.8 37.2 C14.2 31.6 25.8 32.2 32 35.4Z\" fill=\"url(#dy-cb-b)\"/>\n      <path d=\"M32 35.4 C38.2 32.2 49.8 31.6 55.2 37.2 C59.4 41.6 59 50 53.4 54.8 C47.2 60 16.8 60 10.6 54.8 C5 50 4.6 41.6 8.8 37.2 C14.2 31.6 25.8 32.2 32 35.4Z\" fill=\"url(#dy-cb-in)\"/>\n      <path d=\"M32 35.4 C38.2 32.2 49.8 31.6 55.2 37.2 C59.4 41.6 59 50 53.4 54.8 C47.2 60 16.8 60 10.6 54.8 C5 50 4.6 41.6 8.8 37.2 C14.2 31.6 25.8 32.2 32 35.4Z\" fill=\"url(#dy-cb-rim)\"/>\n      <ellipse cx=\"18.6\" cy=\"41\" rx=\"7.2\" ry=\"3.3\" transform=\"rotate(-14 18.6 41)\" fill=\"#fff\" opacity=\".45\"/>\n      <circle cx=\"13.6\" cy=\"45.6\" r=\"1.1\" fill=\"#fff\" opacity=\".55\"/><g clip-path=\"url(#dy-cb-c)\"><rect class=\"dy-sheen\" x=\"-14\" y=\"22\" width=\"12\" height=\"44\" transform=\"skewX(-22)\" fill=\"url(#dy-cb-s)\"/></g>\n    </g>\n    <g class=\"dy-sparks\">\n      <path class=\"dy-spark s1\" d=\"M10 27 l1 2.4 2.4 1 -2.4 1 -1 2.4 -1 -2.4 -2.4 -1 2.4 -1Z\" fill=\"#c9b8ff\"/>\n      <path class=\"dy-spark s2\" d=\"M55 25 l.8 1.9 1.9.8 -1.9.8 -.8 1.9 -.8 -1.9 -1.9 -.8 1.9 -.8Z\" fill=\"#9af0b4\"/>\n      <path class=\"dy-spark s3\" d=\"M44 9 l.7 1.6 1.6.7 -1.6.7 -.7 1.6 -.7 -1.6 -1.6 -.7 1.6 -.7Z\" fill=\"#b3c1ff\"/>\n    </g>\n  </g>\n</svg>"
const LOGO_CSS = "\n.douya{overflow:visible;display:inline-block;vertical-align:middle}\n.douya g,.douya ellipse,.douya rect,.douya path,.douya circle{transform-box:view-box}\n.douya .dy-all{transform-origin:32px 61px}\n.douya .dy-sprout{transform-origin:32px 35.6px}\n.douya .dy-leaf-l{transform-origin:31.4px 23.4px}\n.douya .dy-leaf-r{transform-origin:32.6px 21.4px}\n.douya .dy-glow{transform-origin:32px 47px;opacity:.55}\n.douya .dy-shadow{transform-origin:32px 61.8px}\n.douya .dy-spark{opacity:0}\n.douya .s1{transform-origin:10px 30.4px}.douya .s2{transform-origin:55px 27.7px}.douya .s3{transform-origin:44px 11.3px}\n.douya-idle .dy-all{animation:dy-breathe 4.2s ease-in-out infinite}\n.douya-idle .dy-shadow{animation:dy-shadow 4.2s ease-in-out infinite}\n.douya-idle .dy-leaf-l{animation:dy-sway-l 3.8s ease-in-out infinite}\n.douya-idle .dy-leaf-r{animation:dy-sway-r 3.8s ease-in-out -1.9s infinite}\n.douya-idle .dy-sheen{animation:dy-sheen 5.5s ease-in-out 1s infinite}\n.douya-idle .dy-glow{animation:dy-glow 4.2s ease-in-out infinite}\n.douya-think .dy-all{animation:dy-hop 1.2s cubic-bezier(.35,0,.25,1) infinite}\n.douya-think .dy-shadow{animation:dy-shadow-hop 1.2s cubic-bezier(.35,0,.25,1) infinite}\n.douya-think .dy-sprout{animation:dy-grow 1.2s ease-in-out infinite}\n.douya-think .dy-leaf-l{animation:dy-flut-l .32s ease-in-out infinite alternate}\n.douya-think .dy-leaf-r{animation:dy-flut-r .32s ease-in-out -.16s infinite alternate}\n.douya-think .dy-sheen{animation:dy-sheen 1.6s ease-in-out infinite}\n.douya-think .dy-glow{animation:dy-glow 1.2s ease-in-out infinite}\n.douya-think .dy-spark{animation:dy-spark 1.5s ease-in-out infinite}\n.douya-think .s2{animation-delay:.5s}.douya-think .s3{animation-delay:1s}\n.douya:hover .dy-all,.douya-hover .dy-all{animation:dy-bounce .7s cubic-bezier(.3,1.6,.5,1) 1}\n@keyframes dy-breathe{0%,100%{transform:scale(1,1)}50%{transform:scale(1.03,.97)}}\n@keyframes dy-shadow{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}\n@keyframes dy-sway-l{0%,100%{transform:rotate(-7deg)}50%{transform:rotate(6deg)}}\n@keyframes dy-sway-r{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(7deg)}}\n@keyframes dy-sheen{0%{transform:skewX(-22deg) translateX(0)}35%,100%{transform:skewX(-22deg) translateX(92px)}}\n@keyframes dy-glow{0%,100%{opacity:.35;transform:scale(.94)}50%{opacity:.75;transform:scale(1.04)}}\n@keyframes dy-hop{0%,100%{transform:translateY(0) scale(1,1)}22%{transform:translateY(0) scale(1.05,.94)}45%{transform:translateY(-4px) scale(.97,1.04)}70%{transform:translateY(0) scale(1.03,.97)}}\n@keyframes dy-shadow-hop{0%,100%,22%,70%{transform:scale(1);opacity:1}45%{transform:scale(.8);opacity:.6}}\n@keyframes dy-grow{0%,100%{transform:scaleY(1) rotate(-2deg)}50%{transform:scaleY(1.16) rotate(2deg)}}\n@keyframes dy-flut-l{from{transform:rotate(8deg)}to{transform:rotate(-14deg)}}\n@keyframes dy-flut-r{from{transform:rotate(-8deg)}to{transform:rotate(14deg)}}\n@keyframes dy-spark{0%,100%{opacity:0;transform:scale(.3) rotate(0)}40%{opacity:1;transform:scale(1.1) rotate(45deg)}70%{opacity:0;transform:scale(.6) rotate(90deg)}}\n@keyframes dy-bounce{0%{transform:translateY(0)}35%{transform:translateY(-5px) scale(.97,1.04)}70%{transform:translateY(0) scale(1.04,.96)}100%{transform:none}}\n@media (prefers-reduced-motion:reduce){.douya *{animation:none!important}}\n"

/** Origin of the browser request (Origin header, else forwarded / Host headers), or null. */
export function requestOrigin(request) {
  const h = (k) => { try { return request?.headers?.get?.(k) || null } catch { return null } }
  const ok = (o) => { try { const u = new URL(o); return /^https?:$/.test(u.protocol) ? u.origin : null } catch { return null } }
  const origin = h('origin'); if (origin && origin !== 'null' && ok(origin)) return ok(origin)
  const ref = h('referer'); if (ref && ok(ref)) return ok(ref)
  const host = h('x-forwarded-host') || h('host')
  if (host && /^[\w.-]+(:\d+)?$|^\[[\da-f:]+\](:\d+)?$/i.test(host)) return `${(h('x-forwarded-proto') || 'http').split(',')[0].trim()}://${host}`
  try { return request?.url ? new URL(request.url).origin : null } catch { return null }
}

export function callbackUrlFor(origin, fallback = 'http://127.0.0.1:7777') {
  return `${String(origin || fallback).replace(/\/+$/, '')}${CALLBACK_PATH}`
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/**
 * @param {{ status, connectedAccountId, error, toolkit, accountStatus, appUrl }} o
 * accountStatus: what the server read back from Composio (ACTIVE / INITIATED / …) or null when unverified.
 */
export function callbackPage({ status = '', connectedAccountId = '', error = '', toolkit = '', accountStatus = null, appUrl = '/api/opendigitalmate/app#sources' } = {}) {
  const success = String(status).toLowerCase() === 'success' && (!accountStatus || accountStatus === 'ACTIVE' || accountStatus === 'INITIATED' || accountStatus === 'INITIALIZING')
  const label = { googlecalendar: 'Google 日历', gmail: 'Gmail', github: 'GitHub', slack: 'Slack' }[toolkit] || toolkit || '信源'
  const title = success ? `${esc(label)} 已连接` : '连接没有成功'
  const detail = success
    ? (accountStatus && accountStatus !== 'ACTIVE' ? 'Composio 还在完成授权，豆芽会自动刷新状态。' : '豆芽已经可以读取这个信源了。这个窗口马上自动关闭。')
    : `${esc(error || (accountStatus ? `账号状态 ${accountStatus}` : `状态：${status || '未知'}`))}<br><span class="hint">回到豆芽的「信源状态」页，点对应信源的「连接」再试一次；如果反复失败，检查是否在授权页点了「允许」。</span>`
  const payload = { type: MESSAGE_TYPE, status: success ? 'success' : (status || 'failed'), connectedAccountId: connectedAccountId || null, toolkit: toolkit || null, accountStatus: accountStatus || null, error: success ? null : (error || null) }
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>豆芽 · ${title}</title>
<style>
${LOGO_CSS}
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;background:radial-gradient(1200px 600px at 20% -10%,#eef0ff,transparent),radial-gradient(900px 500px at 110% 110%,#f6ecff,transparent),#f7f7fb;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;color:#1e2233}
.card{width:min(380px,88vw);padding:30px 28px 24px;border-radius:22px;background:rgba(255,255,255,.86);backdrop-filter:blur(18px);border:1px solid #fff;box-shadow:0 18px 50px -22px rgba(70,60,170,.35),0 2px 6px rgba(30,40,80,.06);text-align:center}
.mark{display:flex;justify-content:center;margin-bottom:8px}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:650;padding:3px 10px;border-radius:999px;margin-bottom:10px}
.ok .badge{color:#0a8f5a;background:#e3f6ec}.bad .badge{color:#c2410c;background:#fdeee4}
h1{font-size:19px;margin:0 0 6px;font-weight:700}
p{margin:0;color:#5b6275;font-size:13.5px}
.hint{display:inline-block;margin-top:8px;font-size:12.5px;color:#7a8094}
.acts{margin-top:18px;display:flex;gap:8px;justify-content:center}
.acts a,.acts button{border:0;border-radius:999px;padding:8px 16px;font:600 13px/1 inherit;cursor:pointer;text-decoration:none}
.primary{color:#fff;background:linear-gradient(135deg,#6f8df5,#8a74d0)}
.ghost{color:#5b6275;background:rgba(30,40,80,.06)}
.meta{margin-top:14px;font-size:11px;color:#a0a5b5;word-break:break-all}
</style></head>
<body><main class="card ${success ? 'ok' : 'bad'}" data-status="${success ? 'success' : 'failed'}">
<div class="mark">${LOGO.replace('douya-idle', success ? 'douya-idle' : 'douya-idle')}</div>
<div class="badge">${success ? '✓ 授权完成' : '× 授权未完成'}</div>
<h1>${title}</h1>
<p>${detail}</p>
<div class="acts">${success ? '<button class="primary" id="close">关闭窗口</button>' : `<a class="primary" href="${esc(appUrl)}">回到信源状态</a><button class="ghost" id="close">关闭</button>`}</div>
${connectedAccountId ? `<div class="meta">${esc(connectedAccountId)}</div>` : ''}
</main>
<script>
(function () {
  var msg = ${JSON.stringify(payload).replace(/</g, '\\u003c')};
  var told = false;
  try { if (window.opener && !window.opener.closed) { window.opener.postMessage(msg, location.origin); told = true; } } catch (e) {}
  // OAuth pages often cut window.opener (COOP); same-origin tabs still hear these.
  try { var bc = new BroadcastChannel('odm-composio'); bc.postMessage(msg); setTimeout(function () { bc.close(); }, 500); } catch (e) {}
  try { localStorage.setItem('odm-composio-connected', JSON.stringify(Object.assign({ at: Date.now() }, msg))); } catch (e) {}
  var appUrl = ${JSON.stringify(appUrl).replace(/</g, '\\u003c')};
  document.getElementById('close') && document.getElementById('close').addEventListener('click', function () { window.close(); setTimeout(function () { location.href = appUrl; }, 150); });
  if (msg.status !== 'success') return;
  setTimeout(function () {
    if (told || window.opener) { window.close(); }
    // Not a popup (or close refused): go to 豆芽's 信源 page.
    setTimeout(function () { if (!window.closed) location.replace(appUrl); }, 250);
  }, 1100);
})();
</script></body></html>`
}
