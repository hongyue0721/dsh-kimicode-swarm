/** Client copy belongs to the host locale registry, including accessibility labels. */
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

export const NS = 'kimicode.swarm'
export const zh = {
  title: 'Swarm', task: '批量子任务', resume: '续做',
  queued: '排队', running: '运行', rate_limited: '限流', completed: '完成', failed: '失败', aborted: '已取消',
  counts: '完成 {completed} · 失败 {failed} · 已取消 {aborted} · 运行 {running} · 排队 {queued} · 限流 {limited}',
  all: '全部', active: '运行中', failures: '失败', progress: 'Swarm 任务进度',
  retry: '重试于 {seconds}s', tools: '{count} 次工具', openAgent: '打开子会话',
  copy: '复制', copied: '已复制', copyFailed: '复制失败：{error}', footnotes: '脚注', raw: '原始结果',
  cancelled: '批次已取消；已完成的结果保留', denied: 'Swarm 未启动：{error}',
  modeHint: 'Swarm 已开启，可能消耗普通任务数倍的 token。点击关闭。', modeOffFailed: '关闭 Swarm 失败：{error}',
  requireMode: '仅在用户开启 Swarm 模式后允许派发', mappingEnabled: '启用类型到模型的映射',
  timeout: '单任务超时（分钟）', unlimitedHint: '0 表示不限时。', concurrency: '批次并发上限',
  concurrencyHint: '0 表示不额外限制。实际并发仍受宿主 maxActiveSubagents 限制（宿主默认 8）。',
  mappingTitle: '类型 → 模型映射', mappingHint: '未命中映射时继承父 Agent 的模型。显式模型优先。',
  type: '类型或预设 ID', provider: '提供方', model: '模型', defaultProvider: '继承提供方', chooseModel: '选择模型',
  unavailableModel: '{model}（不在当前目录）', unavailableProvider: '{provider}（不在当前目录）',
  invalidRow: '类型和模型均不能为空。', remove: '移除', add: '添加映射', save: '保存映射',
  refresh: '刷新目录', loading: '正在读取目录…', unsaved: '映射有未保存的改动', saving: '正在保存…',
  hostRefused: '宿主拒绝了配置更新。', commandUnavailable: '宿主未执行 Swarm 命令。',
  saveFailed: '保存失败：{error}', invalidNumber: '请输入非负数；并发上限必须为整数。',
} as const

export const en: Record<keyof typeof zh, string> = {
  title: 'Swarm', task: 'Batch subtasks', resume: 'Resume',
  queued: 'Queued', running: 'Running', rate_limited: 'Rate limited', completed: 'Completed', failed: 'Failed', aborted: 'Cancelled',
  counts: 'Done {completed} · Failed {failed} · Cancelled {aborted} · Running {running} · Queued {queued} · Limited {limited}',
  all: 'All', active: 'Active', failures: 'Failed', progress: 'Swarm task progress',
  retry: 'Retry in {seconds}s', tools: '{count} tools', openAgent: 'Open child session',
  copy: 'Copy', copied: 'Copied', copyFailed: 'Copy failed: {error}', footnotes: 'Footnotes', raw: 'Raw result',
  cancelled: 'Batch cancelled; completed results are preserved', denied: 'Swarm did not start: {error}',
  modeHint: 'Swarm is on and may consume several times the tokens of a normal task. Click to turn off.', modeOffFailed: 'Could not turn Swarm off: {error}',
  requireMode: 'Require the user to enable Swarm mode before dispatch', mappingEnabled: 'Enable type-to-model mapping',
  timeout: 'Per-task timeout (minutes)', unlimitedHint: '0 means no timeout.', concurrency: 'Batch concurrency cap',
  concurrencyHint: '0 adds no cap. Actual concurrency is still limited by host maxActiveSubagents (host default: 8).',
  mappingTitle: 'Type → model mapping', mappingHint: 'Unmatched types inherit the parent model. Explicit models take priority.',
  type: 'Type or preset ID', provider: 'Provider', model: 'Model', defaultProvider: 'Inherit provider', chooseModel: 'Choose a model',
  unavailableModel: '{model} (not in current catalog)', unavailableProvider: '{provider} (not in current catalog)',
  invalidRow: 'Type and model must both be non-empty.', remove: 'Remove', add: 'Add mapping', save: 'Save mappings',
  refresh: 'Refresh catalog', loading: 'Loading catalog…', unsaved: 'Mapping changes are not saved', saving: 'Saving…',
  hostRefused: 'The host refused the configuration update.', commandUnavailable: 'The host did not execute the Swarm command.',
  saveFailed: 'Save failed: {error}', invalidNumber: 'Enter a non-negative number; concurrency must be an integer.',
}

export type SwarmLocaleKey = keyof typeof zh
export type SwarmTranslate = Translate<SwarmLocaleKey>
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'kimicode.swarm': SwarmLocaleKey }
}
