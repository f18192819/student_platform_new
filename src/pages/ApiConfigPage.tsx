import { useEffect, useState } from 'react'
import {
  loadApiConfig,
  loadApiConfigFromServer,
  saveApiConfig,
  saveApiConfigToServer,
} from '../lib/apiConfig'
import { formatTokenCount, resolveModelCapability } from '../lib/modelCapabilities'
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

export function ApiConfigPage() {
  const [form, setForm] = useState(loadApiConfig())
  const [tsinghuaConfig, setTsinghuaConfig] = useState<TsinghuaSyncConfig>(emptyTsinghuaConfig)
  const [tsinghuaPassword, setTsinghuaPassword] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [status, setStatus] = useState(
    '配置会保存到当前项目后端。文本模型用于问答与映射；网络学堂账号仅保存在后端，不会回写到浏览器本地。',
  )
  const textModelCapability = resolveModelCapability(form, form.model)
  const doubtModelCapability = resolveModelCapability(form, form.doubtModel)

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

  return (
    <main className="settings-page">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="section-label">API Config Center</p>
            <h3>配置模型服务与学堂同步</h3>
          </div>
        </div>

        <p className="panel-helper">
          文本、疑点回答、Embedding 和 Rerank 模型均可独立配置，`Base URL` 可以填到 `/v1`；Embedding 和 Rerank 会自动请求对应的标准接口。
          网络学堂账号只会保存在后端；第一次完成 2FA 后，后续同步会优先复用同一个浏览器会话。
        </p>

        <section className="api-config-section">
          <header className="api-config-section__header">
            <div>
              <p className="api-config-section__eyebrow">01 / DOCUMENT PIPELINE</p>
              <h4>文本处理模型</h4>
            </div>
            <p>用于文档整理、练习切分、题目分析与讲义页面映射。</p>
          </header>
          <div className="settings-form">
          <label className="settings-field">
            <span>Text Base URL</span>
            <input
              type="text"
              value={form.baseUrl}
              onChange={(event) => updateField('baseUrl', event.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </label>

          <label className="settings-field">
            <span>Text API Key</span>
            <input
              type="password"
              value={form.apiKey}
              onChange={(event) => updateField('apiKey', event.target.value)}
              placeholder="sk-..."
            />
          </label>

          <label className="settings-field settings-field--full">
            <span>可用文本模型列表</span>
            <div className="model-config-list">
              {form.models.map((model, index) => (
                <div key={index} className="model-config-row">
                  <input
                    type="text"
                    value={model}
                    onChange={(event) => updateModel(index, event.target.value)}
                    placeholder="例如：GLM-4.6V"
                  />
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => removeModel(index)}
                    disabled={form.models.length === 1}
                  >
                    删除
                  </button>
                </div>
              ))}
              <button type="button" className="ghost-button" onClick={addModel}>
                添加模型
              </button>
            </div>
          </label>

          <label className="settings-field">
            <span>默认文本模型</span>
            <select
              value={form.model}
              onChange={(event) => updateField('model', event.target.value)}
            >
              {form.models
                .map((model) => model.trim())
                .filter(Boolean)
                .map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
            </select>
          </label>

          <label className="settings-field">
            <span>文本模型上下文窗口（Token，可选）</span>
            <input
              type="number"
              min="4096"
              step="1024"
              value={form.contextWindowOverrides[form.model] ?? ''}
              onChange={(event) => updateContextWindowOverride(form.model, event.target.value)}
              placeholder={`自动识别 ${textModelCapability.contextWindow}`}
            />
            <small className="settings-field__hint">
              当前使用 {formatTokenCount(textModelCapability.contextWindow)}，留空时自动识别。
            </small>
          </label>

          <label className="settings-field">
            <span>练习划分 AI</span>
            <select
              name="homeworkSplitModel"
              value={form.homeworkSplitModel}
              onChange={(event) => updateField('homeworkSplitModel', event.target.value)}
            >
              {form.models
                .map((model) => model.trim())
                .filter(Boolean)
                .map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
            </select>
          </label>

          <label className="settings-field settings-field--full">
            <span>文本系统提示词</span>
            <textarea
              value={form.systemPrompt}
              onChange={(event) => updateField('systemPrompt', event.target.value)}
            />
          </label>
          </div>
        </section>

        <section className="api-config-section">
          <header className="api-config-section__header">
            <div>
              <p className="api-config-section__eyebrow">02 / STUDENT DIALOGUE</p>
              <h4>疑点回答模型</h4>
            </div>
            <p>只用于阅读器右侧的疑点与追问回答，不参与文档处理。</p>
          </header>
          <div className="settings-form">
          <label className="settings-field settings-field--full">
            <span>可用疑点回答模型列表</span>
            <div className="model-config-list">
              {form.doubtModels.map((model, index) => (
                <div key={index} className="model-config-row">
                  <input
                    type="text"
                    value={model}
                    onChange={(event) => updateDoubtModel(index, event.target.value)}
                    placeholder="例如：GLM-4.6V"
                  />
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => removeDoubtModel(index)}
                    disabled={form.doubtModels.length === 1}
                  >
                    删除
                  </button>
                </div>
              ))}
              <button type="button" className="ghost-button" onClick={addDoubtModel}>
                添加模型
              </button>
            </div>
          </label>

          <label className="settings-field">
            <span>默认疑点回答模型</span>
            <select
              value={form.doubtModel}
              onChange={(event) => updateField('doubtModel', event.target.value)}
            >
              {form.doubtModels
                .map((model) => model.trim())
                .filter(Boolean)
                .map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
            </select>
          </label>

          <label className="settings-field">
            <span>回答模型上下文窗口（Token，可选）</span>
            <input
              type="number"
              min="4096"
              step="1024"
              value={form.contextWindowOverrides[form.doubtModel] ?? ''}
              onChange={(event) => updateContextWindowOverride(form.doubtModel, event.target.value)}
              placeholder={`自动识别 ${doubtModelCapability.contextWindow}`}
            />
            <small className="settings-field__hint">
              当前使用 {formatTokenCount(doubtModelCapability.contextWindow)}，第三方网关有限制时可覆盖。
            </small>
          </label>

          <label className="settings-field settings-field--full">
            <span>会话自动压缩阈值</span>
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
              阈值按当前回答模型动态计算，并自动预留回答和安全空间。
            </small>
          </label>
          </div>
        </section>

        {/* KNOWLEDGE_GRAPH_PAUSED: Neo4j controls are intentionally hidden until graph work resumes. */}

        <section className="api-config-section">
          <header className="api-config-section__header">
            <div>
              <p className="api-config-section__eyebrow">03 / KNOWLEDGE BASE</p>
              <h4>知识库检索配置</h4>
            </div>
            <p>Embedding 负责建立向量索引，Rerank 负责重排检索候选。</p>
          </header>
          <div className="settings-form">
          <label className="settings-field">
            <span>Embedding Base URL</span>
            <input
              type="text"
              value={form.embeddingBaseUrl}
              onChange={(event) => updateField('embeddingBaseUrl', event.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </label>

          <label className="settings-field">
            <span>Embedding API Key</span>
            <input
              type="password"
              value={form.embeddingApiKey}
              onChange={(event) => updateField('embeddingApiKey', event.target.value)}
              placeholder="sk-..."
            />
          </label>

          <label className="settings-field settings-field--full">
            <span>可用 Embedding 模型列表</span>
            <div className="model-config-list">
              {form.embeddingModels.map((model, index) => (
                <div key={index} className="model-config-row">
                  <input
                    type="text"
                    value={model}
                    onChange={(event) => updateEmbeddingModel(index, event.target.value)}
                    placeholder="例如：GLM-Embedding-3"
                  />
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => removeEmbeddingModel(index)}
                    disabled={form.embeddingModels.length === 1}
                  >
                    删除
                  </button>
                </div>
              ))}
              <button type="button" className="ghost-button" onClick={addEmbeddingModel}>
                添加模型
              </button>
            </div>
          </label>

          <label className="settings-field">
            <span>默认 Embedding 模型</span>
            <select
              value={form.embeddingModel}
              onChange={(event) => updateField('embeddingModel', event.target.value)}
            >
              {form.embeddingModels
                .map((model) => model.trim())
                .filter(Boolean)
                .map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
            </select>
          </label>
          </div>
          <div className="settings-form">
          <label className="settings-field">
            <span>Rerank Base URL</span>
            <input
              type="text"
              value={form.rerankBaseUrl}
              onChange={(event) => updateField('rerankBaseUrl', event.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </label>

          <label className="settings-field">
            <span>Rerank API Key</span>
            <input
              type="password"
              value={form.rerankApiKey}
              onChange={(event) => updateField('rerankApiKey', event.target.value)}
              placeholder="sk-..."
            />
          </label>

          <label className="settings-field settings-field--full">
            <span>可用 Rerank 模型列表</span>
            <div className="model-config-list">
              {form.rerankModels.map((model, index) => (
                <div key={index} className="model-config-row">
                  <input
                    type="text"
                    value={model}
                    onChange={(event) => updateRerankModel(index, event.target.value)}
                    placeholder="例如：GLM-Rerank"
                  />
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => removeRerankModel(index)}
                    disabled={form.rerankModels.length === 1}
                  >
                    删除
                  </button>
                </div>
              ))}
              <button type="button" className="ghost-button" onClick={addRerankModel}>
                添加模型
              </button>
            </div>
          </label>

          <label className="settings-field">
            <span>默认 Rerank 模型</span>
            <select
              value={form.rerankModel}
              onChange={(event) => updateField('rerankModel', event.target.value)}
            >
              {form.rerankModels
                .map((model) => model.trim())
                .filter(Boolean)
                .map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
            </select>
          </label>
          </div>
        </section>

        <section className="api-config-section">
          <header className="api-config-section__header">
            <div>
              <p className="api-config-section__eyebrow">04 / AUDIO TRANSCRIPTION</p>
              <h4>ASR 配置</h4>
            </div>
            <p>课堂录音按短分片顺序上传，优先保留云端返回的时间戳。</p>
          </header>
          <div className="settings-form">
          <label className="settings-field">
            <span>ASR Base URL</span>
            <input
              type="text"
              value={form.asrBaseUrl}
              onChange={(event) => updateField('asrBaseUrl', event.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </label>

          <label className="settings-field">
            <span>ASR API Key</span>
            <input
              type="password"
              value={form.asrApiKey}
              onChange={(event) => updateField('asrApiKey', event.target.value)}
              placeholder="sk-..."
            />
          </label>

          <label className="settings-field">
            <span>ASR Model</span>
            <input
              type="text"
              value={form.asrModel}
              onChange={(event) => updateField('asrModel', event.target.value)}
              placeholder="whisper-1"
            />
          </label>

          <label className="settings-field">
            <span>ASR Prompt (optional)</span>
            <input
              type="text"
              value={form.asrPrompt}
              onChange={(event) => updateField('asrPrompt', event.target.value)}
              placeholder="Course terms or transcription hints"
            />
          </label>
          </div>
        </section>

        <div className="settings-form settings-form--secondary">
          <label className="settings-field">
            <span>网络学堂用户名</span>
            <input
              type="text"
              value={tsinghuaConfig.username}
              onChange={(event) =>
                setTsinghuaConfig((current) => ({ ...current, username: event.target.value }))
              }
              placeholder="例如：fangjh24"
            />
          </label>

          <label className="settings-field">
            <span>网络学堂密码</span>
            <input
              type="password"
              value={tsinghuaPassword}
              onChange={(event) => setTsinghuaPassword(event.target.value)}
              placeholder={tsinghuaConfig.hasPassword ? '留空则保留后端已保存密码' : '请输入密码'}
            />
          </label>

          <label className="settings-field settings-field--full">
            <span>自动登录策略</span>
            <select
              value={tsinghuaConfig.autoLoginEnabled ? 'enabled' : 'disabled'}
              onChange={(event) =>
                setTsinghuaConfig((current) => ({
                  ...current,
                  autoLoginEnabled: event.target.value === 'enabled',
                }))
              }
            >
              <option value="enabled">启用自动填充账号密码并复用会话</option>
              <option value="disabled">仅复用会话，不自动填充账号密码</option>
            </select>
          </label>
        </div>

        <div className="settings-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => void handleSave()}
            disabled={isLoading || isSaving}
          >
            保存配置
          </button>
          <p className="settings-status">{status}</p>
        </div>
      </section>

      <section className="settings-grid">
        <article className="panel">
          <div className="panel-heading">
            <div>
              <p className="section-label">自动化</p>
              <h3>网络学堂同步现在怎么工作</h3>
            </div>
          </div>
          <div className="stat-stack">
            <div className="stat-card">
              <span>1</span>
              <strong>账号密码只保存在后端</strong>
              <p>用户名会显示在配置页，密码不会从后端回传到浏览器；留空保存会继续沿用后端已保存密码。</p>
            </div>
            <div className="stat-card">
              <span>2</span>
              <strong>固定浏览器会话复用</strong>
              <p>同步窗口关闭后不会删除浏览器登录态，后面再次同步会优先复用之前的清华学堂 cookies。</p>
            </div>
            <div className="stat-card">
              <span>3</span>
              <strong>必要时自动填充登录页</strong>
              <p>如果学校让你重新登录，系统会自动填充已保存的用户名密码；若学校强制二次认证，仍可能需要你补一次认证。</p>
            </div>
          </div>
        </article>

        <article className="panel">
          <div className="panel-heading">
            <div>
              <p className="section-label">限制说明</p>
              <h3>哪些步骤仍可能需要人工</h3>
            </div>
          </div>
          <div className="stat-stack">
            <div className="stat-card">
              <span>二次认证</span>
              <strong>学校若强制重做 2FA，系统不能绕过</strong>
              <p>这部分由清华统一认证控制。我们现在能做的是尽量复用已登录会话，减少重新触发 2FA 的次数。</p>
            </div>
            <div className="stat-card">
              <span>课程抓取</span>
              <strong>只抓当前学期课程标题</strong>
              <p>系统现在只识别你截图里那一列 `.hdtitle a.title`，不会再把以前学期课程或公开课程混进知识库。</p>
            </div>
          </div>
        </article>
      </section>
    </main>
  )
}
