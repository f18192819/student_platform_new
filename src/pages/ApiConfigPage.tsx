import { useEffect, useState } from 'react'
import {
  fetchProviderModels,
  loadApiConfig,
  loadApiConfigFromServer,
  saveApiConfig,
  saveApiConfigToServer,
} from '../lib/apiConfig'
import {
  formatTokenCount,
  resolveModelCapability,
  resolveModelContextBudget,
} from '../lib/modelCapabilities'
import {
  loadTsinghuaSyncConfig,
  saveTsinghuaSyncConfig,
  type TsinghuaSyncConfig,
} from '../lib/tsinghuaCourses'

const emptyTsinghuaConfig: TsinghuaSyncConfig = {
  configured: false,
  username: '',
  hasPassword: false,
  autoLoginEnabled: true,
}

type ModelProviderSlot = 'text' | 'doubt' | 'embedding' | 'rerank' | 'asr'
type ModelDiscoveryState = {
  models: string[]
  loading: boolean
  message: string
}

const emptyModelDiscoveryState = (): Record<ModelProviderSlot, ModelDiscoveryState> => ({
  text: { models: [], loading: false, message: '' },
  doubt: { models: [], loading: false, message: '' },
  embedding: { models: [], loading: false, message: '' },
  rerank: { models: [], loading: false, message: '' },
  asr: { models: [], loading: false, message: '' },
})

function ModelDiscoveryControl({
  state,
  onFetch,
  onSelect,
}: {
  state: ModelDiscoveryState
  onFetch: () => void
  onSelect: (model: string) => void
}) {
  return (
    <div className="model-discovery">
      <button type="button" className="ghost-button" onClick={onFetch} disabled={state.loading}>
        {state.loading ? '正在获取…' : '获取模型列表'}
      </button>
      {state.models.length ? (
        <select
          value=""
          aria-label="从服务模型列表中选择"
          onChange={(event) => {
            if (event.target.value) onSelect(event.target.value)
          }}
        >
          <option value="">选择服务返回的模型（{state.models.length}）</option>
          {state.models.map((model) => <option key={model} value={model}>{model}</option>)}
        </select>
      ) : null}
      {state.message ? (
        <small className="settings-field__hint" aria-live="polite">{state.message}</small>
      ) : null}
    </div>
  )
}

function ConfigStateBadge({ ready }: { ready: boolean }) {
  return (
    <span className={`api-config-state${ready ? ' api-config-state--ready' : ''}`}>
      <i aria-hidden="true" />
      {ready ? '已配置' : '待配置'}
    </span>
  )
}

export function ApiConfigPage() {
  const [form, setForm] = useState(loadApiConfig())
  const [tsinghuaConfig, setTsinghuaConfig] = useState<TsinghuaSyncConfig>(emptyTsinghuaConfig)
  const [tsinghuaPassword, setTsinghuaPassword] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [modelDiscovery, setModelDiscovery] = useState(emptyModelDiscoveryState)
  const [status, setStatus] = useState(
    '配置会保存到当前项目后端。文本模型用于问答与映射；网络学堂账号仅保存在后端，不会回写到浏览器本地。',
  )
  const textModelCapability = resolveModelCapability(form, form.model)
  const doubtModelCapability = resolveModelCapability(form, form.doubtModel)
  const doubtContextBudget = resolveModelContextBudget(form, form.doubtModel, 'chat')

  const updateField = (key: keyof typeof form, value: string) => {
    setForm((current) =>
      key === 'model'
        ? { ...current, model: value, homeworkSplitModel: value }
        : { ...current, [key]: value },
    )
  }

  const updateContextWindowOverride = (modelId: string, rawValue: string) => {
    const normalizedModelId = modelId.trim()
    if (!normalizedModelId) return
    setForm((current) => {
      const nextOverrides = { ...current.contextWindowOverrides }
      const contextWindow = Number(rawValue)
      if (!rawValue.trim() || !Number.isFinite(contextWindow) || contextWindow < 4_096) {
        delete nextOverrides[normalizedModelId]
      } else {
        nextOverrides[normalizedModelId] = Math.round(contextWindow)
      }
      return { ...current, contextWindowOverrides: nextOverrides }
    })
  }

  const updateModelDiscovery = (
    slot: ModelProviderSlot,
    updater: (current: ModelDiscoveryState) => ModelDiscoveryState,
  ) => {
    setModelDiscovery((current) => ({ ...current, [slot]: updater(current[slot]) }))
  }

  const providerCredentials = (slot: ModelProviderSlot) => {
    if (slot === 'embedding') return [form.embeddingBaseUrl, form.embeddingApiKey] as const
    if (slot === 'rerank') return [form.rerankBaseUrl, form.rerankApiKey] as const
    if (slot === 'asr') return [form.asrBaseUrl, form.asrApiKey] as const
    return [form.baseUrl, form.apiKey] as const
  }

  const discoverModels = async (slot: ModelProviderSlot) => {
    const [baseUrl, apiKey] = providerCredentials(slot)
    updateModelDiscovery(slot, (current) => ({ ...current, loading: true, message: '' }))
    try {
      const models = await fetchProviderModels(baseUrl, apiKey)
      updateModelDiscovery(slot, () => ({
        models,
        loading: false,
        message: `已获取 ${models.length} 个模型，请从下拉框选择。`,
      }))
    } catch (error) {
      updateModelDiscovery(slot, (current) => ({
        ...current,
        loading: false,
        message: error instanceof Error ? error.message : '获取模型列表失败。',
      }))
    }
  }

  const applyDiscoveredModel = (slot: ModelProviderSlot, model: string) => {
    const selected = model.trim()
    if (!selected) return
    setForm((current) => {
      const merge = (models: string[]) => Array.from(new Set([...models.filter(Boolean), selected]))
      if (slot === 'text') {
        return { ...current, models: merge(current.models), model: selected, homeworkSplitModel: selected }
      }
      if (slot === 'doubt') {
        return { ...current, doubtModels: merge(current.doubtModels), doubtModel: selected }
      }
      if (slot === 'embedding') {
        return { ...current, embeddingModels: merge(current.embeddingModels), embeddingModel: selected }
      }
      if (slot === 'rerank') {
        return { ...current, rerankModels: merge(current.rerankModels), rerankModel: selected }
      }
      return { ...current, asrModel: selected }
    })
  }

  useEffect(() => {
    let cancelled = false

    void Promise.allSettled([loadApiConfigFromServer(), loadTsinghuaSyncConfig()])
      .then(([apiResult, tsinghuaResult]) => {
        if (cancelled) {
          return
        }

        if (apiResult.status === 'fulfilled' && apiResult.value) {
          setForm(apiResult.value)
        }

        if (tsinghuaResult.status === 'fulfilled') {
          setTsinghuaConfig(tsinghuaResult.value)
        }

        if (apiResult.status === 'fulfilled' || tsinghuaResult.status === 'fulfilled') {
          setStatus('已加载后端保存的配置。')
          return
        }

        const firstReason =
          apiResult.status === 'rejected'
            ? apiResult.reason
            : tsinghuaResult.status === 'rejected'
              ? tsinghuaResult.reason
              : null
        setStatus(
          `后端配置暂不可用，当前使用本地缓存。${
            firstReason instanceof Error ? firstReason.message : 'unknown error'
          }`,
        )
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  const updateModel = (index: number, value: string) => {
    setForm((current) => ({
      ...current,
      models: current.models.map((model, modelIndex) =>
        modelIndex === index ? value : model,
      ),
    }))
  }

  const addModel = () => {
    setForm((current) => ({
      ...current,
      models: [...current.models, ''],
    }))
  }

  const updateDoubtModel = (index: number, value: string) => {
    setForm((current) => ({
      ...current,
      doubtModels: current.doubtModels.map((model, modelIndex) =>
        modelIndex === index ? value : model,
      ),
    }))
  }

  const addDoubtModel = () => {
    setForm((current) => ({
      ...current,
      doubtModels: [...current.doubtModels, ''],
    }))
  }

  const removeDoubtModel = (index: number) => {
    setForm((current) => {
      const nextModels = current.doubtModels.filter((_, modelIndex) => modelIndex !== index)
      const fallbackModel = nextModels.find((model) => model.trim()) ?? ''
      return {
        ...current,
        doubtModels: nextModels.length ? nextModels : [''],
        doubtModel:
          current.doubtModel === current.doubtModels[index]
            ? fallbackModel
            : current.doubtModel,
      }
    })
  }

  const updateEmbeddingModel = (index: number, value: string) => {
    setForm((current) => ({
      ...current,
      embeddingModels: current.embeddingModels.map((model, modelIndex) =>
        modelIndex === index ? value : model,
      ),
    }))
  }

  const addEmbeddingModel = () => {
    setForm((current) => ({ ...current, embeddingModels: [...current.embeddingModels, ''] }))
  }

  const removeEmbeddingModel = (index: number) => {
    setForm((current) => {
      const nextModels = current.embeddingModels.filter((_, modelIndex) => modelIndex !== index)
      const fallbackModel = nextModels.find((model) => model.trim()) ?? ''
      return {
        ...current,
        embeddingModels: nextModels.length ? nextModels : [''],
        embeddingModel:
          current.embeddingModel === current.embeddingModels[index]
            ? fallbackModel
            : current.embeddingModel,
      }
    })
  }

  const updateRerankModel = (index: number, value: string) => {
    setForm((current) => ({
      ...current,
      rerankModels: current.rerankModels.map((model, modelIndex) =>
        modelIndex === index ? value : model,
      ),
    }))
  }

  const addRerankModel = () => {
    setForm((current) => ({ ...current, rerankModels: [...current.rerankModels, ''] }))
  }

  const removeRerankModel = (index: number) => {
    setForm((current) => {
      const nextModels = current.rerankModels.filter((_, modelIndex) => modelIndex !== index)
      const fallbackModel = nextModels.find((model) => model.trim()) ?? ''
      return {
        ...current,
        rerankModels: nextModels.length ? nextModels : [''],
        rerankModel:
          current.rerankModel === current.rerankModels[index]
            ? fallbackModel
            : current.rerankModel,
      }
    })
  }

  const removeModel = (index: number) => {
    setForm((current) => {
      const nextModels = current.models.filter((_, modelIndex) => modelIndex !== index)
      const fallbackModel = nextModels.find((model) => model.trim()) ?? ''

      return {
        ...current,
        models: nextModels.length ? nextModels : [''],
        model: current.model === current.models[index] ? fallbackModel : current.model,
        homeworkSplitModel:
          current.homeworkSplitModel === current.models[index]
            ? fallbackModel || 'GLM-4.6V'
            : current.homeworkSplitModel,
      }
    })
  }

  const handleSave = async () => {
    const sanitizedModels = Array.from(
      new Set(form.models.map((model) => model.trim()).filter(Boolean)),
    )
    const sanitizedDoubtModels = Array.from(
      new Set(form.doubtModels.map((model) => model.trim()).filter(Boolean)),
    )
    const sanitizedEmbeddingModels = Array.from(
      new Set(form.embeddingModels.map((model) => model.trim()).filter(Boolean)),
    )
    const sanitizedRerankModels = Array.from(
      new Set(form.rerankModels.map((model) => model.trim()).filter(Boolean)),
    )
    const configuredChatModels = new Set([...sanitizedModels, ...sanitizedDoubtModels])
    const sanitizedContextWindowOverrides = Object.fromEntries(
      Object.entries(form.contextWindowOverrides).filter(
        ([modelId, contextWindow]) =>
          configuredChatModels.has(modelId) &&
          Number.isFinite(contextWindow) &&
          contextWindow >= 4_096,
      ),
    )

    if (!sanitizedModels.length || !sanitizedDoubtModels.length || !sanitizedEmbeddingModels.length || !sanitizedRerankModels.length) {
      setStatus('文本、疑点回答、Embedding 和 Rerank 都请至少配置一个可用模型。')
      return
    }

    const nextConfig = {
      ...form,
      models: sanitizedModels,
      model: sanitizedModels.includes(form.model.trim()) ? form.model.trim() : sanitizedModels[0],
      doubtModels: sanitizedDoubtModels,
      doubtModel: sanitizedDoubtModels.includes(form.doubtModel.trim())
        ? form.doubtModel.trim()
        : sanitizedDoubtModels[0],
      contextWindowOverrides: sanitizedContextWindowOverrides,
      contextCompactionThreshold: Math.min(
        0.9,
        Math.max(0.4, Number(form.contextCompactionThreshold) || 0.6),
      ),
      embeddingModels: sanitizedEmbeddingModels,
      embeddingModel: sanitizedEmbeddingModels.includes(form.embeddingModel.trim())
        ? form.embeddingModel.trim()
        : sanitizedEmbeddingModels[0],
      rerankModels: sanitizedRerankModels,
      rerankModel: sanitizedRerankModels.includes(form.rerankModel.trim())
        ? form.rerankModel.trim()
        : sanitizedRerankModels[0],
      homeworkSplitModel: sanitizedModels.includes(form.model.trim())
        ? form.model.trim()
        : sanitizedModels[0],
      asrBaseUrl: form.asrBaseUrl.trim(),
      asrApiKey: form.asrApiKey.trim(),
      asrModel: form.asrModel.trim(),
      asrPrompt: form.asrPrompt.trim(),
    }

    setIsSaving(true)
    try {
      const savedConfig = await saveApiConfigToServer(nextConfig)
      const shouldSaveTsinghuaConfig = Boolean(
        tsinghuaConfig.username.trim() || tsinghuaPassword.trim() || tsinghuaConfig.configured,
      )
      const savedTsinghuaConfig = shouldSaveTsinghuaConfig
        ? await saveTsinghuaSyncConfig({
            username: tsinghuaConfig.username,
            password: tsinghuaPassword,
            autoLoginEnabled: tsinghuaConfig.autoLoginEnabled,
          })
        : tsinghuaConfig

      setForm(savedConfig)
      setTsinghuaConfig(savedTsinghuaConfig)
      setTsinghuaPassword('')
      setStatus(
        '配置已保存到后端。后续网络学堂同步会优先复用已登录会话，并自动填充账号密码。',
      )
    } catch (error) {
      saveApiConfig(nextConfig)
      const message = error instanceof Error ? error.message : 'unknown error'
      setForm(nextConfig)
      setStatus(`保存失败：${message}`)
    } finally {
      setIsSaving(false)
    }
  }

  const serviceReadiness = {
    text: Boolean(form.baseUrl.trim() && form.apiKey.trim() && form.model.trim()),
    doubt: Boolean(form.baseUrl.trim() && form.apiKey.trim() && form.doubtModel.trim()),
    knowledge: Boolean(
      form.embeddingBaseUrl.trim() &&
      form.embeddingApiKey.trim() &&
      form.embeddingModel.trim() &&
      form.rerankBaseUrl.trim() &&
      form.rerankApiKey.trim() &&
      form.rerankModel.trim(),
    ),
    asr: Boolean(form.asrBaseUrl.trim() && form.asrApiKey.trim() && form.asrModel.trim()),
    sync: Boolean(
      tsinghuaConfig.username.trim() &&
      (tsinghuaConfig.hasPassword || tsinghuaPassword.trim()),
    ),
  }

  return (
    <main className="settings-page settings-page--api">
      <section className="api-config-hero">
        <div className="api-config-hero__copy">
          <p className="section-label">AI SERVICE CENTER</p>
          <h2>模型与服务配置</h2>
          <p>在一个页面管理文档处理、AI 问答、知识库检索和课堂录音识别。</p>
          <div className="api-config-hero__tags" aria-label="配置能力">
            <span>文档 Pipeline</span>
            <span>RAG 问答</span>
            <span>向量检索</span>
            <span>语音识别</span>
          </div>
        </div>
        <div className="api-config-hero__action">
          <span>{isLoading ? '正在读取配置' : '可随时修改并统一保存'}</span>
          <button
            type="button"
            className="primary-button"
            onClick={() => void handleSave()}
            disabled={isLoading || isSaving}
          >
            {isSaving ? '正在保存…' : '保存全部配置'}
          </button>
        </div>
      </section>

      <div className="api-config-layout">
        <aside className="api-config-nav" aria-label="API 配置导航">
          <div className="api-config-nav__heading">
            <strong>配置导航</strong>
            <span>按服务逐项完成</span>
          </div>
          <nav className="api-config-nav__list">
            <a href="#api-text">
              <b>01</b>
              <span>文本处理<small>文档与题目 Pipeline</small></span>
              <ConfigStateBadge ready={serviceReadiness.text} />
            </a>
            <a href="#api-doubt">
              <b>02</b>
              <span>疑点回答<small>阅读器 AI 对话</small></span>
              <ConfigStateBadge ready={serviceReadiness.doubt} />
            </a>
            <a href="#api-knowledge">
              <b>03</b>
              <span>知识库<small>Embedding 与 Rerank</small></span>
              <ConfigStateBadge ready={serviceReadiness.knowledge} />
            </a>
            <a href="#api-asr">
              <b>04</b>
              <span>语音识别<small>课堂录音 ASR</small></span>
              <ConfigStateBadge ready={serviceReadiness.asr} />
            </a>
            <a href="#api-sync">
              <b>05</b>
              <span>学堂同步<small>课程与课件自动同步</small></span>
              <ConfigStateBadge ready={serviceReadiness.sync} />
            </a>
          </nav>
          <div className="api-config-nav__note">
            <i aria-hidden="true">i</i>
            <p>网络学堂密码不会回传页面；API Key 请仅在可信的本机环境中配置。</p>
          </div>
        </aside>

        <div className="api-config-content">
          <section className="api-config-section" id="api-text">
            <header className="api-config-section__header">
              <div className="api-config-section__identity">
                <span className="api-config-section__number">01</span>
                <div>
                  <p className="api-config-section__eyebrow">DOCUMENT PIPELINE</p>
                  <h3>文本处理模型</h3>
                  <p>负责文档整理、练习切分、题目分析与讲义页面映射。</p>
                </div>
              </div>
              <ConfigStateBadge ready={serviceReadiness.text} />
            </header>

            <div className="api-config-subsection">
              <div className="api-config-subsection__heading">
                <h4>服务连接</h4>
                <p>兼容 OpenAI 格式的服务可填写到 <code>/v1</code>。</p>
              </div>
              <div className="settings-form">
                <label className="settings-field">
                  <span>Base URL</span>
                  <input
                    type="text"
                    value={form.baseUrl}
                    onChange={(event) => updateField('baseUrl', event.target.value)}
                    placeholder="https://api.openai.com/v1"
                  />
                </label>
                <label className="settings-field">
                  <span>API Key</span>
                  <input
                    type="password"
                    value={form.apiKey}
                    onChange={(event) => updateField('apiKey', event.target.value)}
                    placeholder="sk-..."
                  />
                </label>
              </div>
            </div>

            <div className="api-config-subsection">
              <div className="api-config-subsection__heading">
                <h4>模型选择</h4>
                <p>可从服务读取模型，也可以保留手动维护的名称。</p>
              </div>
              <div className="settings-form settings-form--models">
                <div className="settings-field settings-field--full">
                  <span>可用文本模型</span>
                  <div className="model-config-list">
                    {form.models.map((model, index) => (
                      <div key={index} className="model-config-row">
                        <input
                          aria-label={`文本模型 ${index + 1}`}
                          type="text"
                          value={model}
                          onChange={(event) => updateModel(index, event.target.value)}
                          placeholder="例如：GLM-4.6V"
                        />
                        <button
                          type="button"
                          className="ghost-button ghost-button--danger"
                          onClick={() => removeModel(index)}
                          disabled={form.models.length === 1}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                    <div className="model-config-actions">
                      <button type="button" className="ghost-button" onClick={addModel}>手动添加</button>
                      <ModelDiscoveryControl
                        state={modelDiscovery.text}
                        onFetch={() => void discoverModels('text')}
                        onSelect={(model) => applyDiscoveredModel('text', model)}
                      />
                    </div>
                  </div>
                </div>
                <label className="settings-field settings-field--compact">
                  <span>当前使用</span>
                  <select value={form.model} onChange={(event) => updateField('model', event.target.value)}>
                    {form.models.map((model) => model.trim()).filter(Boolean).map((model) => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <details className="settings-advanced">
              <summary>
                <span>高级设置</span>
                <small>上下文窗口与 Pipeline 系统提示词</small>
              </summary>
              <div className="settings-form settings-advanced__body">
                <label className="settings-field">
                  <span>上下文窗口（Token）</span>
                  <input
                    type="number"
                    min="4096"
                    step="1024"
                    value={form.contextWindowOverrides[form.model] ?? ''}
                    onChange={(event) => updateContextWindowOverride(form.model, event.target.value)}
                    placeholder={`自动识别 ${textModelCapability.contextWindow}`}
                  />
                  <small className="settings-field__hint">
                    当前识别为 {formatTokenCount(textModelCapability.contextWindow)}，通常无需手动填写。
                  </small>
                </label>
                <label className="settings-field settings-field--full">
                  <span>系统提示词</span>
                  <textarea
                    value={form.systemPrompt}
                    onChange={(event) => updateField('systemPrompt', event.target.value)}
                  />
                </label>
              </div>
            </details>
          </section>

          <section className="api-config-section" id="api-doubt">
            <header className="api-config-section__header">
              <div className="api-config-section__identity">
                <span className="api-config-section__number">02</span>
                <div>
                  <p className="api-config-section__eyebrow">STUDENT DIALOGUE</p>
                  <h3>疑点回答模型</h3>
                  <p>只负责阅读器中的疑点与追问，不参与后台文档处理。</p>
                </div>
              </div>
              <ConfigStateBadge ready={serviceReadiness.doubt} />
            </header>

            <div className="api-config-inline-note">
              <strong>共享连接信息</strong>
              <span>该模型复用文本处理服务的 Base URL 与 API Key，只需在这里选择回答模型。</span>
            </div>

            <div className="api-config-subsection">
              <div className="api-config-subsection__heading">
                <h4>回答模型</h4>
                <p>用户可以在阅读器内切换这里配置的模型。</p>
              </div>
              <div className="settings-form settings-form--models">
                <div className="settings-field settings-field--full">
                  <span>可用疑点回答模型</span>
                  <div className="model-config-list">
                    {form.doubtModels.map((model, index) => (
                      <div key={index} className="model-config-row">
                        <input
                          aria-label={`疑点回答模型 ${index + 1}`}
                          type="text"
                          value={model}
                          onChange={(event) => updateDoubtModel(index, event.target.value)}
                          placeholder="例如：GLM-4.6V"
                        />
                        <button
                          type="button"
                          className="ghost-button ghost-button--danger"
                          onClick={() => removeDoubtModel(index)}
                          disabled={form.doubtModels.length === 1}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                    <div className="model-config-actions">
                      <button type="button" className="ghost-button" onClick={addDoubtModel}>手动添加</button>
                      <ModelDiscoveryControl
                        state={modelDiscovery.doubt}
                        onFetch={() => void discoverModels('doubt')}
                        onSelect={(model) => applyDiscoveredModel('doubt', model)}
                      />
                    </div>
                  </div>
                </div>
                <label className="settings-field settings-field--compact">
                  <span>默认回答模型</span>
                  <select value={form.doubtModel} onChange={(event) => updateField('doubtModel', event.target.value)}>
                    {form.doubtModels.map((model) => model.trim()).filter(Boolean).map((model) => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <details className="settings-advanced">
              <summary>
                <span>上下文与记忆</span>
                <small>当前 Soft Target {formatTokenCount(doubtContextBudget.softTargetTokens)}</small>
              </summary>
              <div className="settings-form settings-advanced__body">
                <label className="settings-field">
                  <span>上下文窗口（Token）</span>
                  <input
                    type="number"
                    min="4096"
                    step="1024"
                    value={form.contextWindowOverrides[form.doubtModel] ?? ''}
                    onChange={(event) => updateContextWindowOverride(form.doubtModel, event.target.value)}
                    placeholder={`自动识别 ${doubtModelCapability.contextWindow}`}
                  />
                  <small className="settings-field__hint">
                    窗口 {formatTokenCount(doubtModelCapability.contextWindow)}，Hard Input 约 {formatTokenCount(doubtContextBudget.inputBudgetTokens)}。
                  </small>
                </label>
                <label className="settings-field">
                  <span>会话记忆压缩策略</span>
                  <select
                    value={String(form.contextCompactionThreshold)}
                    onChange={(event) => setForm((current) => ({
                      ...current,
                      contextCompactionThreshold: Number(event.target.value),
                    }))}
                  >
                    <option value="0.4">40% · 更早压缩</option>
                    <option value="0.6">60% · 平衡（推荐）</option>
                    <option value="0.75">75% · 保留更多原文</option>
                    <option value="0.9">90% · 接近窗口再压缩</option>
                  </select>
                  <small className="settings-field__hint">
                    历史预算约 {formatTokenCount(doubtContextBudget.conversationBudgetTokens)}，原文最多保留最近 5 轮。
                  </small>
                </label>
              </div>
            </details>
          </section>

          {/* KNOWLEDGE_GRAPH_PAUSED: Neo4j controls are intentionally hidden until graph work resumes. */}
          <section className="api-config-section" id="api-knowledge">
            <header className="api-config-section__header">
              <div className="api-config-section__identity">
                <span className="api-config-section__number">03</span>
                <div>
                  <p className="api-config-section__eyebrow">KNOWLEDGE BASE</p>
                  <h3>知识库检索</h3>
                  <p>Embedding 建立索引，Rerank 从候选片段中筛选最相关内容。</p>
                </div>
              </div>
              <ConfigStateBadge ready={serviceReadiness.knowledge} />
            </header>

            <div className="api-provider-grid">
              <article className="api-provider-card">
                <header>
                  <span className="api-provider-card__mark">E</span>
                  <div><h4>Embedding</h4><p>文档与查询向量化</p></div>
                </header>
                <div className="settings-form settings-form--single">
                  <label className="settings-field">
                    <span>Base URL</span>
                    <input
                      type="text"
                      value={form.embeddingBaseUrl}
                      onChange={(event) => updateField('embeddingBaseUrl', event.target.value)}
                      placeholder="https://api.openai.com/v1"
                    />
                  </label>
                  <label className="settings-field">
                    <span>API Key</span>
                    <input
                      type="password"
                      value={form.embeddingApiKey}
                      onChange={(event) => updateField('embeddingApiKey', event.target.value)}
                      placeholder="sk-..."
                    />
                  </label>
                  <div className="settings-field">
                    <span>可用模型</span>
                    <div className="model-config-list">
                      {form.embeddingModels.map((model, index) => (
                        <div key={index} className="model-config-row">
                          <input
                            aria-label={`Embedding 模型 ${index + 1}`}
                            type="text"
                            value={model}
                            onChange={(event) => updateEmbeddingModel(index, event.target.value)}
                            placeholder="例如：GLM-Embedding-3"
                          />
                          <button
                            type="button"
                            className="ghost-button ghost-button--danger"
                            onClick={() => removeEmbeddingModel(index)}
                            disabled={form.embeddingModels.length === 1}
                          >
                            删除
                          </button>
                        </div>
                      ))}
                      <div className="model-config-actions">
                        <button type="button" className="ghost-button" onClick={addEmbeddingModel}>手动添加</button>
                        <ModelDiscoveryControl
                          state={modelDiscovery.embedding}
                          onFetch={() => void discoverModels('embedding')}
                          onSelect={(model) => applyDiscoveredModel('embedding', model)}
                        />
                      </div>
                    </div>
                  </div>
                  <label className="settings-field">
                    <span>当前使用</span>
                    <select value={form.embeddingModel} onChange={(event) => updateField('embeddingModel', event.target.value)}>
                      {form.embeddingModels.map((model) => model.trim()).filter(Boolean).map((model) => (
                        <option key={model} value={model}>{model}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </article>

              <article className="api-provider-card">
                <header>
                  <span className="api-provider-card__mark api-provider-card__mark--warm">R</span>
                  <div><h4>Rerank</h4><p>检索候选精排</p></div>
                </header>
                <div className="settings-form settings-form--single">
                  <label className="settings-field">
                    <span>Base URL</span>
                    <input
                      type="text"
                      value={form.rerankBaseUrl}
                      onChange={(event) => updateField('rerankBaseUrl', event.target.value)}
                      placeholder="https://api.openai.com/v1"
                    />
                  </label>
                  <label className="settings-field">
                    <span>API Key</span>
                    <input
                      type="password"
                      value={form.rerankApiKey}
                      onChange={(event) => updateField('rerankApiKey', event.target.value)}
                      placeholder="sk-..."
                    />
                  </label>
                  <div className="settings-field">
                    <span>可用模型</span>
                    <div className="model-config-list">
                      {form.rerankModels.map((model, index) => (
                        <div key={index} className="model-config-row">
                          <input
                            aria-label={`Rerank 模型 ${index + 1}`}
                            type="text"
                            value={model}
                            onChange={(event) => updateRerankModel(index, event.target.value)}
                            placeholder="例如：GLM-Rerank"
                          />
                          <button
                            type="button"
                            className="ghost-button ghost-button--danger"
                            onClick={() => removeRerankModel(index)}
                            disabled={form.rerankModels.length === 1}
                          >
                            删除
                          </button>
                        </div>
                      ))}
                      <div className="model-config-actions">
                        <button type="button" className="ghost-button" onClick={addRerankModel}>手动添加</button>
                        <ModelDiscoveryControl
                          state={modelDiscovery.rerank}
                          onFetch={() => void discoverModels('rerank')}
                          onSelect={(model) => applyDiscoveredModel('rerank', model)}
                        />
                      </div>
                    </div>
                  </div>
                  <label className="settings-field">
                    <span>当前使用</span>
                    <select value={form.rerankModel} onChange={(event) => updateField('rerankModel', event.target.value)}>
                      {form.rerankModels.map((model) => model.trim()).filter(Boolean).map((model) => (
                        <option key={model} value={model}>{model}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </article>
            </div>
          </section>

          <section className="api-config-section" id="api-asr">
            <header className="api-config-section__header">
              <div className="api-config-section__identity">
                <span className="api-config-section__number">04</span>
                <div>
                  <p className="api-config-section__eyebrow">AUDIO TRANSCRIPTION</p>
                  <h3>课堂录音识别</h3>
                  <p>音频会按短分片顺序上传，并优先保留云端返回的时间戳。</p>
                </div>
              </div>
              <ConfigStateBadge ready={serviceReadiness.asr} />
            </header>
            <div className="settings-form">
              <label className="settings-field">
                <span>Base URL</span>
                <input
                  type="text"
                  value={form.asrBaseUrl}
                  onChange={(event) => updateField('asrBaseUrl', event.target.value)}
                  placeholder="https://api.openai.com/v1"
                />
              </label>
              <label className="settings-field">
                <span>API Key</span>
                <input
                  type="password"
                  value={form.asrApiKey}
                  onChange={(event) => updateField('asrApiKey', event.target.value)}
                  placeholder="sk-..."
                />
              </label>
              <label className="settings-field">
                <span>ASR 模型</span>
                <input
                  type="text"
                  value={form.asrModel}
                  onChange={(event) => updateField('asrModel', event.target.value)}
                  placeholder="whisper-1"
                />
                <ModelDiscoveryControl
                  state={modelDiscovery.asr}
                  onFetch={() => void discoverModels('asr')}
                  onSelect={(model) => applyDiscoveredModel('asr', model)}
                />
              </label>
              <label className="settings-field">
                <span>识别提示词（可选）</span>
                <input
                  type="text"
                  value={form.asrPrompt}
                  onChange={(event) => updateField('asrPrompt', event.target.value)}
                  placeholder="可填写课程术语或专有名词"
                />
              </label>
            </div>
          </section>

          <section className="api-config-section" id="api-sync">
            <header className="api-config-section__header">
              <div className="api-config-section__identity">
                <span className="api-config-section__number">05</span>
                <div>
                  <p className="api-config-section__eyebrow">COURSE SYNC</p>
                  <h3>网络学堂同步</h3>
                  <p>复用本机登录会话，自动检查课程和课件更新。</p>
                </div>
              </div>
              <ConfigStateBadge ready={serviceReadiness.sync} />
            </header>
            <div className="settings-form">
              <label className="settings-field">
                <span>用户名</span>
                <input
                  type="text"
                  value={tsinghuaConfig.username}
                  onChange={(event) => setTsinghuaConfig((current) => ({ ...current, username: event.target.value }))}
                  placeholder="例如：fangjh24"
                />
              </label>
              <label className="settings-field">
                <span>密码</span>
                <input
                  type="password"
                  value={tsinghuaPassword}
                  onChange={(event) => setTsinghuaPassword(event.target.value)}
                  placeholder={tsinghuaConfig.hasPassword ? '已保存，留空保持不变' : '请输入密码'}
                />
              </label>
              <label className="settings-field settings-field--full">
                <span>登录策略</span>
                <select
                  value={tsinghuaConfig.autoLoginEnabled ? 'enabled' : 'disabled'}
                  onChange={(event) => setTsinghuaConfig((current) => ({
                    ...current,
                    autoLoginEnabled: event.target.value === 'enabled',
                  }))}
                >
                  <option value="enabled">自动填充账号密码，并优先复用登录会话</option>
                  <option value="disabled">仅复用已有会话，不自动填写账号密码</option>
                </select>
              </label>
            </div>
            <div className="api-config-security-note">
              <div><strong>本机保存</strong><span>密码不会回传到浏览器</span></div>
              <div><strong>会话复用</strong><span>尽量减少重复登录和 2FA</span></div>
              <div><strong>当前学期</strong><span>自动检查仅面向当前学期</span></div>
            </div>
          </section>

          <div className="settings-savebar">
            <div className="settings-savebar__status" role="status" aria-live="polite">
              <i aria-hidden="true" />
              <div>
                <strong>{isSaving ? '正在保存配置' : '统一保存所有更改'}</strong>
                <p>{status}</p>
              </div>
            </div>
            <button
              type="button"
              className="primary-button"
              onClick={() => void handleSave()}
              disabled={isLoading || isSaving}
            >
              {isSaving ? '正在保存…' : '保存全部配置'}
            </button>
          </div>
        </div>
      </div>
    </main>
  )
}
