import { MessagesSquare } from 'lucide-react'
import { SessionSettingsPanel } from '@/components/SessionSettingsPanel'
import type { SessionSettingsApi } from '@/hooks/useSessionSettings'
import { useI18n } from '@/lib/i18n'

/**
 * 「工作階段」設定區段:六項 session 範圍設定(自動壓縮/自動重試/訊息送達/
 * 中斷模式/快取預熱)自 context popover 遷入。值仍由 runtime 快照驅動
 * (get_state / set_* 回聲,RPC 為真相),因此僅在作用中工作階段存在時可用;
 * 無 runtime 時顯示提示而非空白表單。
 */
export function SessionSettings({ sessionSettings }: { sessionSettings?: SessionSettingsApi }) {
  const { t } = useI18n()
  return (
    <>
      <header>
        <h1><MessagesSquare size={18} aria-hidden="true" />{t('sessionSettings.page.title')}</h1>
        <p>{t('sessionSettings.page.description')}</p>
      </header>
      {sessionSettings ? (
        <SessionSettingsPanel controller={sessionSettings} />
      ) : (
        <section className="settings-group">
          <p>{t('sessionSettings.needsRuntime')}</p>
        </section>
      )}
    </>
  )
}
