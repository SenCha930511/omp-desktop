// @vitest-environment jsdom

import './jsdom-storage'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AboutSettings } from '../../src/pages/settings/AboutSettings'
import type { AppUpdateState } from '../../src/types/api'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const noop = () => undefined

async function renderAbout(updateState: AppUpdateState | null, onUpdateAction = vi.fn()) {
  await act(async () => {
    root.render(<AboutSettings updateState={updateState} onUpdateAction={onUpdateAction} onOpenDocs={noop} />)
  })
  return onUpdateAction
}

function updateRow(): { status: string; button: HTMLButtonElement | null } | null {
  const rows = [...container.querySelectorAll('.settings-row')]
  for (const row of rows) {
    if (row.querySelector('strong')?.textContent === 'Software updates') {
      return {
        status: row.querySelector('small')?.textContent ?? '',
        button: row.querySelector('button'),
      }
    }
  }
  return null
}

async function pressButton(label: string) {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim().startsWith(label))
  expect(button).toBeDefined()
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('about settings update row', () => {
  it('shows nothing when the update service is unavailable in this context (no bridge)', async () => {
    await renderAbout(null)
    expect(container.querySelectorAll('.settings-group')).toHaveLength(1)
    expect(updateRow()).toBeNull()
  })

  it('offers an immediate manual check from the idle state', async () => {
    const onUpdateAction = await renderAbout({ phase: 'idle' })
    const row = updateRow()
    expect(row?.status).toBe('Check for a new OMP Desktop release')
    expect(row?.button?.disabled).toBe(false)
    await pressButton('Release updates')
    expect(onUpdateAction).toHaveBeenCalledTimes(1)
  })

  it('confirms the current version is latest right after a manual check finds nothing', async () => {
    const onUpdateAction = await renderAbout({ phase: 'not-available', version: '1.1.30' })
    const row = updateRow()
    expect(row?.status).toBe('Check again for a new OMP Desktop release')
    await pressButton('OMP Desktop is up to date')
    expect(onUpdateAction).toHaveBeenCalledTimes(1)
  })

  it('disables the control while a check or download is already in progress', async () => {
    for (const state of [{ phase: 'checking' }, { phase: 'downloading', percent: 42, version: '1.1.30' }] as AppUpdateState[]) {
      const onUpdateAction = await renderAbout(state)
      const row = updateRow()
      expect(row?.button?.disabled).toBe(true)
      expect(onUpdateAction).not.toHaveBeenCalled()
      await act(async () => root.unmount())
      root = createRoot(container)
    }
  })

  it('asks before downloading a discovered update', async () => {
    const onUpdateAction = await renderAbout({ phase: 'available', version: '1.1.30' })
    const row = updateRow()
    expect(row?.status).toBe('Download and restart OMP Desktop 1.1.30')

    await pressButton('Download 1.1.30')
    expect(onUpdateAction).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Download and Restart OMP Desktop?')

    const yes = [...document.body.querySelectorAll<HTMLButtonElement>('.modal__footer button')].find((candidate) => candidate.textContent === 'Yes')
    expect(yes).toBeDefined()
    await act(async () => {
      yes!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      yes!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onUpdateAction).toHaveBeenCalledTimes(1)
  })

  it('asks only about restarting once the update is downloaded, then retries on error without redundant confirms', async () => {
    const onUpdateAction = await renderAbout({ phase: 'downloaded', version: '1.1.30' })
    await pressButton('Restart for 1.1.30')
    expect(document.body.textContent).toContain('Restart OMP Desktop to install the update?')
    expect(document.body.textContent).not.toContain('Download and Restart OMP Desktop?')
    const no = [...document.body.querySelectorAll<HTMLButtonElement>('.modal__footer button')].find((candidate) => candidate.textContent === 'No')
    expect(no).toBeDefined()
    await act(async () => {
      no!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      no!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onUpdateAction).not.toHaveBeenCalled()

    await act(async () => root.unmount())
    root = createRoot(container)
    const retryAction = await renderAbout({ phase: 'error', message: 'network glitch' })
    const row = updateRow()
    expect(row?.status).toBe('network glitch')
    await pressButton('Retry update')
    expect(retryAction).toHaveBeenCalledTimes(1)
  })

  it('keeps the manual check control clickable on builds where automatic updates are unsupported', async () => {
    const onUpdateAction = await renderAbout({ phase: 'unsupported', message: 'Automatic updates are available in installed builds.' })
    const row = updateRow()
    expect(row?.status).toBe('Automatic updates are available in installed builds.')
    expect(row?.button?.disabled).toBe(false)
    await pressButton('Automatic updates')
    expect(onUpdateAction).toHaveBeenCalledTimes(1)
  })

  it('checks GitHub for a newer release on unsigned builds and then opens the download page', async () => {
    const onUpdateAction = vi.fn()
    const onCheckLatestRelease = vi.fn(async () => ({
      currentVersion: '1.2.0',
      latestVersion: '1.3.0',
      newer: true,
      url: 'https://github.com/SenCha930511/omp-desktop/releases/tag/v1.3.0',
    }))
    const onOpenExternal = vi.fn()
    await act(async () => {
      root.render(<AboutSettings
        updateState={{ phase: 'unsupported', message: 'Automatic updates need a Developer ID signed build.' }}
        onUpdateAction={onUpdateAction}
        onCheckLatestRelease={onCheckLatestRelease}
        onOpenExternal={onOpenExternal}
        onOpenDocs={noop}
      />)
    })

    await pressButton('Automatic updates')
    expect(onCheckLatestRelease).toHaveBeenCalledTimes(1)
    expect(onUpdateAction).not.toHaveBeenCalled()
    expect(updateRow()?.button?.textContent).toContain('Open download page')
    expect(container.textContent).toContain('A newer release 1.3.0 is available on GitHub')

    await pressButton('Open download page')
    expect(onOpenExternal).toHaveBeenCalledWith('https://github.com/SenCha930511/omp-desktop/releases/tag/v1.3.0')
    expect(onCheckLatestRelease).toHaveBeenCalledTimes(1)
    expect(onUpdateAction).not.toHaveBeenCalled()
  })

  it('confirms against GitHub when the unsigned build already runs the latest release', async () => {
    const onUpdateAction = vi.fn()
    const onCheckLatestRelease = vi.fn(async () => ({
      currentVersion: '1.3.0',
      latestVersion: '1.3.0',
      newer: false,
      url: 'https://github.com/SenCha930511/omp-desktop/releases/tag/v1.3.0',
    }))
    await act(async () => {
      root.render(<AboutSettings
        updateState={{ phase: 'unsupported' }}
        onUpdateAction={onUpdateAction}
        onCheckLatestRelease={onCheckLatestRelease}
        onOpenDocs={noop}
      />)
    })

    await pressButton('Automatic updates')
    expect(onCheckLatestRelease).toHaveBeenCalledTimes(1)
    expect(onUpdateAction).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Checked GitHub: 1.3.0 is the latest release.')
    expect(updateRow()?.button?.textContent).not.toContain('Open download page')
  })

  it('reports inline when the GitHub latest-release check fails', async () => {
    const onUpdateAction = vi.fn()
    const onCheckLatestRelease = vi.fn(async () => { throw new Error('offline') })
    await act(async () => {
      root.render(<AboutSettings
        updateState={{ phase: 'unsupported' }}
        onUpdateAction={onUpdateAction}
        onCheckLatestRelease={onCheckLatestRelease}
        onOpenDocs={noop}
      />)
    })

    await pressButton('Automatic updates')
    expect(onCheckLatestRelease).toHaveBeenCalledTimes(1)
    expect(onUpdateAction).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Could not check GitHub for a newer release. Try again later.')
    expect(updateRow()?.button?.disabled).toBe(false)
  })
})
