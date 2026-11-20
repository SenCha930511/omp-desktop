// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { CHAT_MIN, clampPanelSizes, INSPECTOR_MAX, INSPECTOR_MIN, SIDEBAR_MAX, SIDEBAR_MIN, TERMINAL_MIN, TOOLBAR_HEIGHT, WORKSPACE_ROW_MIN } from '../../src/hooks/usePanelLayout'

const wideViewport = { width: 1600, height: 1000 }

const sizes = (patch: Partial<Record<'sidebarWidth' | 'inspectorWidth' | 'sideChatWidth' | 'terminalHeight', number>> = {}) => ({
  sidebarWidth: 248,
  inspectorWidth: 520,
  sideChatWidth: 420,
  terminalHeight: 310,
  ...patch,
})

describe('clampPanelSizes', () => {
  it('preserves sizes that already fit the viewport', () => {
    expect(clampPanelSizes(sizes(), wideViewport)).toEqual(sizes())
  })

  it('clamps the sidebar to its minimum and maximum', () => {
    expect(clampPanelSizes(sizes({ sidebarWidth: 10 }), wideViewport).sidebarWidth).toBe(SIDEBAR_MIN)
    expect(clampPanelSizes(sizes({ sidebarWidth: 2000 }), wideViewport).sidebarWidth).toBe(SIDEBAR_MAX)
  })

  it('clamps the inspector and side chat to the width left after the sidebar and chat minimum', () => {
    const viewport = { width: 1200, height: 1000 }
    const remaining = viewport.width - 248 - CHAT_MIN
    const clamped = clampPanelSizes(sizes({ inspectorWidth: 900, sideChatWidth: 900 }), viewport)
    expect(clamped.inspectorWidth).toBe(remaining)
    expect(clamped.sideChatWidth).toBe(remaining)
    expect(clamped.inspectorWidth).toBeLessThanOrEqual(INSPECTOR_MAX)
    expect(clampPanelSizes(sizes({ inspectorWidth: 10, sideChatWidth: 10 }), viewport)).toMatchObject({
      inspectorWidth: INSPECTOR_MIN,
      sideChatWidth: INSPECTOR_MIN,
    })
  })

  it('caps the inspector at INSPECTOR_MAX on a wide viewport', () => {
    const clamped = clampPanelSizes(sizes({ inspectorWidth: 900, sideChatWidth: 900 }), wideViewport)
    expect(clamped.inspectorWidth).toBe(INSPECTOR_MAX)
    expect(clamped.sideChatWidth).toBe(INSPECTOR_MAX)
  })

  it('clamps the terminal to the workspace height left after the toolbar and row minimum', () => {
    const viewport = { width: 1600, height: 700 }
    const available = viewport.height - TOOLBAR_HEIGHT - WORKSPACE_ROW_MIN
    expect(clampPanelSizes(sizes({ terminalHeight: 900 }), viewport).terminalHeight).toBe(available)
    expect(clampPanelSizes(sizes({ terminalHeight: 10 }), viewport).terminalHeight).toBe(TERMINAL_MIN)
    // A viewport too short to host the row minimum still yields a usable terminal.
    expect(clampPanelSizes(sizes({ terminalHeight: 900 }), { width: 1600, height: 200 }).terminalHeight).toBe(TERMINAL_MIN)
  })
})
