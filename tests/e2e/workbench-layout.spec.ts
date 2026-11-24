import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { launchWorkbenchLayout, LONG_SESSION_TITLE, type WorkbenchLayoutFixture } from './workbench-layout.fixture'

const evidenceDirectory = '.audit/resume-ui-implementation'
const hudReserveEvidenceDirectory = '.audit/hud-reserve-repair'

async function submitLayoutRun(page: Page, withHud: boolean): Promise<void> {
  const composer = page.getByRole('combobox', { name: 'Message OMP' })
  await composer.fill(`workbench layout ${withHud ? 'with hud' : 'without hud'}`)
  await composer.press('Enter')
  await expect(page.locator('.work-disclosure.is-running')).toBeVisible()
  await expect(page.locator('.activity-tool__summary')).toHaveCount(withHud ? 19 : 18)
  await page.mouse.move(2, 2)
}

async function expectOrdinaryRowAlignment(row: Locator): Promise<void> {
  const metadata = row.locator('.session-row__time, .session-row__spinner')
  await expect(metadata.first()).toHaveCSS('opacity', '1')
  await expect.poll(async () => {
    const rowBox = await row.boundingBox()
    const metaBox = await row.locator('.session-row__meta').boundingBox()
    if (!rowBox || !metaBox) return Number.POSITIVE_INFINITY
    return Math.abs(rowBox.x + rowBox.width - metaBox.x - metaBox.width - 8)
  }).toBeLessThanOrEqual(2)
  expect(await row.locator('.session-row__title').evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
  await expect(row.locator('.session-row__pin')).toBeVisible()
}

async function expectControlsClearMetadata(row: Locator): Promise<void> {
  const time = row.locator('.session-row__time')
  const spinner = row.locator('.session-row__spinner')
  for (const element of [time, spinner]) if (await element.count()) await expect(element).toHaveCSS('opacity', '0')
  await expect(row.locator('.session-row__archive')).toHaveCSS('opacity', '1')
  await expect(row.locator('.session-row__more')).toHaveCSS('opacity', '1')
  await expect.poll(async () => row.evaluate((element) => {
    const metadata = element.querySelector('.session-row__meta')
    const actions = [...element.querySelectorAll('.session-row__archive, .session-row__more')]
    if (!metadata) return false
    const metaRect = metadata.getBoundingClientRect()
    return actions.every((action) => metaRect.right <= action.getBoundingClientRect().left + 1)
  })).toBe(true)
}

async function scrollWorkToFraction(page: Page, fraction: number): Promise<void> {
  await page.locator('.conversation-pane .transcript').evaluate((scroller, nextFraction) => {
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * nextFraction
  }, fraction)
}

async function expectOpaqueWorkBoundary(page: Page): Promise<void> {
  await expect(page.locator('.work-disclosure__button')).toHaveCSS('position', 'sticky')
  await expect.poll(async () => page.evaluate(() => {
    const header = document.querySelector('.work-disclosure__button')
    const scroller = document.querySelector('.conversation-pane .transcript')
    const hud = document.querySelector('.transcript-hud')
    if (!header || !scroller) return Number.POSITIVE_INFINITY
    const expectedTop = scroller.getBoundingClientRect().top + (hud ? 48 : 0)
    return Math.abs(expectedTop - header.getBoundingClientRect().top)
  })).toBeLessThanOrEqual(2)
  expect(await page.evaluate(() => {
    const header = document.querySelector('.work-disclosure__button')
    const scroller = document.querySelector('.conversation-pane .transcript')
    if (!header || !scroller) return ['Missing work header or transcript']
    const headerRect = header.getBoundingClientRect()
    const scrollerRect = scroller.getBoundingClientRect()
    const hudRect = document.querySelector('.transcript-hud')?.getBoundingClientRect()
    const exposedTop = scrollerRect.top
    const x = headerRect.left + Math.min(60, headerRect.width / 2)
    const failures: string[] = []
    if (headerRect.top < scrollerRect.top - 2) failures.push('Work header escapes the transcript')
    if (hudRect && headerRect.top < hudRect.top - 2) failures.push('Work header hides inside the todo HUD')
    const activities = [...document.querySelectorAll('.work-timeline .activity-tool__summary, .work-timeline .reasoning-disclosure > summary')]
    for (const activity of activities) {
      const rect = activity.getBoundingClientRect()
      const sampleY = Math.max(rect.top + 1, exposedTop + 1)
      if (sampleY >= Math.min(rect.bottom - 1, headerRect.top - 1)) continue
      const sampleX = Math.max(rect.left + 1, Math.min(rect.right - 1, x))
      const hit = document.elementFromPoint(sampleX, sampleY)
      if (hit && (hit === activity || activity.contains(hit))) failures.push(`Activity is exposed above the work header at y=${sampleY}`)
    }
    const boundaryTop = hudRect ? exposedTop : headerRect.top
    for (let y = boundaryTop + 1; y < headerRect.bottom - 1; y += 6) {
      const hit = document.elementFromPoint(x, y)
      if (hit && !hit.closest('.work-disclosure__button, .transcript-hud')) failures.push(`Work header is not the top boundary at y=${y}; hit=${hit.tagName}.${hit.className}; header=${headerRect.top}-${headerRect.bottom}; hud=${hudRect?.top}-${hudRect?.bottom}`)
    }
    return failures
  })).toEqual([])
}

async function expectExpandedActivityReadable(page: Page): Promise<void> {
  const work = page.locator('.work-disclosure')
  const reasoning = work.locator('.reasoning-disclosure > summary').first()
  await reasoning.click()
  await expect(reasoning).toHaveAttribute('aria-expanded', 'true')
  const reasoningBody = work.locator('.reasoning-disclosure > div').first()
  await expect(reasoningBody).toContainText('Reasoning body marker')
  const tool = work.locator('.activity-tool__summary').filter({ hasText: 'fixture-step-3' })
  await tool.click()
  const output = work.locator('.activity-tool__contents').filter({ hasText: 'Tool output marker 3' })
  await expect(output).toBeVisible()
  for (const content of [reasoningBody, output]) {
    await content.evaluate((element) => element.scrollIntoView({ block: 'center' }))
    await expect(content).toBeInViewport()
  }
}

test('keeps long session metadata right aligned through running, controls, and completion', async ({ testIdAttribute: _testIdAttribute }, testInfo) => {
  let fixture: WorkbenchLayoutFixture | undefined
  try {
    fixture = await launchWorkbenchLayout()
    const { page } = fixture
    mkdirSync(evidenceDirectory, { recursive: true })
    const listedSessions = await page.evaluate(async () => (await window.desktop.sessions.list(undefined, true)).map(({ filePath, pinned, title }) => ({ filePath, pinned, title })))
    expect(listedSessions).toHaveLength(1)
    expect(listedSessions[0]?.pinned).toBe(true)
    const sessionTitle = listedSessions[0]?.title
    if (!sessionTitle) throw new Error('Expected the fixture session title')
    expect(sessionTitle.endsWith('…')).toBe(true)
    expect(LONG_SESSION_TITLE.startsWith(sessionTitle.slice(0, -1))).toBe(true)
    const row = page.locator('.project-group').getByTitle(sessionTitle, { exact: true }).locator('..')
    await expect(row).toBeVisible()
    await expect(row).toHaveClass(/is-selected/)
    await expectOrdinaryRowAlignment(row)

    await row.hover()
    await expectControlsClearMetadata(row)
    await row.locator('.session-row__more').focus()
    await page.mouse.move(2, 2)
    await expectControlsClearMetadata(row)
    await page.locator('.conversation-pane .transcript').click({ position: { x: 8, y: 8 } })
    await expectOrdinaryRowAlignment(row)

    await submitLayoutRun(page, false)
    await expect(row).toHaveClass(/session-row-wrap--running/)
    await expect(row.locator('.session-row__spinner')).toBeVisible()
    await expect(row.locator('.session-row__time')).toHaveCount(0)
    await expectOrdinaryRowAlignment(row)
    await row.hover()
    await expectControlsClearMetadata(row)
    await testInfo.attach('running-hover', { body: await page.screenshot({ path: `${evidenceDirectory}/session-title-running.png` }), contentType: 'image/png' })

    await page.mouse.move(2, 2)
    await expectOrdinaryRowAlignment(row)
    await fixture.finishRun()
    await expect(row).not.toHaveClass(/session-row-wrap--running/)
    await expect(row.locator('.session-row__spinner')).toHaveCount(0)
    await expect(row.locator('.session-row__time')).toHaveCSS('opacity', '1')
    await expectOrdinaryRowAlignment(row)
    await expect(page.locator('.work-disclosure')).toBeVisible()
    await expect(page.locator('.work-disclosure__button')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('Layout fixture complete.', { exact: true })).toBeVisible()
    await testInfo.attach('finished', { body: await page.screenshot({ path: `${evidenceDirectory}/session-title-finished.png` }), contentType: 'image/png' })
  } finally {
    await fixture?.close()
  }
})

test('keeps the side-chat disclaimer below its native composer at the inspector width', async ({ testIdAttribute: _testIdAttribute }, testInfo) => {
  let fixture: WorkbenchLayoutFixture | undefined
  try {
    fixture = await launchWorkbenchLayout({ width: 1440, height: 1100 })
    const { page } = fixture
    mkdirSync(`${evidenceDirectory}/native-side-chat`, { recursive: true })
    await submitLayoutRun(page, false)
    await fixture.finishRun()
    await expect(page.locator('.work-disclosure')).toBeVisible()

    const composerInput = page.getByRole('combobox', { name: 'Message OMP' })
    await composerInput.fill('/btw')
    await composerInput.press('Enter')
    await expect(page.getByRole('tab', { name: 'Side questions' })).toHaveAttribute('aria-selected', 'true')
    const panel = page.locator('.side-chat')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('Ask a side question')
    const composer = panel.locator('form.side-chat__composer')
    await expect(composer).toBeVisible()
    const note = panel.locator(':scope > p.composer-note.side-chat__note')
    await expect(note).toHaveCount(1)
    await expect(note).toHaveText('OMP can make mistakes. Review commands and changes before committing.')
    await expect(note).toHaveCSS('position', 'static')
    await expect(note).toHaveCSS('display', 'block')
    await expect(panel).toHaveCSS('opacity', '1')
    await note.scrollIntoViewIfNeeded()
    await expect(note).toBeInViewport({ ratio: 1 })

    const geometry = await panel.evaluate((node) => {
      const form = node.querySelector('form.side-chat__composer')
      const note = node.querySelector(':scope > p.composer-note.side-chat__note')
      const textarea = node.querySelector('.side-chat__input')
      const footer = node.querySelector('.composer__footer')
      if (!form || !note || !textarea || !footer) return null
      return {
        panel: node.getBoundingClientRect().toJSON(),
        composer: form.getBoundingClientRect().toJSON(),
        note: note.getBoundingClientRect().toJSON(),
        textarea: textarea.getBoundingClientRect().toJSON(),
        footer: footer.getBoundingClientRect().toJSON(),
        noteDirectlyAfterComposer: note.previousElementSibling === form,
      }
    })
    expect(geometry).not.toBeNull()
    expect(geometry!.noteDirectlyAfterComposer).toBe(true)
    expect(geometry!.note.top).toBeGreaterThanOrEqual(geometry!.composer.bottom - 1)
    expect(geometry!.note.left).toBeGreaterThanOrEqual(geometry!.panel.left - 1)
    expect(geometry!.note.right).toBeLessThanOrEqual(geometry!.panel.right + 1)
    expect(geometry!.note.bottom).toBeLessThanOrEqual(geometry!.panel.bottom + 1)
    expect(geometry!.note.height).toBeGreaterThan(0)
    for (const control of [geometry!.textarea, geometry!.footer]) {
      expect(control.top).toBeGreaterThanOrEqual(geometry!.composer.top - 1)
      expect(control.bottom).toBeLessThanOrEqual(geometry!.composer.bottom + 1)
    }
    expect(geometry!.footer.top).toBeGreaterThanOrEqual(geometry!.textarea.bottom - 1)
    const screenshot = await fixture.captureScreenshot()
    writeFileSync(`${evidenceDirectory}/native-side-chat/disclaimer.png`, screenshot)
    await testInfo.attach('side-chat-disclaimer', { body: screenshot, contentType: 'image/png' })
  } finally {
    await fixture?.close()
  }
})

for (const withHud of [false, true]) {
  test(`keeps expanded work beneath its sticky status ${withHud ? 'with' : 'without'} the todo HUD`, async ({ testIdAttribute: _testIdAttribute }, testInfo) => {
    let fixture: WorkbenchLayoutFixture | undefined
    try {
      fixture = await launchWorkbenchLayout()
      const { page } = fixture
      mkdirSync(evidenceDirectory, { recursive: true })
      await submitLayoutRun(page, withHud)
      await expect(page.locator('.transcript-hud')).toHaveCount(withHud ? 1 : 0)
      await expectExpandedActivityReadable(page)

      for (const fraction of [0.5, 0.75, 0.9]) {
        await scrollWorkToFraction(page, fraction)
        await expectOpaqueWorkBoundary(page)
      }
      await testInfo.attach(`sticky-${withHud ? 'hud' : 'plain'}`, { body: await page.screenshot({ path: `${evidenceDirectory}/work-sticky-${withHud ? 'hud' : 'plain'}.png` }), contentType: 'image/png' })

      await fixture.finishRun()
      const work = page.locator('.work-disclosure')
      await expect(work).toBeVisible()
      await expect(work).not.toHaveClass(/is-running/)
      await expect(page.getByText('Layout fixture complete.', { exact: true })).toBeVisible()
      await expect(work.locator('.work-disclosure__button')).toHaveAttribute('aria-expanded', 'false')
      await work.locator('.work-disclosure__button').click()
      await expect(work.locator('.work-disclosure__button')).toHaveAttribute('aria-expanded', 'true')
      await expectExpandedActivityReadable(page)
      await scrollWorkToFraction(page, 0.5)
      await expectOpaqueWorkBoundary(page)
    } finally {
      await fixture?.close()
    }
  })
}

test('keeps the HUD reserve off a natural work header and the preceding user bubble', async ({ testIdAttribute: _testIdAttribute }, testInfo) => {
  let fixture: WorkbenchLayoutFixture | undefined
  const nativeEvidenceDirectory = `${hudReserveEvidenceDirectory}/native-short-hud`
  try {
    fixture = await launchWorkbenchLayout({ width: 1440, height: 1100 })
    const { page } = fixture
    mkdirSync(nativeEvidenceDirectory, { recursive: true })
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('nonsticky hud')
    await composer.press('Enter')
    await expect(page.locator('.work-disclosure.is-running')).toBeVisible()
    await expect(page.locator('.transcript-hud')).toHaveCount(1)
    await expect(page.locator('.activity-tool__summary')).toHaveCount(1)
    await fixture.finishRun()

    const work = page.locator('.work-disclosure')
    const header = work.locator('.work-disclosure__button')
    const bubble = page.locator('.message--user').filter({ hasText: 'nonsticky hud' }).locator('.user-bubble')
    const hudBar = page.locator('.todo-hud__bar')
    await expect(work).not.toHaveClass(/is-running/)
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('Layout fixture complete.', { exact: true })).toBeVisible()
    await expect.poll(async () => page.evaluate(async () => {
      const runtimes = await window.desktop.agent.list()
      return runtimes.length > 0 && runtimes.every((runtime) => !runtime.isStreaming)
    })).toBe(true)
    await expect(bubble).toBeVisible()
    await page.mouse.move(2, 2)
    await expect.poll(async () => page.evaluate(() => {
      const enteringContent = [...document.querySelectorAll('.message--enter .user-bubble, .message--enter .message__content')]
      return enteringContent.length > 0 && enteringContent.every((element) => getComputedStyle(element).opacity === '1')
    })).toBe(true)

    const geometry = await page.evaluate(() => {
      const pane = document.querySelector('.conversation-pane')
      const scroller = pane?.querySelector('.transcript')
      const hud = pane?.querySelector('.transcript-hud')
      const todo = hud?.querySelector('.todo-hud')
      const header = document.querySelector('.work-disclosure__button')
      const priorMessage = [...document.querySelectorAll('.message--user')].find((message) => message.textContent?.includes('nonsticky hud'))
      const bubble = priorMessage?.querySelector('.user-bubble')
      if (!pane || !scroller || !hud || !todo || !header || !bubble) return null
      const paneRect = pane.getBoundingClientRect()
      const scrollerRect = scroller.getBoundingClientRect()
      const hudRect = hud.getBoundingClientRect()
      const headerRect = header.getBoundingClientRect()
      const bubbleRect = bubble.getBoundingClientRect()
      const reserveStyle = getComputedStyle(hud, '::before')
      const headerBeforeStyle = getComputedStyle(header, '::before')
      const hitLabel = (hit: Element | null) => hit ? `${hit.tagName}.${hit.className}` : 'none'
      const bubblePoints = [bubbleRect.left + 24, bubbleRect.right - 24].map((x) => {
        const y = bubbleRect.bottom - 6
        const hit = document.elementFromPoint(x, y)
        return { x, y, hit: hitLabel(hit), insideBubble: hit === bubble || bubble.contains(hit) }
      })
      const headerHit = document.elementFromPoint(headerRect.left + headerRect.width / 2, headerRect.top + headerRect.height / 2)
      return {
        scrollTop: scroller.scrollTop,
        pane: paneRect.toJSON(),
        scroller: scrollerRect.toJSON(),
        hud: hudRect.toJSON(),
        header: headerRect.toJSON(),
        bubble: bubbleRect.toJSON(),
        reserve: {
          top: hudRect.top + Number.parseFloat(reserveStyle.top),
          height: Number.parseFloat(reserveStyle.height),
          content: reserveStyle.content,
          background: reserveStyle.backgroundColor,
          pointerEvents: reserveStyle.pointerEvents,
          zIndex: reserveStyle.zIndex,
        },
        transcriptPaddingTop: getComputedStyle(scroller).paddingTop,
        paneBackground: getComputedStyle(pane).backgroundColor,
        headerZIndex: getComputedStyle(header).zIndex,
        todoZIndex: getComputedStyle(todo).zIndex,
        headerBeforeContent: headerBeforeStyle.content,
        bubblePoints,
        headerHit: headerHit ? { label: hitLabel(headerHit), insideHeader: header === headerHit || header.contains(headerHit) } : null,
      }
    })
    expect(geometry).not.toBeNull()
    writeFileSync(`${nativeEvidenceDirectory}/natural-geometry.json`, `${JSON.stringify(geometry, null, 2)}\n`)

    // The old header's generated backplate below rejects this same natural
    // state; real hit targets also guard the preceding bubble and header.
    expect(geometry!.scrollTop).toBe(0)
    expect(geometry!.header.top).toBeGreaterThanOrEqual(geometry!.pane.top + Number.parseFloat(geometry!.transcriptPaddingTop) - 1)
    expect(geometry!.bubblePoints.every((point) => point.insideBubble)).toBe(true)
    expect(geometry!.headerHit?.insideHeader).toBe(true)

    expect(geometry!.headerBeforeContent).toBe('none')
    expect(geometry!.transcriptPaddingTop).toBe('96px')
    expect(Math.abs(geometry!.reserve.top - geometry!.pane.top)).toBeLessThanOrEqual(0.02)
    expect(Math.abs(geometry!.reserve.height - 96)).toBeLessThanOrEqual(0.02)
    expect(geometry!.reserve).toMatchObject({
      content: '""',
      background: geometry!.paneBackground,
      pointerEvents: 'auto',
      zIndex: '1',
    })
    expect(geometry!.headerZIndex).toBe('3')
    expect(geometry!.todoZIndex).toBe('8')

    const naturalScreenshot = await fixture.captureScreenshot()
    writeFileSync(`${nativeEvidenceDirectory}/natural.png`, naturalScreenshot)
    await testInfo.attach('natural-short-hud', { body: naturalScreenshot, contentType: 'image/png' })

    await hudBar.click()
    await expect(hudBar).toHaveAttribute('aria-expanded', 'true')
    const todoPanel = page.locator('.todo-hud__panel')
    await expect(todoPanel).toBeVisible()
    await expect(todoPanel).toContainText('Check the sticky status boundary')
    await expect(todoPanel.locator('.todo-hud__task.is-in_progress')).toHaveCount(1)
    await expect(page.locator('.todo-hud').locator('script, iframe, object, embed, foreignObject')).toHaveCount(0)
    expect(await page.locator('.todo-hud').evaluate((todo) => {
      const rect = todo.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 12)
      return hit !== null && (hit === todo || todo.contains(hit))
    })).toBe(true)
    const expandedScreenshot = await fixture.captureScreenshot()
    writeFileSync(`${nativeEvidenceDirectory}/expanded.png`, expandedScreenshot)
    await testInfo.attach('expanded-short-hud', { body: expandedScreenshot, contentType: 'image/png' })
    await hudBar.click()
    await expect(hudBar).toHaveAttribute('aria-expanded', 'false')
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'false')
  } finally {
    await fixture?.close()
  }
})
