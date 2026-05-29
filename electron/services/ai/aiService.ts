import { ConfigService } from '../config'
import { ZhipuProvider, ZhipuMetadata } from './providers/zhipu'
import { DeepSeekProvider, DeepSeekMetadata } from './providers/deepseek'
import { QwenProvider, QwenMetadata } from './providers/qwen'
import { DoubaoProvider, DoubaoMetadata } from './providers/doubao'
import { KimiProvider, KimiMetadata } from './providers/kimi'
import { SiliconFlowProvider, SiliconFlowMetadata } from './providers/siliconflow'
import { XiaomiProvider, XiaomiMetadata } from './providers/xiaomi'
import { TencentProvider, TencentMetadata } from './providers/tencent'
import { XAIProvider, XAIMetadata } from './providers/xai'
import { OpenAIProvider, OpenAIMetadata } from './providers/openai'
import { MiniMaxProvider, MiniMaxMetadata } from './providers/minimax'
import { GeminiProvider, GeminiMetadata } from './providers/gemini'
import { OllamaProvider, OllamaMetadata } from './providers/ollama'
import { CustomProvider, CustomMetadata } from './providers/custom'
import { AIProvider } from './providers/base'

class AIService {
  private configService: ConfigService

  constructor() {
    this.configService = new ConfigService()
  }

  getAllProviders() {
    return [
      OpenAIMetadata,
      MiniMaxMetadata,
      GeminiMetadata,
      XAIMetadata,
      DeepSeekMetadata,
      ZhipuMetadata,
      QwenMetadata,
      DoubaoMetadata,
      KimiMetadata,
      SiliconFlowMetadata,
      XiaomiMetadata,
      TencentMetadata,
      OllamaMetadata,
      CustomMetadata
    ]
  }

  createProvider(providerName?: string, apiKey?: string, baseURLOverride?: string): AIProvider {
    return this.getProvider(providerName, apiKey, baseURLOverride)
  }

  private getProvider(providerName?: string, apiKey?: string, baseURLOverride?: string): AIProvider {
    const name = providerName || this.configService.getAICurrentProvider() || 'deepseek'

    let key = apiKey
    if (!key) {
      const providerConfig = this.configService.getAIProviderConfig(name)
      key = providerConfig?.apiKey
    }

    if (!key && name !== 'ollama') {
      throw new Error('未配置API密钥')
    }

    switch (name) {
      case 'custom': {
        const customConfig = this.configService.getAIProviderConfig('custom')
        const customBaseURL = baseURLOverride || customConfig?.baseURL
        if (!customBaseURL) {
          throw new Error('自定义服务需要配置服务地址')
        }
        return new CustomProvider(key || '', customBaseURL)
      }
      case 'ollama': {
        const ollamaConfig = this.configService.getAIProviderConfig('ollama')
        const baseURL = baseURLOverride || ollamaConfig?.baseURL || 'http://localhost:11434/v1'
        return new OllamaProvider(key || 'ollama', baseURL)
      }
      case 'openai':
        return new OpenAIProvider(key!)
      case 'minimax':
        return new MiniMaxProvider(key!)
      case 'gemini':
        return new GeminiProvider(key!)
      case 'zhipu':
        return new ZhipuProvider(key!)
      case 'deepseek':
        return new DeepSeekProvider(key!)
      case 'qwen':
        return new QwenProvider(key!)
      case 'doubao':
        return new DoubaoProvider(key!)
      case 'kimi':
        return new KimiProvider(key!)
      case 'siliconflow':
        return new SiliconFlowProvider(key!)
      case 'xiaomi':
        return new XiaomiProvider(key!)
      case 'tencent':
        return new TencentProvider(key!)
      case 'xai':
        return new XAIProvider(key!)
      default:
        throw new Error(`不支持的提供商: ${name}`)
    }
  }

  estimateTokens(text: string): number {
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
    const otherChars = text.length - chineseChars
    return Math.ceil(chineseChars / 1.5 + otherChars / 4)
  }

  estimateCost(tokenCount: number, providerName: string): number {
    const provider = this.getProvider(providerName)
    return (tokenCount / 1000) * provider.pricing.input
  }

  async testConnection(providerName: string, apiKey: string, baseURL?: string): Promise<{ success: boolean; error?: string; needsProxy?: boolean }> {
    try {
      const provider = this.getProvider(providerName, apiKey, baseURL)
      return await provider.testConnection()
    } catch (error) {
      return {
        success: false,
        error: `连接失败: ${String(error)}`,
        needsProxy: true
      }
    }
  }

  private normalizeRemoteModelList(models: string[]): string[] {
    const unique = Array.from(new Set(
      models
        .map((model) => String(model || '').trim())
        .filter(Boolean)
    ))

    const nonChatPatterns = [
      'embedding',
      'rerank',
      'whisper',
      'tts',
      'transcribe',
      'speech',
      'moderation',
      'dall-e',
      'image',
      'stable-diffusion'
    ]
    const chatModels = unique.filter((model) => {
      const lower = model.toLowerCase()
      return !nonChatPatterns.some((pattern) => lower.includes(pattern))
    })

    return chatModels.length > 0 ? chatModels : unique
  }

  private compareDiscoveredModels(a: string, b: string): number {
    const parseSortParts = (model: string) => {
      const lower = model.toLowerCase()
      const dateMatch = lower.match(/20\d{2}[-_.]?\d{2}[-_.]?\d{2}|20\d{4}/)
      const dateValue = dateMatch ? Number(dateMatch[0].replace(/\D/g, '')) : 0
      const numbers = Array.from(lower.matchAll(/\d+(?:\.\d+)?/g)).map(match => Number(match[0]))
      const family = lower
        .replace(/20\d{2}[-_.]?\d{2}[-_.]?\d{2}|20\d{4}/g, '')
        .replace(/\d+(?:\.\d+)?/g, '')
        .replace(/[-_.:]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      return {
        lower,
        family,
        numbers,
        dateValue,
        latest: lower.includes('latest')
      }
    }

    const left = parseSortParts(a)
    const right = parseSortParts(b)
    const familyCompare = left.family.localeCompare(right.family, 'en', { sensitivity: 'base' })
    if (familyCompare !== 0) return familyCompare
    if (left.latest !== right.latest) return left.latest ? -1 : 1
    if (left.dateValue !== right.dateValue) return right.dateValue - left.dateValue

    const maxLength = Math.max(left.numbers.length, right.numbers.length)
    for (let index = 0; index < maxLength; index += 1) {
      const leftNumber = left.numbers[index] ?? -1
      const rightNumber = right.numbers[index] ?? -1
      if (leftNumber !== rightNumber) return rightNumber - leftNumber
    }

    return left.lower.localeCompare(right.lower, 'en', { numeric: true, sensitivity: 'base' })
  }

  private mergeProviderModelLists(provider: AIProvider, remoteModels: string[]): string[] {
    const result: string[] = []
    const seen = new Set<string>()
    const addModel = (model: string) => {
      const value = String(model || '').trim()
      if (!value) return
      const identity = provider.getModelIdentity(value) || value.toLowerCase()
      if (seen.has(identity)) return
      seen.add(identity)
      result.push(value)
    }

    provider.models.forEach(addModel)
    remoteModels
      .filter(model => !seen.has(provider.getModelIdentity(model) || model.toLowerCase()))
      .sort((a, b) => this.compareDiscoveredModels(a, b))
      .forEach(addModel)

    return result
  }

  async listProviderModels(options: { provider: string; apiKey?: string; baseURL?: string }): Promise<{ success: boolean; models?: string[]; error?: string }> {
    try {
      const provider = this.getProvider(options.provider, options.apiKey, options.baseURL)
      const models = this.mergeProviderModelLists(
        provider,
        this.normalizeRemoteModelList(await provider.listModels())
      )
      if (models.length === 0) {
        return { success: false, error: '服务商未返回可用模型列表' }
      }
      return { success: true, models }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[AIService] 获取模型列表失败:', message)
      return { success: false, error: message }
    }
  }
}

export const aiService = new AIService()
