import { AlertTriangle } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import type { RuntimeInfo } from '@/types/api'

export interface ExecutingModelChipProps {
  executingModel: RuntimeInfo['executingModel']
}

export function ExecutingModelChip({ executingModel }: ExecutingModelChipProps) {
  const { t } = useI18n()
  if (!executingModel?.isFallback) return null
  return (
    <span className="model-fallback-chip" role="status" title={t('executingModel.title', { model: executingModel.label })}>
      <AlertTriangle size={12} /> {t('executingModel.runningOn', { model: executingModel.label })}
    </span>
  )
}
