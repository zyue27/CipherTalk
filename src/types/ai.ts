/**
 * AI 提供商信息
 */
export interface AIProviderInfo {
  id: string
  name: string
  displayName: string
  description: string
  models: string[]
  pricing: string
  pricingDetail: {
    input: number
    output: number
  }
  website?: string
  logo?: string
}

/**
 * 获取所有 AI 提供商（从后端获取）
 */
export async function getAIProviders(): Promise<AIProviderInfo[]> {
  try {
    return await window.electronAPI.ai.getProviders()
  } catch (e) {
    console.error('获取 AI 提供商列表失败:', e)
    return []
  }
}
