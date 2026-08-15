/**
 * Swarm plugin settings card: master switches plus the type -> model mapping
 * table. Provider and model options are pulled live from the host's `llm`
 * catalog (`llm.providers` / `llm.models`), the same RPCs the official model
 * picker uses, so the table always shows what the host can actually serve.
 *
 * Deliberately simpler than the staged CardForm: writes land immediately via
 * `SettingsScope.set` (the namespace is `live`-applies), and the model catalog
 * is refreshed on demand instead of on every keystroke.
 */
import { useEffect, useState, type JSX } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import css from './swarm.module.css'

/** The namespace's full shape (mirrors the host Config schema). */
export interface SwarmSettings {
  enabled?: boolean
  announceToAgent?: boolean
  modelMappingEnabled?: boolean
  modelMapping?: Array<{ type: string; provider: string; model: string }>
}

/** One mapping row as the card edits it. */
export interface SwarmMappingRow {
  type: string
  provider: string
  model: string
}

/** Provider option from `llm.providers`. */
export interface SwarmProviderOption {
  provider: string
  displayName: string
}

/** Model option from `llm.models` (group-flattened). */
export interface SwarmModelOption {
  provider: string
  id: string
  name: string
}

/** Card snapshot state. */
export interface SwarmSettingsCardState {
  /** Whether the settings namespace is served to this client. */
  available: boolean
  enabled: boolean
  modelMappingEnabled: boolean
  rows: SwarmMappingRow[]
  /** Model catalog pulled from the host; empty until loaded. */
  providers: SwarmProviderOption[]
  models: SwarmModelOption[]
  catalogLoading: boolean
  catalogError: string | null
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save failed. */
  saveFailed: boolean
}

/** The actions the card's slot entry injects. */
export interface SwarmSettingsCardActions {
  setEnabled: (value: boolean) => void
  setMappingEnabled: (value: boolean) => void
  setRows: (rows: SwarmMappingRow[]) => void
  saveRows: () => Promise<void>
  refreshCatalog: () => Promise<void>
}

/** Registration-side face for the card component. */
export interface SwarmSettingsCardFace {
  state: SwarmSettingsCardState
  actions: SwarmSettingsCardActions
}

/** Controller bridging the `swarm` namespace and the host model catalog. */
export class SwarmSettingsCardController {
  private readonly store: SnapshotStore<SwarmSettingsCardState>
  private readonly scope: SettingsScope<SwarmSettings>
  private readonly getApi: () => IApiClient | undefined
  private rowsDraft: SwarmMappingRow[]
  private providersCache: SwarmProviderOption[] = []
  private modelsCache: SwarmModelOption[] = []
  private catalogLoading = false
  private catalogError: string | null = null
  private saving = false
  private saveFailed = false

  constructor(scope: SettingsScope<SwarmSettings>, getApi: () => IApiClient | undefined) {
    this.scope = scope
    this.getApi = getApi
    this.rowsDraft = []
    const snapshot = scope.getSnapshot()
    if (snapshot.status === 'ready') {
      this.rowsDraft = (snapshot.value?.modelMapping ?? []).map((row) => ({ ...row }))
    }
    this.store = createSnapshotStore<SwarmSettingsCardState>(this.project())
    scope.subscribe(() => {
      const current = scope.getSnapshot()
      if (current.status === 'ready') {
        this.rowsDraft = (current.value?.modelMapping ?? []).map((row) => ({ ...row }))
      }
      this.store.set(this.project())
    })
  }

  private value(): SwarmSettings | undefined {
    const snapshot = this.scope.getSnapshot()
    return snapshot.status === 'ready' ? snapshot.value : undefined
  }

  private project(): SwarmSettingsCardState {
    const value = this.value()
    return {
      available: this.scope.getSnapshot().status !== 'unavailable',
      enabled: value?.enabled ?? true,
      modelMappingEnabled: value?.modelMappingEnabled ?? false,
      rows: this.rowsDraft.map((row) => ({ ...row })),
      providers: this.providersCache,
      models: this.modelsCache,
      catalogLoading: this.catalogLoading,
      catalogError: this.catalogError,
      saving: this.saving,
      saveFailed: this.saveFailed,
    }
  }

  /** Face for the card slot entry. */
  inject(): SwarmSettingsCardFace {
    return {
      state: this.store.getSnapshot(),
      actions: {
        setEnabled: (value) => { void this.scope.set('enabled', value) },
        setMappingEnabled: (value) => { void this.scope.set('modelMappingEnabled', value) },
        setRows: (rows) => {
          this.rowsDraft = rows.map((row) => ({ ...row }))
          this.store.set(this.project())
        },
        saveRows: async () => {
          this.saving = true
          this.saveFailed = false
          this.store.set(this.project())
          try {
            await this.scope.set('modelMapping', this.rowsDraft)
          } catch {
            this.saveFailed = true
          } finally {
            this.saving = false
            this.store.set(this.project())
          }
        },
        refreshCatalog: async () => {
          this.catalogLoading = true
          this.catalogError = null
          this.store.set(this.project())
          try {
            await this.loadCatalog()
          } catch (error) {
            this.catalogError = error instanceof Error ? error.message : String(error)
          } finally {
            this.catalogLoading = false
            this.store.set(this.project())
          }
        },
      },
    }
  }

  private async loadCatalog(): Promise<void> {
    const api = this.getApi()
    if (api === undefined) throw new Error('host connection unavailable')
    const [providersReply, modelsReply] = await Promise.all([api.llm.providers({}), api.llm.models({})])
    const providers: SwarmProviderOption[] = []
    if (providersReply.result.ok) {
      for (const view of providersReply.result.value.providers) {
        providers.push({ provider: view.provider, displayName: view.displayName })
      }
    }
    const models: SwarmModelOption[] = []
    if (modelsReply.result.ok) {
      for (const group of modelsReply.result.value.groups) {
        for (const model of group.models) {
          models.push({ provider: group.id, id: model.id, name: model.name })
        }
      }
    }
    this.providersCache = providers
    this.modelsCache = models
  }
}

/** Render the swarm settings card. */
export function SwarmSettingsCard({ state, actions }: SwarmSettingsCardFace): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [catalogTouched, setCatalogTouched] = useState(false)

  useEffect(() => {
    if (!open || catalogTouched) return
    setCatalogTouched(true)
    void actions.refreshCatalog()
  }, [open, catalogTouched, actions])

  if (!state.available) return null

  const providerName = (provider: string): string =>
    state.providers.find((p) => p.provider === provider)?.displayName ?? provider
  const modelsOf = (provider: string): SwarmModelOption[] =>
    provider.length === 0 ? state.models : state.models.filter((m) => m.provider === provider)

  const updateRow = (index: number, patch: Partial<SwarmMappingRow>): void => {
    const next = state.rows.map((row, i) => (i === index ? { ...row, ...patch } : row))
    actions.setRows(next)
  }

  return (
    <li className={css.settingsCard}>
      <button
        type="button"
        className={css.settingsHeader}
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.settingsName}>Swarm 批量并行</span>
        <span className={css.settingsDescription}>swarm_batch 工具与模型映射</span>
        <span className={css.chevron}>{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className={css.settingsBody}>
          <label className={css.toggleRow}>
            <input
              type="checkbox"
              checked={state.enabled}
              onChange={(event) => { actions.setEnabled(event.target.checked) }}
            />
            启用插件
          </label>
          <label className={css.toggleRow}>
            <input
              type="checkbox"
              checked={state.modelMappingEnabled}
              onChange={(event) => { actions.setMappingEnabled(event.target.checked) }}
            />
            启用模型映射表（关闭时由 Agent 自由分配模型）
          </label>

          <div className={css.sectionTitle}>类型 → 模型映射</div>
          {state.rows.length === 0 ? (
            <div className={css.hint}>暂无映射行；添加后按类型命中，未命中回落到继承调用者模型。</div>
          ) : null}
          <ul className={css.mappingRows}>
            {state.rows.map((row, index) => (
              <li key={index} className={css.mappingRow}>
                <input
                  className={css.mappingType}
                  value={row.type}
                  placeholder="类型（如 coder）"
                  onChange={(event) => { updateRow(index, { type: event.target.value }) }}
                />
                <select
                  className={css.mappingSelect}
                  value={row.provider}
                  onChange={(event) => { updateRow(index, { provider: event.target.value, model: '' }) }}
                >
                  <option value="">(默认 provider)</option>
                  {state.providers.map((p) => (
                    <option key={p.provider} value={p.provider}>{p.displayName}</option>
                  ))}
                </select>
                <select
                  className={css.mappingSelect}
                  value={row.model}
                  onChange={(event) => { updateRow(index, { model: event.target.value }) }}
                >
                  <option value="">(选择模型)</option>
                  {modelsOf(row.provider).map((m) => (
                    <option key={`${m.provider}:${m.id}`} value={m.id}>
                      {m.name}（{providerName(m.provider)}）
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label="删除该行"
                  onClick={() => { actions.setRows(state.rows.filter((_, i) => i !== index)) }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>

          <div className={css.actionsRow}>
            <button
              type="button"
              className={css.primaryButton}
              onClick={() => {
                actions.setRows([...state.rows, { type: '', provider: '', model: '' }])
              }}
            >
              + 添加映射
            </button>
            <button
              type="button"
              className={css.primaryButton}
              disabled={state.saving}
              onClick={() => { void actions.saveRows() }}
            >
              {state.saving ? '保存中…' : '保存映射'}
            </button>
            <button
              type="button"
              className={css.ghostButton}
              disabled={state.catalogLoading}
              onClick={() => { void actions.refreshCatalog() }}
            >
              {state.catalogLoading ? '拉取中…' : '刷新模型目录'}
            </button>
          </div>

          {state.catalogError !== null ? (
            <div className={css.catalogError}>模型目录拉取失败：{state.catalogError}</div>
          ) : null}
          {state.saveFailed ? <div className={css.catalogError}>保存失败，请重试</div> : null}
          {!state.catalogLoading && state.catalogError === null && state.providers.length > 0 ? (
            <div className={css.hint}>
              已从宿主拉取 {state.providers.length} 个供应商、{state.models.length} 个模型；
              模型列表随供应商配置变更自动刷新。
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}
