// @vitest-environment jsdom
/** Product interactions against the browser platform seam. Native visuals need Chromium.
 * The published platform SDK bundles no Node runtime dependencies (e.g. clsx).
 */
import { act, createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SwarmCard, type SwarmCardProps } from '../src/client/SwarmCard.tsx'
import { SwarmBadge } from '../src/client/SwarmBadge.tsx'
import { SwarmSettingsCard, SwarmSettingsCardController, type SwarmSettings, type SwarmSettingsCardProps } from '../src/client/SwarmSettingsCard.tsx'
import { en, zh, type SwarmTranslate } from '../src/client/locales.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { clearSwarmModes, dropSwarmProgress, publishSwarmMode, publishSwarmProgress } from '../src/client/progress-store.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement: el, forwardRef } = await import('react')
  return {
    Button: forwardRef(({ variant: _v, size: _s, children, ...rest }: any, ref: any) => el('button', { ...rest, ref }, children)),
    Input: forwardRef((props: any, ref: any) => el('input', { ...props, ref })),
    Checkbox: ({ checked, onChange, label, disabled }: any) => el('label', null,
      el('input', { type: 'checkbox', checked, disabled, onChange: (event: any) => onChange(event.target.checked) }), label),
    Switch: ({ checked, onChange, label, disabled }: any) => el('label', null,
      el('input', { type: 'checkbox', role: 'switch', checked, disabled, onChange: (event: any) => onChange(event.target.checked) }), label),
    SegmentedControl: ({ value, options, onChange }: any) => el('div', { role: 'tablist' }, options.map((option: any) =>
      el('button', { key: option.value, role: 'tab', 'aria-selected': option.value === value, onClick: () => onChange(option.value) }, option.label))),
    Tooltip: ({ children }: any) => children,
    Tag: ({ children }: any) => el('span', null, children),
    StateDot: ({ state }: any) => el('span', { 'data-state': state }),
    TextShimmer: ({ children }: any) => el('span', null, children),
    MarkdownText: ({ text }: any) => el('span', { 'data-markdown': text }, text),
    DisclosureRow: ({ title, open, expandable, onToggle, collapsedContent, children }: any) => el('div', null,
      el('button', { onClick: onToggle, disabled: !expandable, 'aria-expanded': open }, title),
      collapsedContent, open && children),
  }
})
vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore: (initial: unknown) => {
    let value = initial
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => value,
      set: (next: unknown) => { value = next; for (const listener of listeners) listener() },
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    }
  },
}))

const t: TranslateNS<'kimicode.swarm'> = (key, params) => en[key as keyof typeof en].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name]))
function useDisclosure() {
  const [expanded, setExpanded] = useState(false)
  const toggle = useCallback(() => setExpanded((value) => !value), [])
  return { expanded, setExpanded, toggle }
}
let root: Root, container: HTMLDivElement
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); clearSwarmModes(); dropSwarmProgress('card-test', 'parent')
})
async function render(component: React.ReactNode) { await act(async () => root.render(component)) }
async function click(text: string) {
  const target = [...container.querySelectorAll('button,[role=button]')].find((node) => node.textContent?.includes(text)) as HTMLElement | undefined
  expect(target, `control ${text}`).toBeDefined()
  await act(async () => target!.click())
}
const props = (extra: Record<string, unknown> = {}): SwarmCardProps => ({
  phase: 'start', toolName: 'swarm_batch', callId: 'card-test', swarmSessionId: 'parent', t, useDisclosure,
  openFile: vi.fn(), loadImage: vi.fn(), block: { argsRaw: JSON.stringify({ description: 'Review modules', items: ['a', 'b'] }) }, ...extra,
} as unknown as SwarmCardProps)
const result = (content: string, meta?: unknown) => ({
  time: Date.now(), isError: false, content: [{ type: 'text', text: content }], call: null, meta,
})

describe('swarm card platform integration', () => {
  it('renders live counts, a segmented accessible bar, filtering and child navigation', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      index: index + 1, item: `module-${index}`, type: 'coder', model: 'local-model',
      status: index < 12 ? 'completed' as const : index < 17 ? 'running' as const : index < 19 ? 'queued' as const : 'rate_limited' as const,
      agentId: `child-${index}`, startedAt: Date.now() - 5000, retries: 1, retryAt: Date.now() + 6000, toolCalls: 8, activity: 'Read',
    }))
    publishSwarmProgress('card-test', rows, 'parent')
    const openAgent = vi.fn()
    await render(<SwarmCard {...props({ openAgent })} />)
    expect(container.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('12')
    expect(container.querySelector('[role=progressbar]')?.getAttribute('aria-valuemax')).toBe('20')
    expect(container.querySelectorAll('li')).toHaveLength(20)
    expect(container.textContent).toContain('Read · 8 tools')
    expect(container.textContent).toContain('Retry in 6s')
    await click('Active')
    expect(container.querySelectorAll('li')).toHaveLength(8)
    const jump = container.querySelector('button[aria-label="Open child session"]') as HTMLButtonElement
    await act(async () => jump.click())
    expect(openAgent).toHaveBeenCalledWith('child-12')
    await click('Failed')
    expect(container.querySelectorAll('li')).toHaveLength(0)
  })

  it('collapses all-completed rows by default and passes Markdown to the platform with copying', async () => {
    const meta = { description: 'Done', subagents: [{ index: 1, item: 'a', type: 'coder', model: null, agentId: 'child', status: 'completed', result: '**reviewed**', error: null }] }
    const copy = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
    await render(<SwarmCard {...props({ phase: 'result', block: result('ok', meta) })} />)
    expect(container.querySelectorAll('li')).toHaveLength(0)
    await click('Swarm · Done')
    await act(async () => (container.querySelector('li button') as HTMLButtonElement).click())
    expect(container.querySelector('[data-markdown]')?.getAttribute('data-markdown')).toBe('**reviewed**')
    await click('Copy')
    expect(copy).toHaveBeenCalledWith('**reviewed**')
  })

  it('opens the first failed row and hides navigation if services are unavailable', async () => {
    const meta = { description: 'Failed batch', subagents: [
      { index: 1, item: 'a', type: 'coder', model: null, status: 'failed', error: 'first error', result: null },
      { index: 2, item: 'b', type: 'coder', model: null, status: 'failed', error: 'second error', result: null },
    ] }
    await render(<SwarmCard {...props({ phase: 'result', block: result('failed', meta) })} />)
    expect(container.textContent).toContain('first error')
    expect(container.textContent).not.toContain('second error')
    expect(container.querySelector('[aria-label="Open child session"]')).toBeNull()
  })

  it('keeps refreshed cancellation XML collapsed and presents pre-start rejection compactly', async () => {
    const xml = '<agent_swarm_result><summary>aborted: 2</summary></agent_swarm_result>'
    await render(<SwarmCard {...props({ phase: 'result', block: { ...result(xml), isError: true } })} />)
    expect(container.textContent).toContain('Batch cancelled')
    expect(container.querySelector('pre')).toBeNull()
    await click('Raw result')
    expect(container.querySelector('pre')?.textContent).toBe(xml)
    await render(<SwarmCard {...props({ phase: 'result', block: { ...result('Swarm mode is off.'), isError: true } })} />)
    expect(container.querySelector('section')).toBeNull()
    expect(container.textContent).toBe('Swarm did not start: Swarm mode is off.')
  })

  it('ignores snapshots from another session and stops its clock after settlement', async () => {
    vi.useFakeTimers()
    try {
      publishSwarmProgress('card-test', [{ index: 1, item: 'foreign', type: null, model: null, status: 'running' }], 'another-session')
      await render(<SwarmCard {...props()} />)
      expect(container.textContent).not.toContain('foreign')
      expect(vi.getTimerCount()).toBe(1)
      await render(<SwarmCard {...props({ phase: 'result', block: result('done', { subagents: [] }) })} />)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
})

function settingsHarness(initial: SwarmSettings) {
  let value = initial
  const listeners = new Set<() => void>()
  const set = vi.fn(async (field: string, next: unknown) => {
    value = { ...value, [field]: next }; for (const listener of listeners) listener(); return true
  })
  const scope: any = { getSnapshot: () => ({ status: 'ready', value }), subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) }, set }
  const controller = new SwarmSettingsCardController(scope, async () => ({ default: { provider: 'local', model: 'fake' }, routableProviders: [], groups: [], failures: [] }), async () => ['review'])
  const face = controller.inject()
  const useSwarmSettings = (selector: (state: any) => any) => selector(useSyncExternalStore(face.hooks.swarmSettings.subscribe, face.hooks.swarmSettings.getSnapshot))
  return { controller, face, set, component: <SwarmSettingsCard {...{ ...face, t, useSwarmSettings } as unknown as SwarmSettingsCardProps} /> }
}
describe('settings platform integration', () => {
  it('shows a saved missing model, preset suggestions and unsaved changes', async () => {
    const h = settingsHarness({ modelMapping: [{ type: 'review', provider: '', model: 'retired-model' }] })
    await render(h.component)
    const select = container.querySelector('select[aria-label="Model"]') as HTMLSelectElement
    expect(select.value).toBe('retired-model')
    expect(select.selectedOptions[0].textContent).toContain('not in current catalog')
    expect(container.querySelector('datalist option')?.getAttribute('value')).toBe('review')
    await act(async () => h.face.setRows([{ type: '', provider: '', model: 'm' }]))
    expect(container.textContent).toContain('changes are not saved')
    expect(container.textContent).toContain('must both be non-empty')
    await act(async () => h.face.saveRows())
    expect(h.set).not.toHaveBeenCalled()
    expect((container.querySelector('button[disabled]') as HTMLButtonElement)).not.toBeNull()
    h.controller.dispose()
  })

  it('preserves drafts across other setting writes and converts minutes without a fallback', async () => {
    const h = settingsHarness({ modelMapping: [] })
    h.face.setRows([{ type: 'review', provider: '', model: 'chosen' }])
    h.face.setRequireMode(false)
    await Promise.resolve()
    expect(h.face.hooks.swarmSettings.getSnapshot().rows[0].model).toBe('chosen')
    expect(h.face.hooks.swarmSettings.getSnapshot().dirty).toBe(true)
    h.face.setTimeoutMinutes(2.5)
    await Promise.resolve()
    expect(h.set).toHaveBeenCalledWith('timeoutMs', 150000)
    await h.face.saveRows()
    expect(h.face.hooks.swarmSettings.getSnapshot().dirty).toBe(false)
    h.controller.dispose()
  })
})

describe('mode badge and dictionaries', () => {
  it('only displays its session mode and disables through the injected command action', async () => {
    publishSwarmMode({ sessionId: 'other', active: true, trigger: 'task' })
    const disableMode = vi.fn(async () => { publishSwarmMode({ sessionId: 'parent', active: false, trigger: null }) })
    await render(<SwarmBadge swarmSessionId="parent" t={t} disableMode={disableMode} />)
    expect(container.textContent).toBe('')
    await act(async () => publishSwarmMode({ sessionId: 'parent', active: true, trigger: 'manual' }))
    await click('Swarm')
    expect(disableMode).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('')
  })
  it('provides matching Chinese and English keys', () => expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort()))
})

const ResetContext = createContext(0)
function useResetDisclosure() {
  const reset = useContext(ResetContext)
  const disclosure = useDisclosure()
  useEffect(() => disclosure.setExpanded(false), [reset, disclosure.setExpanded])
  return disclosure
}
describe('owner disclosure and cancellation', () => {
  it('follows owner turn resets without reopening the list', async () => {
    publishSwarmProgress('card-test', [{ index: 1, item: 'a', type: null, model: null, status: 'running' }], 'parent')
    await render(<ResetContext.Provider value={0}><SwarmCard {...props({ useDisclosure: useResetDisclosure })} /></ResetContext.Provider>)
    expect(container.querySelectorAll('li')).toHaveLength(1)
    await render(<ResetContext.Provider value={1}><SwarmCard {...props({ useDisclosure: useResetDisclosure })} /></ResetContext.Provider>)
    expect(container.querySelectorAll('li')).toHaveLength(0)
  })
  it('keeps completed live rows on cancellation while folding the raw result', async () => {
    publishSwarmProgress('card-test', [
      { index: 1, item: 'done', type: null, model: null, status: 'completed' },
      { index: 2, item: 'unfinished', type: null, model: null, status: 'running' },
    ], 'parent')
    await render(<SwarmCard {...props()} />)
    await render(<SwarmCard {...props({ phase: 'result', block: { ...result('<agent_swarm_result>aborted</agent_swarm_result>'), isError: true } })} />)
    expect(container.querySelectorAll('li[data-status="completed"]')).toHaveLength(1)
    expect(container.querySelectorAll('li[data-status="aborted"]')).toHaveLength(1)
    expect(container.querySelector('pre')).toBeNull()
  })
})

describe('declared host services', () => {
  it('injects every required Remote namespace the client reads directly', async () => {
    // A fake context cannot catch an undeclared service: the real one throws on access.
    const { inject } = await import('../src/client/index.ts')
    expect(inject).toEqual(expect.arrayContaining(['remote.session', 'remote.commands']))
    expect(inject).not.toContain('remote.agentPresets')
  })
})
