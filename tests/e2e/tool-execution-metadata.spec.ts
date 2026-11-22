import { expect, test, type Locator } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { launchWorkbenchLayout, type ToolMetadataStage, type WorkbenchLayoutFixture } from './workbench-layout.fixture'

const evidenceDirectory = '.audit/tool-execution-native'
const vitestInvocation = ['node_modules/vitest/vitest.mjs', 'run', 'tests/frontend/vitest-report.test.ts']

function captureRealVitestFooter(): { vitestOutput: string; exitCode: number; filesLabel: string; testsLabel: string } {
  // This is a direct, deterministic local CLI capture, not an OMP invocation.
  // No agent, provider, form input, or authenticated service is involved.
  const result = spawnSync(process.execPath, vitestInvocation, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 256 * 1024,
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      LANG: 'C',
      LC_ALL: 'C',
      CI: '1',
      NO_COLOR: '1',
    },
  })
  if (result.error) throw result.error
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const lines = output.split(/\r?\n/)
  const fileLine = lines.find((line) => /^ Test Files[ \t]/.test(line))
  const testLine = lines.find((line) => /^      Tests[ \t]/.test(line))
  if (result.status !== 0 || !fileLine || !testLine) {
    throw new Error(`Could not capture the bounded Vitest 4 footer (status ${result.status}, signal ${result.signal}):\n${output.slice(0, 16_000)}`)
  }
  // Preserve the primary format's actual one- and six-space title padding.
  const vitestOutput = `${fileLine}\n${testLine}\n`
  mkdirSync(evidenceDirectory, { recursive: true })
  writeFileSync(`${evidenceDirectory}/vitest-capture.json`, `${JSON.stringify({
    source: 'direct local Vitest CLI; not executed by fake OMP',
    command: [process.execPath, ...vitestInvocation],
    fixture: 'tests/frontend/vitest-report.test.ts',
    exitCode: result.status,
    stdoutLength: result.stdout?.length ?? 0,
    stderrLength: result.stderr?.length ?? 0,
    vitestOutput,
  }, null, 2)}\n`)
  return {
    vitestOutput,
    exitCode: result.status,
    filesLabel: fileLine.trim().replace(/\s+/g, ' ').replace('Test Files', 'Test files'),
    testsLabel: testLine.trim().replace(/\s+/g, ' '),
  }
}

async function openTool(row: Locator): Promise<void> {
  const summary = row.locator('.activity-tool__summary')
  await summary.scrollIntoViewIfNeeded()
  if (await summary.getAttribute('aria-expanded') !== 'true') await summary.click()
  await expect(row.locator('.activity-tool__details')).toBeVisible()
}

test('renders and clears native wait/bash metadata using real Electron transcript DOM', async ({ testIdAttribute: _testIdAttribute }, testInfo) => {
  const capture = captureRealVitestFooter()
  let fixture: WorkbenchLayoutFixture | undefined
  const stages: (ToolMetadataStage | 'settled')[] = []
  try {
    mkdirSync(evidenceDirectory, { recursive: true })
    fixture = await launchWorkbenchLayout({ width: 1440, height: 1100 }, capture)
    const { page } = fixture
    await page.getByRole('combobox', { name: 'Message OMP' }).fill('native tool metadata smoke')
    await page.getByRole('combobox', { name: 'Message OMP' }).press('Enter')
    const rows = page.locator('.activity-line--tool')
    await expect(rows.first()).toBeVisible()
    await rows.first().locator('.activity-tool__summary').click()
    writeFileSync(`${evidenceDirectory}/initial-dom.txt`, JSON.stringify({
      transcript: (await page.locator('.transcript').innerText()).slice(0, 16_000),
      tools: await page.locator('.activity-line--tool').evaluateAll((nodes) => nodes.map((node) => node.outerHTML)),
      work: await page.locator('.work-disclosure').evaluateAll((nodes) => nodes.map((node) => node.outerHTML)),
      users: await page.locator('.message--user').allTextContents(),
      streaming: await page.locator('.streaming-state').allTextContents(),
    }, null, 2))
    await expect(rows).toHaveCount(2)
    const waitRow = rows.filter({ has: page.locator('.activity-line__kind').getByText('wait', { exact: true }) })
    const bashRow = rows.filter({ has: page.locator('.activity-line__kind').getByText('bash', { exact: true }) })
    await expect(waitRow).toHaveCount(1)
    await expect(bashRow).toHaveCount(1)
    await expect(rows.nth(0).locator('.activity-line__kind')).toHaveText('wait')
    await expect(rows.nth(1).locator('.activity-line__kind')).toHaveText('bash')
    await openTool(waitRow)
    await expect(waitRow.locator('.activity-tool__contents')).toContainText('{}')
    await expect(waitRow.locator('.activity-tool__native-metadata')).toHaveCount(0)
    await openTool(bashRow)
    await expect(bashRow.locator('.activity-tool__contents')).toContainText('node_modules/vitest/vitest.mjs run tests/frontend/vitest-report.test.ts')
    await expect(bashRow.locator('.activity-tool__bash-metadata')).toHaveCount(0)

    stages.push('wait-valid')
    await fixture.advanceToolMetadata('wait-valid')
    await expect(waitRow.locator('.activity-tool__wait-jobs')).toBeVisible()
    await expect(waitRow.locator('.activity-tool__wait-jobs > div')).toHaveText('Showing first 128 native jobs')
    await expect(waitRow.locator('.activity-tool__wait-jobs li')).toHaveCount(128)
    const firstJob = waitRow.locator('.activity-tool__wait-jobs li').first()
    await expect(firstJob).toContainText('Metadata projection fixture task')
    await expect(firstJob.locator('code')).toHaveText('fixture-metadata-task-017')
    await expect(firstJob).toContainText('task · completed · Verify native wait projection in Electron · completed')
    await expect(firstJob.locator('.activity-tool__engine-elapsed')).toHaveText('Engine elapsed 1m05s')
    await expect(firstJob.locator('.activity-tool__engine-elapsed')).toHaveAttribute('title', 'Engine elapsed 1m05s')
    await expect(firstJob).toContainText('Fixture result wraps safely:')
    await expect(waitRow.getByText('Bounded fixture job 128', { exact: true })).toHaveCount(0)

    const waitLayout = await firstJob.evaluate((job) => {
      const native = job.closest('.activity-tool__native-metadata')
      const list = job.parentElement
      if (!native || !list) throw new Error('Missing native wait metadata layout')
      const listStyle = getComputedStyle(list)
      const jobRect = job.getBoundingClientRect()
      const nativeRect = native.getBoundingClientRect()
      return {
        listMarginTop: listStyle.marginTop,
        listMarginRight: listStyle.marginRight,
        listMarginBottom: listStyle.marginBottom,
        listMarginLeft: listStyle.marginLeft,
        overflowWrap: getComputedStyle(job).overflowWrap,
        contentContained: jobRect.right <= nativeRect.right + 1 && job.scrollWidth <= job.clientWidth,
      }
    })
    expect(waitLayout).toMatchObject({ listMarginTop: '5px', listMarginRight: '0px', listMarginBottom: '0px', listMarginLeft: '0px', overflowWrap: 'anywhere', contentContained: true })

    stages.push('wait-malformed')
    await fixture.advanceToolMetadata('wait-malformed')
    await expect(waitRow.locator('.activity-tool__native-metadata')).toHaveCount(0)
    await expect(waitRow.locator('.activity-tool__wait-jobs')).toHaveCount(0)
    await expect(waitRow.locator('.activity-tool__summary')).toContainText('Pending work')
    await expect(waitRow.locator('.activity-tool__contents')).toContainText('{}')
    await expect(waitRow.locator('.activity-tool__contents')).toContainText('Malformed nonempty wait jobs must not retain native details.')
    await expect(waitRow.getByText('0 native jobs', { exact: true })).toHaveCount(0)

    stages.push('bash-valid')
    await fixture.advanceToolMetadata('bash-valid')
    await expect(bashRow.locator('.activity-tool__bash-metadata')).toBeVisible()
    await expect(bashRow.locator('.activity-tool__bash-metadata dt').nth(0)).toHaveText('Engine elapsed')
    await expect(bashRow.locator('.activity-tool__bash-metadata dd').nth(0)).toHaveText('3m08s')
    await expect(bashRow.locator('.activity-tool__bash-metadata > div').nth(0)).toHaveAttribute('title', 'Engine elapsed 3m08s')
    await expect(bashRow.locator('.activity-tool__bash-metadata dt').nth(1)).toHaveText('Exit code')
    await expect(bashRow.locator('.activity-tool__bash-metadata dd').nth(1)).toHaveText(String(capture.exitCode))
    await expect(bashRow.getByRole('region', { name: 'Reported Vitest summary' })).toBeVisible()
    await expect(bashRow.locator('.activity-tool__test-report-line').nth(0)).toHaveText(capture.filesLabel)
    await expect(bashRow.locator('.activity-tool__test-report-line').nth(1)).toHaveText(capture.testsLabel)
    await expect(bashRow.locator('.activity-tool__contents')).toContainText(' Test Files')
    await expect(bashRow.locator('.activity-tool__contents')).toContainText('      Tests')

    stages.push('bash-malformed')
    await fixture.advanceToolMetadata('bash-malformed')
    await expect(bashRow.locator('.activity-tool__test-report')).toHaveCount(0)
    await expect(bashRow.locator('.activity-tool__bash-metadata')).toBeVisible()
    await expect(bashRow.locator('.activity-tool__bash-metadata dd')).toHaveText('1m40s')
    await expect(bashRow.locator('.activity-tool__bash-metadata')).toHaveText('Engine elapsed1m40s')
    await expect(bashRow.locator('.activity-tool__bash-metadata dd')).toHaveCount(1)
    await expect(bashRow.locator('.activity-tool__contents')).toContainText(' Test Files  2 passed (2)')
    await expect(bashRow.locator('.activity-tool__contents')).toContainText('      Tests  1 passed\n')

    stages.push('complete')
    await fixture.advanceToolMetadata('complete')
    await expect(rows).toHaveCount(2)
    await expect(page.locator('.activity-line--result')).toHaveCount(0)
    await expect(waitRow).toHaveClass(/is-done/)
    await expect(bashRow).toHaveClass(/is-done/)
    await expect(waitRow).not.toHaveClass(/is-error/)
    await expect(bashRow).not.toHaveClass(/is-error/)

    // Verify completed end snapshots before agent_end triggers the separate
    // history reader: this fake session persists raw text but not details.
    await openTool(waitRow)
    await expect(waitRow.locator('.activity-tool__wait-jobs > div')).toHaveText('1 native job')
    await expect(waitRow.locator('.activity-tool__wait-jobs li')).toHaveCount(1)
    await expect(waitRow.locator('.activity-tool__wait-jobs li')).toContainText('Metadata projection fixture task')
    await expect(waitRow.locator('.activity-tool__engine-elapsed')).toHaveText('Engine elapsed 1m05s')
    await expect(waitRow.locator('.activity-tool__job-result')).toContainText('Completed native-schema fixture; this is not measured engine execution time.')
    await expect(waitRow.locator('.activity-tool__contents')).toContainText('{}')
    await expect(waitRow.locator('.activity-tool__contents')).toContainText('Controlled wait completed; arguments and result remain available.')

    await openTool(bashRow)
    await expect(bashRow.locator('.activity-tool__bash-metadata dd').nth(0)).toHaveText('3m08s')
    await expect(bashRow.locator('.activity-tool__bash-metadata dd').nth(1)).toHaveText(String(capture.exitCode))
    await expect(bashRow.locator('.activity-tool__test-report-line').nth(0)).toHaveText(capture.filesLabel)
    await expect(bashRow.locator('.activity-tool__test-report-line').nth(1)).toHaveText(capture.testsLabel)
    await expect(bashRow.locator('.activity-tool__contents')).toContainText(capture.vitestOutput.trim())
    await expect(bashRow.locator('.activity-tool__contents')).toContainText('node_modules/vitest/vitest.mjs run tests/frontend/vitest-report.test.ts')

    const bashLayout = await bashRow.locator('.activity-tool__bash-metadata').evaluate((list) => {
      const style = getComputedStyle(list)
      return { marginTop: style.marginTop, marginRight: style.marginRight, marginBottom: style.marginBottom, marginLeft: style.marginLeft }
    })
    expect(bashLayout).toEqual({ marginTop: '0px', marginRight: '0px', marginBottom: '0px', marginLeft: '0px' })
    const nativeText = await page.locator('.activity-tool__native-metadata').allTextContents()
    expect(nativeText.join('\n')).not.toMatch(/\bPID\b|\d+\s*%/)
    await openTool(waitRow)
    await openTool(bashRow)
    await waitRow.scrollIntoViewIfNeeded()
    const screenshot = await fixture.captureScreenshot()
    writeFileSync(`${evidenceDirectory}/completed-native-metadata.png`, screenshot)
    await testInfo.attach('completed-native-metadata', { body: screenshot, contentType: 'image/png' })

    stages.push('settled')
    await fixture.finishRun()
    const work = page.locator('.work-disclosure')
    await expect(work).not.toHaveClass(/is-running/)
    await expect(page.getByText('Layout fixture complete.', { exact: true })).toBeVisible()
    await expect(work.locator('.work-disclosure__button')).toHaveAttribute('aria-expanded', 'false')
    await work.locator('.work-disclosure__button').click()
    await expect(rows).toHaveCount(2)
    await openTool(waitRow)
    await expect(waitRow.locator('.activity-tool__contents')).toContainText('{}')
    await expect(waitRow.locator('.activity-tool__contents')).toContainText('Controlled wait completed; arguments and result remain available.')
    await expect(waitRow.locator('.activity-tool__native-metadata')).toHaveCount(0)
    await expect(waitRow.getByText('0 native jobs', { exact: true })).toHaveCount(0)
    await openTool(bashRow)
    await expect(bashRow.locator('.activity-tool__contents')).toContainText(capture.vitestOutput.trim())
    await expect(bashRow.locator('.activity-tool__test-report')).toHaveCount(0)
    await expect(bashRow.locator('.activity-tool__bash-metadata')).toHaveCount(0)

    const observed = { stages, capture: { filesLabel: capture.filesLabel, testsLabel: capture.testsLabel, exitCode: capture.exitCode }, waitDurationMs: 65432, bashWallTimeMs: 187654, waitLayout, bashLayout, toolCount: await rows.count(), settledNativeMetadataCount: await page.locator('.activity-tool__native-metadata').count() }
    writeFileSync(`${evidenceDirectory}/dom-observations.json`, `${JSON.stringify(observed, null, 2)}\n`)
    await testInfo.attach('native-metadata-observations', { body: JSON.stringify(observed, null, 2), contentType: 'application/json' })
  } finally {
    await fixture?.close()
  }
})
