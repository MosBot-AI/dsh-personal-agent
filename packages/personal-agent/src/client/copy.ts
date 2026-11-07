import en from '../../locale/en-US.json' with { type: 'json' }
import zh from '../../locale/zh-CN.json' with { type: 'json' }

export const namespace = 'dshpa.inbox'
export type MessageKey = keyof typeof en
export type Translate = (key: MessageKey) => string

export const dictionaries: Record<'en' | 'zh', Record<MessageKey, string>> = { en, zh }

export function formatTime(value: string, t: Translate): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return t('connection.unknown')
  return new Intl.DateTimeFormat(t('locale'), { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
