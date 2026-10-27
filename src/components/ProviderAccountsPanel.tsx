import { KeyRound, LogIn, LogOut, RefreshCw, ShieldCheck, UserCheck } from 'lucide-react'
import { useState } from 'react'
import { useI18n, type MessageKey } from '@/lib/i18n'
import type { LoginProvider, LogoutAccount } from '@/lib/provider-accounts'
import type { ProviderAccountError } from '@/hooks/useProviderAccounts'
import './provider-accounts.css'

export interface ProviderAccountsPanelProps {
  /** 有 bridge 且有活躍 runtime 時才可送出 login/logout RPC。 */
  usable: boolean
  providers: LoginProvider[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: ProviderAccountError | null
  loginInFlight: { providerId: string; startedAt: number; deadlineAt: number } | null
  noticeKey: MessageKey | null
  noticeValues: Record<string, string | number> | undefined
  accountsByProvider: Record<string, LogoutAccount[]>
  accountsLoadingProvider: string | null
  onRefresh(): void
  onLogin(providerId: string): void
  onCancelLogin(): void
  onLoadAccounts(providerId: string): void
  onLogout(providerId: string, credentialId: number): void
}

function errorText(error: ProviderAccountError, t: ReturnType<typeof useI18n>['t']): string {
  if (error.kind === 'invalid-data') return t('plugins.providerAccountsInvalidData')
  if (error.kind === 'timeout') return t('plugins.providerLoginTimeout')
  return error.message
}

function accountConfirmId(account: LogoutAccount): string {
  return `${account.provider}:${account.credentialId}`
}

/**
 * Provider OAuth 帳號面板(對應 TUI /login /logout)。
 * GUI 只是驅動殼:登入流程由既有 extension_ui 的 open_url(瀏覽器)與
 * input dialog(授權碼)接管,面板只呈現進行中狀態並提供取消;憑證全程
 * 由 OMP custody(~/.omp auth storage),面板資料都已經過白名單解析。
 */
export function ProviderAccountsPanel({
  usable,
  providers,
  status,
  error,
  loginInFlight,
  noticeKey,
  noticeValues,
  accountsByProvider,
  accountsLoadingProvider,
  onRefresh,
  onLogin,
  onCancelLogin,
  onLoadAccounts,
  onLogout,
}: ProviderAccountsPanelProps) {
  const { t } = useI18n()
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)
  const [confirmLogout, setConfirmLogout] = useState<string | null>(null)

  const toggleAccounts = (provider: LoginProvider) => {
    if (expandedProvider === provider.id) { setExpandedProvider(null); return }
    setExpandedProvider(provider.id)
    onLoadAccounts(provider.id)
  }

  return (
    <section className="provider-accounts" aria-labelledby="provider-accounts-heading">
      <div className="directory-heading provider-accounts__heading">
        <h2 id="provider-accounts-heading">{t('plugins.providerAccountsTitle')}</h2>
        {usable ? (
          <button type="button" className="button button--quiet" onClick={onRefresh} aria-label={t('plugins.providerAccountsRefresh')}>
            <RefreshCw size={13} className={status === 'loading' ? 'spin' : ''} />
          </button>
        ) : null}
      </div>
      <p className="provider-accounts__note">
        <ShieldCheck size={13} /> {t('plugins.providerCustodyNote')}
      </p>
      {!usable ? (
        <p className="provider-accounts__hint">{t('plugins.providerAccountsNeedsSession')}</p>
      ) : (
        <>
          {error ? (
            <p className="page-inline-error" role="alert">{errorText(error, t)}</p>
          ) : null}
          {noticeKey ? <p className="provider-accounts__notice" role="status">{t(noticeKey, noticeValues)}</p> : null}
          {status === 'idle' || (status === 'loading' && providers.length === 0) ? (
            <p className="provider-accounts__hint">{t('plugins.providerAccountsLoading')}</p>
          ) : status === 'error' && providers.length === 0 ? (
            <p className="provider-accounts__hint">{t('plugins.providerAccountsUnavailable')}</p>
          ) : (
            <div className="provider-accounts__list">
              {providers.length === 0 ? <p className="provider-accounts__hint">{t('plugins.providerAccountsEmpty')}</p> : null}
              {providers.map((provider) => {
                const loggingIn = loginInFlight?.providerId === provider.id
                const expanded = expandedProvider === provider.id
                const accounts = accountsByProvider[provider.id]
                return (
                  <article key={provider.id} className="provider-accounts__item">
                    <div className="provider-accounts__row">
                      <span className={`directory-icon ${provider.authenticated ? 'directory-icon--package' : 'directory-icon--prompt'}`}>
                        {provider.authenticated ? <UserCheck size={16} /> : <KeyRound size={16} />}
                      </span>
                      <div className="provider-accounts__summary">
                        <div>
                          <h3>{provider.name}</h3>
                          <span className={`provider-accounts__badge${provider.authenticated ? ' provider-accounts__badge--authenticated' : ''}`}>
                            {provider.authenticated
                              ? t('plugins.providerAuthenticated')
                              : provider.available
                                ? t('plugins.providerNotAuthenticated')
                                : t('plugins.providerUnavailable')}
                          </span>
                        </div>
                        <p>{provider.id}</p>
                      </div>
                      <div className="provider-accounts__actions">
                        {loggingIn ? (
                          <>
                            <span className="provider-accounts__progress" role="status">
                              <RefreshCw className="spin" size={13} /> {t('plugins.providerLoginInFlight')}
                            </span>
                            <button type="button" className="button button--quiet" onClick={onCancelLogin}>
                              {t('plugins.providerLoginCancel')}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="button"
                            disabled={!provider.available || loginInFlight !== null}
                            title={!provider.available ? t('plugins.providerUnavailableHint') : undefined}
                            onClick={() => onLogin(provider.id)}
                          >
                            <LogIn size={13} /> {t('plugins.providerLogin')}
                          </button>
                        )}
                        <button type="button" className="button button--quiet" onClick={() => toggleAccounts(provider)}>
                          {expanded ? t('plugins.providerHideAccounts') : t('plugins.providerManageAccounts')}
                        </button>
                      </div>
                    </div>
                    {expanded ? (
                      <div className="provider-accounts__accounts">
                        {accountsLoadingProvider === provider.id ? (
                          <p className="provider-accounts__hint">
                            <RefreshCw className="spin" size={13} /> {t('plugins.providerAccountsLoading')}
                          </p>
                        ) : !accounts || accounts.length === 0 ? (
                          <p className="provider-accounts__hint">{t('plugins.providerNoAccounts')}</p>
                        ) : (
                          accounts.map((account) => {
                            const confirming = confirmLogout === accountConfirmId(account)
                            return (
                              <div key={accountConfirmId(account)} className="provider-accounts__account">
                                <div className="provider-accounts__accountSummary">
                                  <strong>{account.label || t('plugins.providerAccountFallback', { id: account.credentialId })}</strong>
                                  <span>
                                    {t(account.type === 'oauth' ? 'plugins.providerAccountOauth' : 'plugins.providerAccountApiKey')}
                                    {account.active ? ` · ${t('plugins.providerAccountActive')}` : ''}
                                  </span>
                                  {account.detail ? <small>{account.detail}</small> : null}
                                </div>
                                {confirming ? (
                                  <>
                                    <button
                                      type="button"
                                      className="button button--danger-quiet"
                                      onClick={() => { setConfirmLogout(null); onLogout(provider.id, account.credentialId) }}
                                    >
                                      <LogOut size={13} /> {t('plugins.providerLogoutConfirm')}
                                    </button>
                                    <button type="button" className="button button--quiet" onClick={() => setConfirmLogout(null)}>
                                      {t('plugins.providerLogoutDismiss')}
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    className="button button--quiet"
                                    aria-label={t('plugins.providerLogoutNamed', { name: account.label || String(account.credentialId) })}
                                    onClick={() => setConfirmLogout(accountConfirmId(account))}
                                  >
                                    <LogOut size={13} /> {t('plugins.providerLogout')}
                                  </button>
                                )}
                              </div>
                            )
                          })
                        )}
                      </div>
                    ) : null}
                  </article>
                )
              })}
            </div>
          )}
        </>
      )}
    </section>
  )
}
