import { useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff, HelpCircle, Plus, RefreshCw, Settings2, Sparkles, X } from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { getAIProviders, type AIProviderInfo } from '../../types/ai'
import * as configService from '../../services/config'
import { useSettingsStore } from '../settings/settingsStore'
import Select from '../Select'
import AIProviderLogo from './AIProviderLogo'
import './AISummarySettings.scss'

interface AISummarySettingsProps {
  showMessage: (text: string, success: boolean) => void
}

const DEEPSEEK_LEGACY_MODEL_MAP: Record<string, string> = {
  'DeepSeek V3': 'deepseek-v4-flash',
  'DeepSeek R1 (推理)': 'deepseek-v4-flash',
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-flash'
}

function normalizeProviderModel(providerId: string, modelName: string) {
  return providerId === 'deepseek'
    ? DEEPSEEK_LEGACY_MODEL_MAP[modelName] || modelName
    : modelName
}

function normalizeProviderBaseURL(providerId: string, baseURL: string) {
  if (providerId === 'ollama') {
    return (baseURL || 'http://localhost:11434/v1').trim().replace(/\/+$/, '')
  }
  return baseURL.trim().replace(/\/+$/, '')
}

function canFetchProviderModelList(providerId: string, apiKey: string, baseURL: string) {
  if (!providerId) return false
  if (providerId === 'ollama') return true
  if (providerId === 'custom') return Boolean(apiKey.trim() && baseURL.trim())
  return Boolean(apiKey.trim())
}

function AISummarySettings({ showMessage }: AISummarySettingsProps) {
  const provider = useSettingsStore(s => s.config.aiProvider)
  const apiKey = useSettingsStore(s => s.config.aiApiKey)
  const model = useSettingsStore(s => s.config.aiModel)
  const setField = useSettingsStore(s => s.setField)

  const [providers, setProviders] = useState<AIProviderInfo[]>([])
  const [providerConfigs, setProviderConfigs] = useState<Record<string, { apiKey: string; model: string; baseURL?: string }>>({})
  const [baseURL, setBaseURL] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [remoteModels, setRemoteModels] = useState<string[]>([])
  const [modelListError, setModelListError] = useState('')
  const [presets, setPresets] = useState<configService.AiConfigPreset[]>([])
  const [showPresetDrawer, setShowPresetDrawer] = useState(false)
  const [showSavePresetDialog, setShowSavePresetDialog] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null)
  const [showOllamaHelp, setShowOllamaHelp] = useState(false)
  const [showCustomHelp, setShowCustomHelp] = useState(false)
  const [ollamaGuideContent, setOllamaGuideContent] = useState('')
  const [customGuideContent, setCustomGuideContent] = useState('')

  const currentProvider = providers.find(p => p.id === provider)
  const modelOptions = useMemo(() => {
    const models = remoteModels.length > 0 ? remoteModels : (currentProvider?.models || [])
    return models.map(item => ({ value: item, label: item }))
  }, [currentProvider?.models, remoteModels])

  useEffect(() => {
    void loadProviders()
    void loadAllProviderConfigs()
    void loadPresets()
  }, [])

  useEffect(() => {
    if (!provider) return
    const config = providerConfigs[provider]
    if (provider === 'ollama') {
      setBaseURL(config?.baseURL || 'http://localhost:11434/v1')
    } else if (provider === 'custom') {
      setBaseURL(config?.baseURL || '')
    } else {
      setBaseURL('')
    }

    if (config) {
      setField('aiApiKey', config.apiKey || '')
      setField('aiModel', normalizeProviderModel(provider, config.model || ''))
    } else if (currentProvider?.models?.length && !model) {
      setField('aiModel', normalizeProviderModel(provider, currentProvider.models[0]))
    }
    setRemoteModels([])
    setModelListError('')
  }, [provider, providerConfigs, currentProvider?.models])

  useEffect(() => {
    const normalized = normalizeProviderModel(provider, model)
    if (normalized !== model) {
      setField('aiModel', normalized)
    }
  }, [provider, model, setField])

  const loadProviders = async () => {
    const list = await getAIProviders()
    setProviders(list)
    if (!provider && list[0]?.id) {
      setField('aiProvider', list[0].id)
    }
  }

  const loadAllProviderConfigs = async () => {
    const configs = await configService.getAllAiProviderConfigs()
    setProviderConfigs(configs || {})
  }

  const loadPresets = async () => {
    setPresets(await configService.getAiConfigPresets())
  }

  const persistProviderConfig = async (nextProvider = provider, nextApiKey = apiKey, nextModel = model, nextBaseURL = baseURL) => {
    const payload = {
      apiKey: nextApiKey,
      model: normalizeProviderModel(nextProvider, nextModel),
      baseURL: nextProvider === 'ollama' || nextProvider === 'custom'
        ? normalizeProviderBaseURL(nextProvider, nextBaseURL)
        : undefined
    }
    await configService.setAiProvider(nextProvider)
    await configService.setAiProviderConfig(nextProvider, payload)
    setProviderConfigs(prev => ({ ...prev, [nextProvider]: payload }))
  }

  const handleSelectProvider = async (providerId: string) => {
    await persistProviderConfig()
    setField('aiProvider', providerId)
    await configService.setAiProvider(providerId)
  }

  const handleRefreshModels = async () => {
    if (!canFetchProviderModelList(provider, apiKey, baseURL)) {
      showMessage('请先填写当前服务商所需的 API 配置', false)
      return
    }
    setIsLoadingModels(true)
    setModelListError('')
    try {
      const result = await window.electronAPI.ai.listModels({ provider, apiKey, baseURL })
      if (!result.success || !result.models?.length) {
        const error = result.error || '模型列表为空'
        setModelListError(error)
        showMessage(error, false)
        return
      }
      setRemoteModels(result.models)
      if (!result.models.includes(model)) {
        setField('aiModel', result.models[0])
      }
      showMessage('模型列表已刷新', true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setModelListError(message)
      showMessage(`刷新模型失败: ${message}`, false)
    } finally {
      setIsLoadingModels(false)
    }
  }

  const handleTestConnection = async () => {
    if (provider !== 'ollama' && !apiKey.trim()) {
      showMessage('请先填写 API 密钥', false)
      return
    }
    if (provider === 'custom' && !baseURL.trim()) {
      showMessage('自定义服务需要填写服务地址', false)
      return
    }

    setIsTesting(true)
    try {
      const result = await window.electronAPI.ai.testConnection(provider, apiKey, baseURL)
      showMessage(result.success ? '连接测试成功' : (result.error || '连接测试失败'), result.success)
      if (result.success) {
        await persistProviderConfig()
      }
    } finally {
      setIsTesting(false)
    }
  }

  const loadGuide = async (guideName: string) => {
    const result = await window.electronAPI.ai.readGuide(guideName)
    if (!result.success || !result.content) {
      showMessage(result.error || '指南加载失败', false)
      return ''
    }
    const html = await marked.parse(result.content)
    return DOMPurify.sanitize(html)
  }

  const openOllamaGuide = async () => {
    setShowOllamaHelp(true)
    if (!ollamaGuideContent) {
      setOllamaGuideContent(await loadGuide('Ollama使用指南.md'))
    }
  }

  const openCustomGuide = async () => {
    setShowCustomHelp(true)
    if (!customGuideContent) {
      setCustomGuideContent(await loadGuide('自定义AI服务使用指南.md'))
    }
  }

  const handleSavePreset = async () => {
    const name = presetName.trim()
    if (!name) {
      showMessage('请输入配置名称', false)
      return
    }
    const payload = { name, provider, apiKey, model, baseURL: baseURL || undefined }
    if (editingPresetId) {
      await configService.updateAiConfigPreset(editingPresetId, payload)
      showMessage('配置预设已更新', true)
    } else {
      await configService.saveAiConfigPreset(payload)
      showMessage('配置预设已保存', true)
    }
    setShowSavePresetDialog(false)
    setEditingPresetId(null)
    setPresetName('')
    await loadPresets()
  }

  const handleLoadPreset = async (presetId: string) => {
    const preset = await configService.loadAiConfigPreset(presetId)
    if (!preset) {
      showMessage('配置预设不存在', false)
      return
    }
    setField('aiProvider', preset.provider)
    setField('aiApiKey', preset.apiKey)
    setField('aiModel', normalizeProviderModel(preset.provider, preset.model))
    setBaseURL(preset.baseURL || '')
    await persistProviderConfig(preset.provider, preset.apiKey, preset.model, preset.baseURL || '')
    showMessage('配置预设已加载', true)
  }

  const handleEditPreset = (preset: configService.AiConfigPreset) => {
    setEditingPresetId(preset.id)
    setPresetName(preset.name)
    setField('aiProvider', preset.provider)
    setField('aiApiKey', preset.apiKey)
    setField('aiModel', normalizeProviderModel(preset.provider, preset.model))
    setBaseURL(preset.baseURL || '')
    setShowSavePresetDialog(true)
  }

  const handleDeletePreset = async (presetId: string) => {
    await configService.deleteAiConfigPreset(presetId)
    await loadPresets()
    showMessage('配置预设已删除', true)
  }

  return (
    <div className="tab-content ai-summary-settings">
      <div className="settings-section-header">
        <h2>AI 接入配置</h2>
        <p>管理第三方 AI 服务商、模型、API 密钥和代理连接。</p>
      </div>

      <div className="provider-selector-capsule">
        {providers.map(item => (
          <button
            key={item.id}
            type="button"
            className={`provider-capsule ${provider === item.id ? 'active' : ''}`}
            onClick={() => handleSelectProvider(item.id)}
          >
            <AIProviderLogo providerId={item.id} logo={item.logo} alt={item.displayName} className="provider-logo" size={18} />
            <span className="provider-name">{item.displayName}</span>
          </button>
        ))}
      </div>

      <div className="settings-form">
        <div className="form-group">
          <label>当前服务商</label>
          <div className="provider-current">
            <AIProviderLogo providerId={provider} logo={currentProvider?.logo} alt={currentProvider?.displayName || provider} className="provider-logo" size={28} />
            <div>
              <strong>{currentProvider?.displayName || provider}</strong>
              <p>{currentProvider?.description || 'OpenAI 兼容接口'}</p>
            </div>
          </div>
        </div>

        {(provider === 'ollama' || provider === 'custom') && (
          <div className="form-group">
            <label>服务地址</label>
            <div className="input-with-button">
              <input
                type="text"
                value={baseURL}
                onChange={(event) => setBaseURL(event.target.value)}
                placeholder={provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.example.com/v1'}
                className="api-key-input"
              />
              <button
                type="button"
                className="help-btn"
                onClick={provider === 'ollama' ? openOllamaGuide : openCustomGuide}
                title="查看接入指南"
              >
                <HelpCircle size={18} />
              </button>
            </div>
          </div>
        )}

        <div className="form-group">
          <label>API 密钥</label>
          <div className="api-key-container">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(event) => setField('aiApiKey', event.target.value)}
              placeholder={provider === 'ollama' ? '本地服务无需密钥（可选）' : '请输入 API 密钥'}
              className="api-key-input"
            />
            <button type="button" className="toggle-visibility" onClick={() => setShowApiKey(!showApiKey)}>
              {showApiKey ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </div>

        <div className="form-group">
          <label>模型</label>
          <div className="select-with-actions">
            <Select
              value={model}
              onChange={(value) => setField('aiModel', normalizeProviderModel(provider, String(value)))}
              options={modelOptions}
              placeholder="请选择或输入模型名称"
              editable
            />
            <button
              type="button"
              className="select-refresh-btn"
              onClick={handleRefreshModels}
              disabled={isLoadingModels || !canFetchProviderModelList(provider, apiKey, baseURL)}
              title="刷新模型列表"
            >
              <RefreshCw size={16} className={isLoadingModels ? 'spin' : ''} />
            </button>
          </div>
          <div className={`form-hint model-list-hint ${modelListError ? 'error' : ''}`}>
            {modelListError || (remoteModels.length > 0 ? '远程模型列表' : '内置模型列表')}
          </div>
        </div>

        <div className="button-group">
          <button type="button" className="test-btn" onClick={handleTestConnection} disabled={isTesting}>
            {isTesting ? <Sparkles size={16} className="spin" /> : <Sparkles size={16} />}
            {isTesting ? '测试中...' : '测试连接'}
          </button>
          <button
            type="button"
            className="preset-btn load"
            onClick={async () => {
              await persistProviderConfig()
              showMessage('AI 接入配置已保存', true)
            }}
          >
            保存当前服务商
          </button>
          <button
            type="button"
            className="preset-btn"
            onClick={() => {
              setEditingPresetId(null)
              setPresetName(currentProvider?.displayName || provider)
              setShowSavePresetDialog(true)
            }}
          >
            <Plus size={16} /> 存为预设
          </button>
          <button type="button" className="preset-btn" onClick={() => setShowPresetDrawer(true)}>
            <Settings2 size={16} /> 管理预设
          </button>
        </div>
      </div>

      <div className="info-box-simple">
        <p>提示：API 密钥仅保存在本地。连接测试与模型刷新会向当前服务商发起请求。</p>
      </div>

      {showOllamaHelp && (
        <div className="ollama-help-modal" onClick={() => setShowOllamaHelp(false)}>
          <div className="ollama-help-content" onClick={(event) => event.stopPropagation()}>
            <div className="ollama-help-header">
              <h2>Ollama 本地 AI 使用指南</h2>
              <button className="close-btn" onClick={() => setShowOllamaHelp(false)}><X size={20} /></button>
            </div>
            <div className="ollama-help-body markdown-content" dangerouslySetInnerHTML={{ __html: ollamaGuideContent || '<p>加载中...</p>' }} />
          </div>
        </div>
      )}

      {showCustomHelp && (
        <div className="ollama-help-modal" onClick={() => setShowCustomHelp(false)}>
          <div className="ollama-help-content" onClick={(event) => event.stopPropagation()}>
            <div className="ollama-help-header">
              <h2>自定义 AI 服务使用指南</h2>
              <button className="close-btn" onClick={() => setShowCustomHelp(false)}><X size={20} /></button>
            </div>
            <div className="ollama-help-body markdown-content" dangerouslySetInnerHTML={{ __html: customGuideContent || '<p>加载中...</p>' }} />
          </div>
        </div>
      )}

      {showSavePresetDialog && (
        <div className="ollama-help-modal" onClick={() => setShowSavePresetDialog(false)}>
          <div className="ollama-help-content" onClick={(event) => event.stopPropagation()} style={{ maxWidth: '500px' }}>
            <div className="ollama-help-header">
              <h2>{editingPresetId ? '编辑配置预设' : '新增配置预设'}</h2>
              <button className="close-btn" onClick={() => setShowSavePresetDialog(false)}><X size={20} /></button>
            </div>
            <div className="ollama-help-body">
              <div className="form-group">
                <label>配置名称</label>
                <input
                  type="text"
                  value={presetName}
                  onChange={(event) => setPresetName(event.target.value)}
                  className="api-key-input"
                  autoFocus
                />
              </div>
              <div className="form-hint">{currentProvider?.displayName || provider} · {model || '未选择模型'}</div>
              <div className="button-group" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
                <button className="preset-btn" onClick={() => setShowSavePresetDialog(false)}>取消</button>
                <button className="preset-btn load" onClick={handleSavePreset}>保存</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showPresetDrawer && (
        <>
          <div className="drawer-overlay" onClick={() => setShowPresetDrawer(false)} />
          <div className="preset-drawer">
            <div className="drawer-header">
              <h2>配置预设管理</h2>
              <button className="close-btn" onClick={() => setShowPresetDrawer(false)}><X size={20} /></button>
            </div>
            <div className="drawer-body">
              {presets.length === 0 ? (
                <div className="empty-state">
                  <p>暂无配置预设</p>
                  <p className="empty-hint">保存当前服务商配置后可快速切换。</p>
                </div>
              ) : (
                <div className="presets-list">
                  {presets.map(preset => (
                    <div key={preset.id} className="preset-item">
                      <div className="preset-info">
                        <span className="preset-name">{preset.name}</span>
                        <span className="preset-detail">{preset.provider} · {preset.model}</span>
                      </div>
                      <div className="preset-actions">
                        <button className="preset-btn load" onClick={() => { void handleLoadPreset(preset.id); setShowPresetDrawer(false) }}>加载</button>
                        <button className="preset-btn edit" onClick={() => handleEditPreset(preset)}>编辑</button>
                        <button className="preset-btn delete" onClick={() => void handleDeletePreset(preset.id)}>删除</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default AISummarySettings
