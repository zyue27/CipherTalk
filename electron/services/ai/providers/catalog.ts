import { BaseAIProvider, type ProviderKind } from './base'

export type AIProviderProtocol = ProviderKind

export interface AIProviderMetadata {
  id: string
  name: string
  displayName: string
  description: string
  protocol: AIProviderProtocol
  baseURL: string
  models: string[]
  pricing: string
  pricingDetail: {
    input: number
    output: number
  }
  website?: string
  logo?: string
  optionalApiKey?: boolean
  allowCustomBaseURL?: boolean
}

const OPENAI_COMPATIBLE_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'claude-3-5-sonnet-20241022',
  'gemini-2.5-flash',
  'deepseek-chat',
  'qwen-plus',
  'custom-model'
]

const PROVIDERS: AIProviderMetadata[] = [
  {
    id: 'openai',
    name: 'openai',
    displayName: 'OpenAI',
    description: 'OpenAI Responses API',
    protocol: 'openai-responses',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o4-mini'],
    pricing: '按量计费',
    pricingDetail: { input: 0.0025, output: 0.01 },
    website: 'https://openai.com/',
    logo: './AI-logo/openai.svg'
  },
  {
    id: 'openai-compatible',
    name: 'openai-compatible',
    displayName: 'OpenAI 兼容',
    description: 'OpenAI-compatible Chat Completions 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    models: OPENAI_COMPATIBLE_MODELS,
    pricing: '根据实际服务商定价',
    pricingDetail: { input: 0, output: 0 },
    website: '',
    logo: './AI-logo/custom.svg',
    allowCustomBaseURL: true
  },
  {
    id: 'anthropic',
    name: 'anthropic',
    displayName: 'Anthropic',
    description: 'Claude Messages API',
    protocol: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    models: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-3-7-sonnet-latest'],
    pricing: '按量计费',
    pricingDetail: { input: 0.003, output: 0.015 },
    website: 'https://www.anthropic.com/',
    logo: ''
  },
  {
    id: 'custom-responses',
    name: 'custom-responses',
    displayName: '自定义（OpenAI Responses）',
    description: 'OpenAI Responses API，可填写兼容 Responses 的服务地址',
    protocol: 'openai-responses',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o4-mini', 'gpt-5-mini'],
    pricing: '根据实际服务商定价',
    pricingDetail: { input: 0, output: 0 },
    website: '',
    logo: './AI-logo/openai.svg',
    allowCustomBaseURL: true
  },
  {
    id: 'gemini',
    name: 'gemini',
    displayName: 'Gemini',
    description: 'Google Gemini 原生协议',
    protocol: 'google',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    pricing: '按量计费',
    pricingDetail: { input: 0.00015, output: 0.0006 },
    website: 'https://ai.google.dev/',
    logo: './AI-logo/gemini-color.svg'
  },
  {
    id: 'deepseek',
    name: 'deepseek',
    displayName: 'DeepSeek',
    description: 'OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    pricing: '¥0.001/1K tokens',
    pricingDetail: { input: 0.001, output: 0.002 },
    website: 'https://www.deepseek.com/',
    logo: './AI-logo/deepseek-color.svg'
  },
  {
    id: 'qwen',
    name: 'qwen',
    displayName: '通义千问',
    description: 'DashScope OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'],
    pricing: '¥0.004/1K tokens',
    pricingDetail: { input: 0.004, output: 0.012 },
    website: 'https://dashscope.aliyun.com/',
    logo: './AI-logo/qwen-color.svg'
  },
  {
    id: 'doubao',
    name: 'doubao',
    displayName: '豆包',
    description: '火山方舟 OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-1-6', 'doubao-seed-1-6-thinking', 'doubao-pro-32k'],
    pricing: '按量计费',
    pricingDetail: { input: 0.0008, output: 0.002 },
    website: 'https://www.volcengine.com/product/ark',
    logo: './AI-logo/doubao-color.svg'
  },
  {
    id: 'kimi',
    name: 'kimi',
    displayName: 'Kimi',
    description: 'Moonshot OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    pricing: '¥0.012/1K tokens',
    pricingDetail: { input: 0.012, output: 0.012 },
    website: 'https://platform.moonshot.cn/',
    logo: './AI-logo/kimi-color.svg'
  },
  {
    id: 'minimax',
    name: 'minimax',
    displayName: 'MiniMax',
    description: 'MiniMax OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://api.minimaxi.com/v1',
    models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5'],
    pricing: '¥0.0021/1K tokens 起（估算）',
    pricingDetail: { input: 0.0021, output: 0.0084 },
    website: 'https://platform.minimaxi.com/',
    logo: './AI-logo/minimax.svg'
  },
  {
    id: 'siliconflow',
    name: 'siliconflow',
    displayName: '硅基流动',
    description: 'OpenAI-compatible 聚合接口',
    protocol: 'openai-compatible',
    baseURL: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen3-235B-A22B'],
    pricing: '按模型计费',
    pricingDetail: { input: 0.001, output: 0.002 },
    website: 'https://siliconflow.cn/',
    logo: './AI-logo/siliconflow-color.svg'
  },
  {
    id: 'xiaomi',
    name: 'xiaomi',
    displayName: 'Xiaomi MiMo',
    description: 'OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://api.xiaomimimo.com/v1',
    models: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-pro', 'mimo-v2-flash'],
    pricing: '免费',
    pricingDetail: { input: 0, output: 0 },
    website: 'https://api.xiaomimimo.com/',
    logo: './AI-logo/xiaomimimo.svg'
  },
  {
    id: 'tencent',
    name: 'tencent',
    displayName: '腾讯元宝',
    description: '腾讯混元 OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: ['hunyuan-turbos-latest', 'hunyuan-t1-latest', 'hunyuan-large-role-latest'],
    pricing: '¥0.01/1K tokens (Std)',
    pricingDetail: { input: 0.01, output: 0.01 },
    website: 'https://cloud.tencent.com/product/hunyuan',
    logo: './AI-logo/yuanbao-color.svg'
  },
  {
    id: 'xai',
    name: 'xai',
    displayName: 'xAI',
    description: 'xAI OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3', 'grok-3-mini'],
    pricing: '按量计费',
    pricingDetail: { input: 0.003, output: 0.015 },
    website: 'https://x.ai/',
    logo: './AI-logo/xai.svg'
  },
  {
    id: 'zhipu',
    name: 'zhipu',
    displayName: '智谱AI',
    description: '智谱 OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.5', 'glm-4.5-flash', 'glm-4-plus'],
    pricing: '¥0.005/1K tokens',
    pricingDetail: { input: 0.005, output: 0.005 },
    website: 'https://open.bigmodel.cn/',
    logo: './AI-logo/zhipu-color.svg'
  },
  {
    id: 'ollama',
    name: 'ollama',
    displayName: 'Ollama (本地)',
    description: '本地 OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
    models: ['qwen2.5:latest', 'llama3.3:latest', 'deepseek-r1:latest', 'gemma2:latest'],
    pricing: '免费（本地运行）',
    pricingDetail: { input: 0, output: 0 },
    website: 'https://ollama.com/',
    logo: './AI-logo/ollama.svg',
    optionalApiKey: true,
    allowCustomBaseURL: true
  },
  {
    id: 'custom',
    name: 'custom',
    displayName: '自定义（OpenAI 兼容）',
    description: '支持任何 OpenAI-compatible API 服务',
    protocol: 'openai-compatible',
    baseURL: '',
    models: OPENAI_COMPATIBLE_MODELS,
    pricing: '根据实际服务商定价',
    pricingDetail: { input: 0, output: 0 },
    website: '',
    logo: './AI-logo/custom.svg',
    allowCustomBaseURL: true
  }
]

const PROVIDER_BY_ID = new Map(PROVIDERS.map(provider => [provider.id, provider]))

export function getProviderDefinitions(): AIProviderMetadata[] {
  return PROVIDERS.map(provider => ({ ...provider, models: [...provider.models], pricingDetail: { ...provider.pricingDetail } }))
}

export function getProviderDefinition(providerId: string): AIProviderMetadata | undefined {
  const provider = PROVIDER_BY_ID.get(providerId)
  return provider ? { ...provider, models: [...provider.models], pricingDetail: { ...provider.pricingDetail } } : undefined
}

export class CatalogAIProvider extends BaseAIProvider {
  name: string
  displayName: string
  models: string[]
  pricing: { input: number; output: number }
  private definition: AIProviderMetadata

  constructor(definition: AIProviderMetadata, apiKey: string, baseURL?: string) {
    const effectiveBaseURL = baseURL || definition.baseURL
    super(apiKey, effectiveBaseURL, definition.protocol)
    this.definition = definition
    this.name = definition.name
    this.displayName = definition.displayName
    this.models = definition.models
    this.pricing = definition.pricingDetail
  }

  protected getDefaultHeaders(): Record<string, string> | undefined {
    if (this.definition.id !== 'tencent' || !this.apiKey.includes('|')) {
      return undefined
    }

    const [secretId, secretKey] = this.apiKey.split('|').map(part => part.trim())
    if (!secretId || !secretKey) return undefined
    return { Authorization: `Bearer ${secretId};${secretKey}` }
  }
}

let modelsDevCache: { updatedAt: number; data: any } | null = null
const MODELS_DEV_CACHE_MS = 1000 * 60 * 60

function normalizeModelsDevProviderId(providerId: string): string[] {
  const aliases: Record<string, string[]> = {
    gemini: ['google', 'google-generative-ai', 'gemini'],
    qwen: ['alibaba', 'dashscope', 'qwen'],
    doubao: ['bytedance', 'volcengine', 'doubao'],
    kimi: ['moonshotai', 'moonshot', 'kimi'],
    siliconflow: ['siliconflow'],
    zhipu: ['zhipu', 'bigmodel'],
    tencent: ['tencent', 'hunyuan'],
    xai: ['xai'],
    minimax: ['minimax']
  }
  return aliases[providerId] || [providerId]
}

function readModelsFromModelsDevProvider(provider: any): string[] {
  const models = provider?.models || provider
  if (Array.isArray(models)) {
    return models
      .map((item: any) => String(item?.id || item?.name || item || '').replace(/^models\//, '').trim())
      .filter(Boolean)
  }

  if (models && typeof models === 'object') {
    return Object.entries(models)
      .map(([id, value]: [string, any]) => String(value?.id || value?.name || id || '').replace(/^models\//, '').trim())
      .filter(Boolean)
  }

  return []
}

export async function getModelsDevModels(providerId: string): Promise<string[]> {
  const now = Date.now()
  if (!modelsDevCache || now - modelsDevCache.updatedAt > MODELS_DEV_CACHE_MS) {
    const response = await fetch('https://models.dev/api.json')
    if (!response.ok) {
      throw new Error(`models.dev 请求失败: ${response.status}`)
    }
    modelsDevCache = { updatedAt: now, data: await response.json() }
  }

  const data = modelsDevCache.data
  const providers = data?.providers || data
  for (const candidate of normalizeModelsDevProviderId(providerId)) {
    const provider = providers?.[candidate]
    const models = readModelsFromModelsDevProvider(provider)
    if (models.length > 0) return Array.from(new Set(models))
  }

  return []
}
