import { useEffect, useMemo, useState } from 'react'
import { Button as HeroButton, ScrollShadow, Switch, toast } from '@heroui/react'
import { Check, Download, Loader2, Monitor, Search, Trash2 } from 'lucide-react'
import { cn } from '../lib/utils'
import { PetSprite } from '../features/pets/PetSprite'

type InstalledPet = { slug: string; displayName: string; description: string; spriteUrl: string }
type OnlinePet = { slug: string; displayName: string; submittedBy?: string; spritesheetUrl: string }

const ONLINE_PAGE_SIZE = 30

/**
 * AI 宠物页：管理已安装宠物 + 浏览/安装 petdex 在线画廊（petdex.dev，约 3000 只开源宠物）。
 * 选中的宠物展示在 AI 回复左下角、回复中指示器和桌面桌宠窗口。
 */
export default function PetsPage() {
  const [installed, setInstalled] = useState<InstalledPet[]>([])
  const [currentSlug, setCurrentSlug] = useState('')
  const [desktopEnabled, setDesktopEnabled] = useState(false)
  const [online, setOnline] = useState<OnlinePet[] | null>(null)
  const [onlineError, setOnlineError] = useState('')
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(ONLINE_PAGE_SIZE)
  const [installingSlug, setInstallingSlug] = useState('')

  const loadInstalled = async () => {
    const res = await window.electronAPI.pet.listInstalled()
    if (!res.success || !res.pets) return
    const pets = await Promise.all(res.pets.map(async (pet) => {
      const sprite = await window.electronAPI.pet.getSprite(pet.slug)
      return sprite.success && sprite.dataUrl ? { ...pet, spriteUrl: sprite.dataUrl } : null
    }))
    setInstalled(pets.filter((pet): pet is InstalledPet => pet !== null))
  }

  useEffect(() => {
    void loadInstalled()
    void window.electronAPI.config.get('petCurrent').then((value) => setCurrentSlug((value as string) || ''))
    void window.electronAPI.config.get('petDesktopEnabled').then((value) => setDesktopEnabled(Boolean(value)))
    window.electronAPI.pet.manifest()
      .then((res) => {
        if (res.success && res.pets) setOnline(res.pets)
        else setOnlineError(res.error || '在线宠物库加载失败')
      })
      .catch((error) => setOnlineError(String(error)))
  }, [])

  const filteredOnline = useMemo(() => {
    if (!online) return []
    const installedSlugs = new Set(installed.map((pet) => pet.slug))
    const keyword = query.trim().toLowerCase()
    return online.filter((pet) => {
      if (installedSlugs.has(pet.slug)) return false
      if (!keyword) return true
      return pet.slug.includes(keyword) || pet.displayName.toLowerCase().includes(keyword)
    })
  }, [online, installed, query])

  const selectPet = async (slug: string) => {
    await window.electronAPI.config.set('petCurrent', slug)
    setCurrentSlug(slug)
  }

  const removePet = async (slug: string) => {
    await window.electronAPI.pet.remove(slug)
    if (currentSlug === slug) setCurrentSlug('')
    void loadInstalled()
  }

  const installPet = async (slug: string) => {
    setInstallingSlug(slug)
    try {
      const res = await window.electronAPI.pet.install(slug)
      if (res.success) {
        await loadInstalled()
        if (!currentSlug) await selectPet(slug)
        toast.success(`已领养 ${res.pet?.displayName || slug}`)
      } else {
        toast.danger(res.error || '安装失败')
      }
    } finally {
      setInstallingSlug('')
    }
  }

  const toggleDesktop = async (enabled: boolean) => {
    setDesktopEnabled(enabled)
    await window.electronAPI.pet.toggleDesktopWindow(enabled)
  }

  return (
    <ScrollShadow hideScrollBar className="h-full min-h-0 pb-3" size={56}>
      <div className="flex flex-col gap-4">
        {/* Header */}
        <div className="flex flex-col justify-between gap-2 md:flex-row md:items-center">
          <div className="max-w-xl">
            <h1 className="font-bold text-[26px] text-foreground md:text-[30px]">AI 宠物</h1>
            <p className="mt-1 text-muted text-sm leading-relaxed">
              挑一只像素小伙伴：AI 回复时陪跑，回复完成后驻守在消息左下角，还能放出来当桌面桌宠。
              宠物来自开源画廊 petdex.dev，与 Codex Pets 同一格式。
            </p>
          </div>
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-foreground text-sm">
            <Monitor className="size-4 text-muted" />
            桌面桌宠
            <Switch aria-label="桌面悬浮桌宠" isSelected={desktopEnabled} onChange={(selected) => void toggleDesktop(Boolean(selected))}>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch>
          </label>
        </div>

        {/* 已安装 */}
        <section>
          <h2 className="mb-2 font-semibold text-foreground text-sm">已安装</h2>
          {installed.length === 0 ? (
            <p className="rounded-2xl border border-border border-dashed px-4 py-8 text-center text-muted text-sm">
              还没有宠物，从下方在线宠物库挑一只吧
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8">
              {installed.map((pet) => {
                const selected = pet.slug === currentSlug
                return (
                  <button
                    className={cn(
                      'group relative flex flex-col items-center gap-1.5 rounded-2xl border p-3 transition-colors',
                      selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-surface-tertiary'
                    )}
                    key={pet.slug}
                    onClick={() => void selectPet(selected ? '' : pet.slug)}
                    title={selected ? '点击取消展示' : pet.description || pet.displayName}
                    type="button"
                  >
                    <PetSprite scale={0.4} src={pet.spriteUrl} state={selected ? 'waving' : 'idle'} />
                    <span className="w-full truncate text-center text-foreground text-xs">{pet.displayName}</span>
                    {selected && (
                      <span className="absolute top-1.5 left-1.5 rounded-full bg-primary p-0.5 text-primary-foreground">
                        <Check className="size-3" />
                      </span>
                    )}
                    <span
                      className="absolute top-1.5 right-1.5 rounded-full p-1 text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                      onClick={(event) => {
                        event.stopPropagation()
                        void removePet(pet.slug)
                      }}
                      role="button"
                      title="删除宠物"
                    >
                      <Trash2 className="size-3.5" />
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        {/* 在线宠物库 */}
        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-foreground text-sm">
              在线宠物库（petdex.dev{online ? ` · ${filteredOnline.length} 只` : ''}）
            </h2>
            <div className="relative">
              <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted" />
              <input
                className="h-9 w-60 rounded-full border border-border bg-surface pr-3 pl-8 text-foreground text-sm outline-none placeholder:text-muted focus:border-primary"
                onChange={(event) => {
                  setQuery(event.target.value)
                  setVisibleCount(ONLINE_PAGE_SIZE)
                }}
                placeholder="搜索宠物…"
                value={query}
              />
            </div>
          </div>
          {!online && !onlineError && (
            <p className="flex items-center gap-2 px-1 py-6 text-muted text-sm">
              <Loader2 className="size-4 animate-spin" />
              正在加载在线宠物库…
            </p>
          )}
          {onlineError && (
            <p className="rounded-2xl border border-danger/30 bg-danger/5 px-4 py-3 text-danger text-sm">
              {onlineError}
            </p>
          )}
          {online && (
            <>
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8">
                {filteredOnline.slice(0, visibleCount).map((pet) => (
                  <div
                    className="flex flex-col items-center gap-1.5 rounded-2xl border border-border p-3"
                    key={pet.slug}
                    title={pet.submittedBy ? `by ${pet.submittedBy}` : pet.displayName}
                  >
                    <PetSprite scale={0.4} src={pet.spritesheetUrl} state="idle" />
                    <span className="w-full truncate text-center text-foreground text-xs">{pet.displayName}</span>
                    <HeroButton
                      className="h-7 w-full min-w-0 rounded-full text-xs"
                      isDisabled={installingSlug !== ''}
                      onPress={() => void installPet(pet.slug)}
                      size="sm"
                      variant="secondary"
                    >
                      {installingSlug === pet.slug
                        ? <Loader2 className="size-3 animate-spin" />
                        : <Download className="size-3" />}
                      领养
                    </HeroButton>
                  </div>
                ))}
              </div>
              {filteredOnline.length > visibleCount && (
                <div className="mt-3 flex justify-center">
                  <HeroButton className="rounded-full" onPress={() => setVisibleCount((count) => count + ONLINE_PAGE_SIZE)} size="sm" variant="tertiary">
                    加载更多（还有 {filteredOnline.length - visibleCount} 只）
                  </HeroButton>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </ScrollShadow>
  )
}
