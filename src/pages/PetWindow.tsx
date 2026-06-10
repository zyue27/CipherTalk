import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useCurrentPetLoader } from '@/features/pets/PetContext'
import { PetSprite } from '@/features/pets/PetSprite'
import { PET_STATES, petStateForAgent, type PetAgentState, type PetStateId } from '@/features/pets/petStates'

/**
 * 桌面悬浮桌宠窗口（透明无边框，跟随 Agent 运行状态切动画）。
 * 整个窗口是拖拽区域，悬停时右上角出现关闭按钮。
 */
export default function PetWindow() {
  const pet = useCurrentPetLoader()
  const [agentState, setAgentState] = useState<PetAgentState>('idle')

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    const root = document.getElementById('root')
    if (root) root.style.background = 'transparent'
  }, [])

  useEffect(() => {
    let doneTimer = 0
    const off = window.electronAPI.pet.onAgentState((state) => {
      window.clearTimeout(doneTimer)
      if (state === 'done') {
        setAgentState('done')
        doneTimer = window.setTimeout(() => setAgentState('idle'), 2600)
        return
      }
      if (state === 'running' || state === 'failed' || state === 'idle') {
        setAgentState(state)
      }
    })
    return () => {
      window.clearTimeout(doneTimer)
      off()
    }
  }, [])

  // 空闲彩蛋（Codex 同款）：待机时每隔 6~14 秒随机来一段小动作，播两圈后回到呼吸待机
  const [flair, setFlair] = useState<PetStateId | null>(null)
  useEffect(() => {
    if (agentState !== 'idle') {
      setFlair(null)
      return
    }
    let flairTimer = 0
    let resetTimer = 0
    const FLAIR_STATES: PetStateId[] = ['waving', 'jumping', 'waiting', 'review']
    const schedule = () => {
      flairTimer = window.setTimeout(() => {
        const next = FLAIR_STATES[Math.floor(Math.random() * FLAIR_STATES.length)]
        setFlair(next)
        resetTimer = window.setTimeout(() => {
          setFlair(null)
          schedule()
        }, PET_STATES[next].durationMs * 2)
      }, 6000 + Math.random() * 8000)
    }
    schedule()
    return () => {
      window.clearTimeout(flairTimer)
      window.clearTimeout(resetTimer)
    }
  }, [agentState])

  const state: PetStateId = agentState === 'idle' && flair ? flair : petStateForAgent(agentState)

  return (
    <div
      className="group flex h-screen w-screen flex-col items-center justify-end overflow-hidden pb-1"
      style={{ WebkitAppRegion: 'drag', background: 'transparent' } as React.CSSProperties}
    >
      <button
        aria-label="收起桌宠"
        className="absolute top-1 right-1 rounded-full bg-black/30 p-1 text-white/80 opacity-0 transition-opacity hover:bg-black/50 group-hover:opacity-100"
        onClick={() => void window.electronAPI.pet.toggleDesktopWindow(false)}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        type="button"
      >
        <X className="size-3.5" />
      </button>
      {pet ? (
        <>
          <PetSprite label={pet.displayName} scale={0.62} src={pet.spriteUrl} state={state} />
          <span className="mt-0.5 rounded-full bg-black/30 px-2 py-0.5 text-[10px] text-white/90 opacity-0 transition-opacity group-hover:opacity-100">
            {pet.displayName}
          </span>
        </>
      ) : (
        <span className="rounded-(--agent-radius,12px) bg-black/40 px-3 py-2 text-center text-white/90 text-xs">
          还没选宠物
          <br />
          去「AI 宠物」页挑一只吧
        </span>
      )}
    </div>
  )
}
