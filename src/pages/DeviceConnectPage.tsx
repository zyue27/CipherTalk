import type { ReactElement } from 'react'
import { Button, Chip, toast } from '@heroui/react'
import { MessageCircle, MessagesSquare, Send } from 'lucide-react'

type Platform = {
  key: string
  name: string
  desc: string
  icon: ReactElement
  gradient: string
  available: boolean
}

const ICON_SIZE = 28

const PLATFORMS: Platform[] = [
  {
    key: 'wechat',
    name: '微信',
    desc: '扫码连接，让 AI 助手直接在微信收发消息',
    icon: <MessageCircle size={ICON_SIZE} />,
    gradient: 'linear-gradient(135deg, #1AAD5A 0%, #07C160 100%)',
    available: true,
  },
  {
    key: 'feishu',
    name: '飞书',
    desc: '敬请期待',
    icon: <MessagesSquare size={ICON_SIZE} />,
    gradient: 'linear-gradient(135deg, #3370FF 0%, #00D6B9 100%)',
    available: false,
  },
  {
    key: 'telegram',
    name: 'Telegram',
    desc: '敬请期待',
    icon: <Send size={ICON_SIZE} />,
    gradient: 'linear-gradient(135deg, #2AABEE 0%, #229ED9 100%)',
    available: false,
  },
]

function PlatformCard({ platform }: { platform: Platform }) {
  const handleConnect = () => {
    // TODO: 接入微信 iLink 客户端（扫码登录 → 长轮询收消息 → 过 Agent → 回发）
    toast.info('微信接入开发中，敬请期待')
  }

  return (
    <div
      className="flex flex-col gap-4 rounded-2xl border border-(--border-color) bg-surface-secondary p-5 backdrop-blur-[18px] transition-shadow hover:shadow-lg"
    >
      <div className="flex items-center gap-3">
        <div
          className="flex size-12 shrink-0 items-center justify-center rounded-xl text-white"
          style={{ background: platform.gradient }}
        >
          {platform.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-base font-semibold text-foreground">{platform.name}</span>
            {platform.available ? (
              <Chip size="sm" variant="soft" color="success">可接入</Chip>
            ) : (
              <Chip size="sm" variant="soft">敬请期待</Chip>
            )}
          </div>
          <p className="mt-1 truncate text-sm text-muted">{platform.desc}</p>
        </div>
      </div>

      {platform.available ? (
        <Button variant="primary" fullWidth onPress={handleConnect}>连接微信</Button>
      ) : (
        <Button variant="ghost" fullWidth isDisabled>敬请期待</Button>
      )}
    </div>
  )
}

function DeviceConnectPage() {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-foreground">设备连接</h1>
        <p className="mt-1 text-sm text-muted">把 AI 助手接入聊天平台，直接在对话里收发消息</p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PLATFORMS.map(platform => (
          <PlatformCard key={platform.key} platform={platform} />
        ))}
      </div>
    </div>
  )
}

export default DeviceConnectPage
