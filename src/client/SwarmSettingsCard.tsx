/** Native settings controls; mapping drafts survive unrelated setting updates. */
import { useEffect, useId, useState, type JSX } from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_MAX_CONCURRENCY, DEFAULT_REQUIRE_SWARM_MODE, DEFAULT_SWARM_TIMEOUT_MS } from '../defaults.ts'
import { NS, type SwarmTranslate } from './locales.ts'
import css from './swarm.module.css'

export interface SwarmSettings {
  requireSwarmMode?: boolean; timeoutMs?: number; maxConcurrency?: number
  modelMappingEnabled?: boolean; modelMapping?: SwarmMappingRow[]
}
export interface SwarmMappingRow { type: string; provider: string; model: string }
export interface SwarmProviderOption { provider: string; displayName: string }
export interface SwarmModelOption { provider: string; id: string; name: string }
export interface SwarmSettingsCardState {
  available: boolean; requireSwarmMode: boolean; timeoutMs: number; maxConcurrency: number
  modelMappingEnabled: boolean; rows: SwarmMappingRow[]; dirty: boolean; invalidRows: number[]
  providers: SwarmProviderOption[]; models: SwarmModelOption[]; presets: string[]
  catalogLoading: boolean; catalogError: string | null; saving: boolean; saveError: { kind: 'refused' } | { kind: 'error'; message: string } | null
}
export interface SwarmSettingsCardActions {
  setMappingEnabled(value: boolean): void; setRows(rows: SwarmMappingRow[]): void
  setRequireMode(value: boolean): void; setTimeoutMinutes(value: number): void; setMaxConcurrency(value: number): void
  saveRows(): Promise<void>; refreshCatalog(): Promise<void>
}
export interface SwarmSettingsCardFace extends SwarmSettingsCardActions {
  hooks: { swarmSettings: SnapshotStore<SwarmSettingsCardState> }
}
export type SwarmSettingsCardProps = PropsRuntime<'plugins.bundle.config'> & InjectFace<SwarmSettingsCardFace> & PropsLocale<typeof NS>
const sameRows = (a: SwarmMappingRow[], b: SwarmMappingRow[]): boolean => JSON.stringify(a) === JSON.stringify(b)
const invalidRows = (rows: SwarmMappingRow[]): number[] => rows.flatMap((row, i) => row.type.trim() === '' || row.model.trim() === '' ? [i] : [])

export class SwarmSettingsCardController {
  private readonly store: SnapshotStore<SwarmSettingsCardState>
  private readonly unsubscribe: () => void
  private rowsDraft: SwarmMappingRow[]
  private dirty = false
  private providers: SwarmProviderOption[] = []
  private models: SwarmModelOption[] = []
  private presets: string[] = []
  private catalogLoading = false
  private catalogError: string | null = null
  private saving = false
  private saveError: { kind: 'refused' } | { kind: 'error'; message: string } | null = null

  constructor(private readonly scope: ConfigForm<SwarmSettings>, private readonly fetchCatalog: () => Promise<ModelCatalog>,
    private readonly fetchPresets?: () => Promise<string[]>) {
    this.rowsDraft = this.savedRows()
    this.store = createSnapshotStore(this.project())
    this.unsubscribe = scope.subscribe(() => {
      if (!this.dirty) this.rowsDraft = this.savedRows()
      this.dirty = !sameRows(this.rowsDraft, this.savedRows())
      this.emit()
    })
  }
  dispose(): void { this.unsubscribe() }
  private value(): SwarmSettings | undefined {
    const snapshot = this.scope.getSnapshot()
    return snapshot.status === 'ready' ? snapshot.value : undefined
  }
  private savedRows(): SwarmMappingRow[] { return (this.value()?.modelMapping ?? []).map((row) => ({ ...row })) }
  private project(): SwarmSettingsCardState {
    const value = this.value()
    return {
      available: this.scope.getSnapshot().status === 'ready',
      requireSwarmMode: value?.requireSwarmMode ?? DEFAULT_REQUIRE_SWARM_MODE,
      timeoutMs: value?.timeoutMs ?? DEFAULT_SWARM_TIMEOUT_MS,
      maxConcurrency: value?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      modelMappingEnabled: value?.modelMappingEnabled ?? false, rows: this.rowsDraft.map((row) => ({ ...row })),
      dirty: this.dirty, invalidRows: invalidRows(this.rowsDraft), providers: this.providers, models: this.models, presets: this.presets,
      catalogLoading: this.catalogLoading, catalogError: this.catalogError, saving: this.saving, saveError: this.saveError,
    }
  }
  private emit(): void { this.store.set(this.project()) }
  private async write(field: keyof SwarmSettings, value: unknown): Promise<void> {
    this.saving = true; this.saveError = null; this.emit()
    try {
      if (!await this.scope.set(field, value)) this.saveError = { kind: 'refused' }
    } catch (error) { this.saveError = { kind: 'error', message: error instanceof Error ? error.message : String(error) } }
    finally { this.saving = false; this.emit() }
  }
  private async saveRows(): Promise<void> {
    if (invalidRows(this.rowsDraft).length > 0) { this.emit(); return }
    const draft = this.rowsDraft
    const normalized = draft.map((row) => ({ type: row.type.trim(), provider: row.provider.trim(), model: row.model.trim() }))
    await this.write('modelMapping', normalized)
    if (this.saveError === null && this.rowsDraft === draft) this.rowsDraft = normalized
    this.dirty = !sameRows(this.rowsDraft, this.savedRows()); this.emit()
  }
  private async refreshCatalog(): Promise<void> {
    this.catalogLoading = true; this.catalogError = null; this.emit()
    try {
      const catalog = await this.fetchCatalog()
      this.providers = catalog.groups.map((group) => ({ provider: group.id, displayName: group.name }))
      this.models = catalog.groups.flatMap((group) => group.models.map((model) => ({ provider: group.id, id: model.id, name: model.name })))
      if (catalog.failures.length) this.catalogError = catalog.failures.map((failure) => `${failure.name}: ${failure.message}`).join('; ')
      this.presets = this.fetchPresets === undefined ? [] : await this.fetchPresets()
    } catch (error) { this.catalogError = error instanceof Error ? error.message : String(error) }
    finally { this.catalogLoading = false; this.emit() }
  }
  inject(): SwarmSettingsCardFace {
    return {
      hooks: { swarmSettings: this.store },
      setMappingEnabled: (value) => { void this.write('modelMappingEnabled', value) },
      setRequireMode: (value) => { void this.write('requireSwarmMode', value) },
      setTimeoutMinutes: (value) => { void this.write('timeoutMs', value * 60_000) },
      setMaxConcurrency: (value) => { void this.write('maxConcurrency', value) },
      setRows: (rows) => { this.rowsDraft = rows.map((row) => ({ ...row })); this.dirty = !sameRows(this.rowsDraft, this.savedRows()); this.emit() },
      saveRows: () => this.saveRows(), refreshCatalog: () => this.refreshCatalog(),
    }
  }
}

function NumberSetting({ value, onSave, label, hint, integer, t }: {
  value: number; onSave(value: number): void; label: string; hint: string; integer: boolean; t: SwarmTranslate
}): JSX.Element {
  const [text, setText] = useState(String(value))
  const [error, setError] = useState(false)
  const id = useId()
  useEffect(() => { setText(String(value)) }, [value])
  return <div className={css.numberSetting}>
    <label htmlFor={id}>{label}</label>
    <Input id={id} type="number" min="0" step={integer ? '1' : 'any'} value={text} aria-invalid={error}
      onChange={(event) => setText(event.target.value)} onBlur={() => {
        const number = Number(text)
        const valid = text.trim() !== '' && Number.isFinite(number) && number >= 0 &&
          (integer ? Number.isSafeInteger(number) : Number.isSafeInteger(number * 60_000))
        setError(!valid)
        if (valid && number !== value) onSave(number)
      }} />
    <span className={error ? css.bad : css.hint}>{error ? t('invalidNumber') : hint}</span>
  </div>
}

/** Switch's label is only its accessible name, so the row shows the text itself. */
function SwitchRow(props: { label: string; checked: boolean; disabled: boolean; onChange: (next: boolean) => void }): JSX.Element {
  return <div className={css.switchRow}><span>{props.label}</span><Switch {...props} /></div>
}

export function SwarmSettingsCard(props: SwarmSettingsCardProps): JSX.Element | null {
  const { useSwarmSettings, t, setRows, saveRows, refreshCatalog } = props
  const state = useSwarmSettings((snapshot) => snapshot)
  const datalist = useId()
  useEffect(() => { void refreshCatalog() }, [refreshCatalog])
  if (!state.available) return null
  const updateRow = (index: number, patch: Partial<SwarmMappingRow>): void => setRows(state.rows.map((row, i) => i === index ? { ...row, ...patch } : row))
  return <div className={css.settingsBody}>
    <SwitchRow label={t('requireMode')} checked={state.requireSwarmMode} onChange={props.setRequireMode} disabled={state.saving} />
    <NumberSetting label={t('timeout')} hint={t('unlimitedHint')} value={state.timeoutMs / 60_000} integer={false} t={t} onSave={props.setTimeoutMinutes} />
    <NumberSetting label={t('concurrency')} hint={t('concurrencyHint')} value={state.maxConcurrency} integer t={t} onSave={props.setMaxConcurrency} />
    <SwitchRow label={t('mappingEnabled')} checked={state.modelMappingEnabled} onChange={props.setMappingEnabled} disabled={state.saving} />
    <h3 className={css.sectionTitle}>{t('mappingTitle')}</h3><p className={css.hint}>{t('mappingHint')}</p>
    <datalist id={datalist}>{state.presets.map((id) => <option key={id} value={id} />)}</datalist>
    <ul className={css.mappingRows}>{state.rows.map((row, index) => {
      const models = state.models.filter((model) => row.provider === '' || model.provider === row.provider)
      const missing = row.model !== '' && !models.some((model) => model.id === row.model)
      return <li key={index} className={css.mappingRow}>
        <div className={css.mappingFields}>
          <Input aria-label={t('type')} aria-invalid={state.invalidRows.includes(index)} list={datalist} value={row.type} placeholder={t('type')}
            onChange={(event) => updateRow(index, { type: event.target.value })} />
          <select aria-label={t('provider')} value={row.provider} onChange={(event) => updateRow(index, { provider: event.target.value })}>
            <option value="">{t('defaultProvider')}</option>
            {row.provider !== '' && !state.providers.some((p) => p.provider === row.provider) && <option value={row.provider}>{t('unavailableProvider', { provider: row.provider })}</option>}
            {state.providers.map((p) => <option key={p.provider} value={p.provider}>{p.displayName}</option>)}
          </select>
          <select aria-label={t('model')} aria-invalid={state.invalidRows.includes(index)} value={row.model} onChange={(event) => updateRow(index, { model: event.target.value })}>
            <option value="">{t('chooseModel')}</option>
            {missing && <option value={row.model}>{t('unavailableModel', { model: row.model })}</option>}
            {models.map((model) => <option key={`${model.provider}:${model.id}`} value={model.id}>{model.name} ({model.provider})</option>)}
          </select>
          <Button size="sm" aria-label={t('remove')} onClick={() => setRows(state.rows.filter((_, i) => i !== index))}>{t('remove')}</Button>
        </div>
        {state.invalidRows.includes(index) && <div className={css.bad} role="alert">{t('invalidRow')}</div>}
      </li>
    })}</ul>
    {state.dirty && <p className={css.hint} role="status">{t('unsaved')}</p>}
    <div className={css.actions}>
      <Button size="sm" onClick={() => setRows([...state.rows, { type: '', provider: '', model: '' }])}>{t('add')}</Button>
      <Button size="sm" variant="primary" disabled={!state.dirty || state.saving || state.invalidRows.length > 0} onClick={() => { void saveRows() }}>{t('save')}</Button>
      <Button size="sm" disabled={state.catalogLoading} onClick={() => { void refreshCatalog() }}>{t(state.catalogLoading ? 'loading' : 'refresh')}</Button>
    </div>
    {state.saving && <div role="status">{t('saving')}</div>}
    {state.saveError !== null && <div className={css.bad} role="alert">{t('saveFailed', { error: state.saveError.kind === 'refused' ? t('hostRefused') : state.saveError.message })}</div>}
    {state.catalogError !== null && <div className={css.bad} role="alert">{state.catalogError}</div>}
  </div>
}
