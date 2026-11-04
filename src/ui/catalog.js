// The vetted component catalog for 豆芽 temporary views (Intelligent UI P2).
// One place lists every component Chief may use and the props each accepts; validate.js rejects anything else,
// hydrate.js fills data from the store, and the prompt Chief sees is generated from this table so docs and code
// can't drift apart. Components only grow (never removed), and stay small in number.

export const LIMITS = {
  components: 60, depth: 4, specBytes: 24_000, title: 60, label: 40, text: 500, longText: 1000,
  rows: 50, columns: 8, buttons: 6, fields: 12, options: 20, pairs: 20, annotations: 50, prompt: 300,
  dataKeys: 40, dataBytes: 16_000, template: 4000,
}

/** Row fields a table / list / comparison may show. Values always come from the store. */
export const ITEM_FIELDS = { title: '标题', from: '来自', at: '时间', status: '状态', type: '类型', replies: '回复', text: '内容', cardTitle: '所在卡片', source: '来源', note: '备注' }
export const CARD_FIELDS = { title: '标题', source: '来源', type: '类型', priority: '优先级', needsYou: '需要你', next: '下一步', openItems: '待处理', items: '条目', note: '备注' }
export const GROUP_BY = ['status', 'from', 'type', 'source', 'cardTitle', 'day', 'priority']
export const TONES = ['info', 'warn', 'success']

// prop kinds: text | longText | label | bool | enum:<a|b> | children | source | columns | fields(list of row
// fields) | rowActions | annotations | pairs | formFields | submit | buttons | dataText | groupBy
export const CATALOG = {
  Column: { desc: '纵向排列子组件', props: { children: 'children', title: 'label' } },
  Section: { desc: '带小标题的分组', props: { children: 'children', title: 'label' } },
  Text: { desc: '一段文字（纯文本，可 {"$data":"key"}）', props: { text: 'dataText' } },
  Callout: { desc: '一句结论 / 提醒', props: { text: 'dataText', tone: 'enum:info|warn|success' } },
  Table: { desc: '表格，行来自 source；列是字段名；可排序；行按钮', props: { title: 'label', source: 'source', columns: 'columns', sortable: 'bool', rowActions: 'rowActions', annotations: 'annotations' } },
  List: { desc: '列表，每行标题 + 次要字段', props: { title: 'label', source: 'source', fields: 'fields', rowActions: 'rowActions', annotations: 'annotations' } },
  Comparison: { desc: '对比：每个条目一列，每个字段一行', props: { title: 'label', source: 'source', fields: 'fields', annotations: 'annotations' } },
  KeyValue: { desc: '键值对；值可为文字、{"$count":source}、{"$card":{"card":id,"field":"title|next|priority|source|status"]]、{"$data":key}', props: { title: 'label', pairs: 'pairs' } },
  Timeline: { desc: '按时间排列 source 里的条目', props: { title: 'label', source: 'source' } },
  Chart: { desc: '柱状 / 折线图，数值是 source 按 groupBy 计数（服务端算）', props: { title: 'label', kind: 'enum:bar|line', source: 'source', groupBy: 'groupBy' } },
  Form: { desc: '表单：text / textarea / select / checkbox；提交 = 发一句话给豆芽，或生成待你确认的草稿', props: { title: 'label', fields: 'formFields', submit: 'submit' } },
  Buttons: { desc: '一排按钮：openLink（只能是卡片里已有的链接）/ openCard / uiOp / prompt', props: { buttons: 'buttons' } },
}

/** Text Chief reads (system prompt section). Generated from CATALOG so it never drifts from validation. */
export function catalogPrompt() {
  const comps = Object.entries(CATALOG).map(([k, v]) => `- ${k}：${v.desc}（${Object.keys(v.props).join(', ')}）`).join('\n')
  return `## 临时视图（odm_ui_render / odm_ui_update）
用户要「做成表格 / 列个清单 / 对比一下 / 画个图 / 给我个表单」时，用 odm_ui_render 生成视图，回复里一句话说明即可，不要再用文字把表格写一遍。
- components 是数组，每个 {id, type, ...props}；id 为 "root" 的（或第一个）是根，Column/Section 用 children 引用其他 id。最多 ${LIMITS.components} 个组件、嵌套 ${LIMITS.depth} 层。
${comps}
- 数据只能引用，不能自己写：source = {"card":"<卡片id>"} 或 {"cards":"needs-you"|"all"|["id",...]}，加 "rows":"items"（卡片里的条目：PR、邮件、消息）或 "cards"（卡片本身），可选 "where":{"status":"open|done|dismissed|all","type":"pr|issue|email|slack","source":"github|gmail|slack"}、"limit"。
- 条目字段：${Object.keys(ITEM_FIELDS).join(', ')}；卡片字段：${Object.keys(CARD_FIELDS).join(', ')}。链接自动来自条目，绝不要自己写 URL；数字由服务端计数，绝不要自己写数字。
- annotations = {"<条目url 或 卡片id>": "一句你的点评"}，显示为「备注」列（只能是 source 里已有的行）。
- 按钮 do 只能是 {"openLink":"<卡片里已有的链接>"}、{"openCard":"<卡片id>"}、{"uiOp":{...odm_ui_op 参数]]、{"prompt":"一句话"}；rowActions 里可用 "$row.url"、"$row.cardId"，prompt 里可用 [[title]]。按钮不能发送、确认或执行任何东西。
- Form：fields=[{name, kind:"text|textarea|select|checkbox", label, options:[{label,value}], value}]；submit={label, do:{"prompt":"…[[字段名]]…"]] 或 {label, do:{"draft":{"action":"gmail_reply|gmail_send_email|slack_reply|github_comment|…(需确认的 odm_act_*)","args":{参数: "文字[[字段名]]" | {"$field":"字段名"} | {"$item":{"card":"id","item":"条目url"},"field":"url|from|threadId|title"]]]]}。draft 只会生成「待你确认」卡，用户点确认才执行。
- dataModel：视图里可变的数据（表单默认值、选中项、说明文字），组件里用 {"$data":"key"} 引用；之后用 odm_ui_update 只改 dataModel。
- 出错时工具会返回 path 和原因，按提示改好再调一次。`
}
