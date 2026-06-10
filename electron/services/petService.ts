import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

/**
 * AI 宠物服务 —— 兼容 petdex 宠物包格式（同 Codex Pets）。
 * 宠物包 = pet.json + spritesheet.webp/png（8 列 × 9 行精灵图，每帧 192×208）。
 * 本地宠物存放在 userData/pets/<slug>/，在线画廊走 petdex 公开 manifest。
 */

export interface InstalledPet {
  slug: string
  displayName: string
  description: string
}

export interface ManifestPet {
  slug: string
  displayName: string
  kind?: string
  submittedBy?: string
  spritesheetUrl: string
  petJsonUrl: string
}

const PETDEX_MANIFEST_URL = 'https://www.petdex.dev/api/manifest'
// 与 petdex CLI 一致：只信任官方资源域，防止 manifest 被塞入恶意 URL
const TRUSTED_ASSET_HOSTS = new Set(['assets.petdex.dev'])

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

const SPRITE_MIME: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
}

let manifestCache: { pets: ManifestPet[]; fetchedAt: number } | null = null
const MANIFEST_TTL_MS = 10 * 60 * 1000

function petsDir(): string {
  return path.join(app.getPath('userData'), 'pets')
}

function isValidSlug(slug: string): boolean {
  return typeof slug === 'string' && SLUG_RE.test(slug)
}

function isTrustedAssetUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && TRUSTED_ASSET_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

function findSpriteFile(dir: string): string | null {
  for (const name of ['spritesheet.webp', 'spritesheet.png']) {
    const file = path.join(dir, name)
    if (fs.existsSync(file)) return file
  }
  return null
}

export function listInstalledPets(): InstalledPet[] {
  const dir = petsDir()
  if (!fs.existsSync(dir)) return []
  const pets: InstalledPet[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidSlug(entry.name)) continue
    const petDir = path.join(dir, entry.name)
    if (!findSpriteFile(petDir)) continue
    let displayName = entry.name
    let description = ''
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(petDir, 'pet.json'), 'utf8'))
      if (typeof meta?.displayName === 'string' && meta.displayName.trim()) displayName = meta.displayName.trim()
      if (typeof meta?.description === 'string') description = meta.description
    } catch {
      // pet.json 缺失或损坏时按目录名兜底，仍可展示
    }
    pets.push({ slug: entry.name, displayName, description })
  }
  return pets
}

export function getPetSpriteDataUrl(slug: string): string | null {
  if (!isValidSlug(slug)) return null
  const file = findSpriteFile(path.join(petsDir(), slug))
  if (!file) return null
  const mime = SPRITE_MIME[path.extname(file).toLowerCase()] ?? 'image/webp'
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
}

export async function fetchPetManifest(force = false): Promise<ManifestPet[]> {
  if (!force && manifestCache && Date.now() - manifestCache.fetchedAt < MANIFEST_TTL_MS) {
    return manifestCache.pets
  }
  const res = await fetch(PETDEX_MANIFEST_URL, { headers: { Referer: 'https://www.petdex.dev' } })
  if (!res.ok) throw new Error(`petdex manifest 请求失败：${res.status}`)
  const data = (await res.json()) as { pets?: ManifestPet[] }
  const pets = (data.pets ?? []).filter(
    (pet) => isValidSlug(pet.slug) && isTrustedAssetUrl(pet.spritesheetUrl) && isTrustedAssetUrl(pet.petJsonUrl)
  )
  manifestCache = { pets, fetchedAt: Date.now() }
  return pets
}

export async function installPet(slug: string): Promise<InstalledPet> {
  if (!isValidSlug(slug)) throw new Error('无效的宠物 slug')
  const manifest = await fetchPetManifest()
  const pet = manifest.find((item) => item.slug === slug)
  if (!pet) throw new Error(`petdex 宠物库里找不到 ${slug}`)

  const download = async (url: string): Promise<Buffer> => {
    const res = await fetch(url, { headers: { Referer: 'https://www.petdex.dev' } })
    if (!res.ok) throw new Error(`下载失败 ${url} -> ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  const [petJson, spritesheet] = await Promise.all([
    download(pet.petJsonUrl),
    download(pet.spritesheetUrl),
  ])

  const dir = path.join(petsDir(), slug)
  fs.mkdirSync(dir, { recursive: true })
  const ext = pet.spritesheetUrl.endsWith('.png') ? 'png' : 'webp'
  fs.writeFileSync(path.join(dir, 'pet.json'), petJson)
  fs.writeFileSync(path.join(dir, `spritesheet.${ext}`), spritesheet)

  let displayName = pet.displayName || slug
  let description = ''
  try {
    const meta = JSON.parse(petJson.toString('utf8'))
    if (typeof meta?.displayName === 'string' && meta.displayName.trim()) displayName = meta.displayName.trim()
    if (typeof meta?.description === 'string') description = meta.description
  } catch {
    // 元数据解析失败不阻塞安装
  }
  return { slug, displayName, description }
}

export function removePet(slug: string): void {
  if (!isValidSlug(slug)) throw new Error('无效的宠物 slug')
  const dir = path.join(petsDir(), slug)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
}
