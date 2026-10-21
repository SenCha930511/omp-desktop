import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Vazirmatn font stack', () => {
  const css = readFileSync('src/styles/base.css', 'utf8')
  const fontFace = css.match(/@font-face\s*\{[\s\S]*?font-family:\s*['"]Vazirmatn['"][\s\S]*?\}/)?.[0] ?? ''
  const fontUrl = fontFace.match(/src:\s*url\(\s*['"]?([^'")\s]+)['"]?\s*\)/)?.[1] ?? ''
  const root = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? ''
  const rootFontFamily = root.match(/font-family:\s*([^;]+);/)?.[1] ?? ''

  it('defines the bundled Arabic variable face and ships its source asset', () => {
    expect(fontFace).toMatch(/font-family:\s*['"]Vazirmatn['"]/)
    expect(fontFace).toMatch(/src:\s*url\(\s*['"]?\/fonts\/vazirmatn-arabic-var\.woff2['"]?\s*\)/)
    expect(fontFace).toMatch(/font-weight:\s*100\s+900/)
    expect(fontFace).toMatch(/unicode-range:[^;]*U\+0600-06FF/)
    expect(existsSync('public/fonts/vazirmatn-arabic-var.woff2')).toBe(true)
  })

  it('puts Vazirmatn before the system families in the root stack', () => {
    expect(rootFontFamily.indexOf('Vazirmatn')).toBeGreaterThanOrEqual(0)
    expect(rootFontFamily.indexOf('ui-sans-serif')).toBeGreaterThanOrEqual(0)
    expect(rootFontFamily.indexOf('Vazirmatn')).toBeLessThan(rootFontFamily.indexOf('ui-sans-serif'))
  })

  it('keeps the font in the renderer inputs that are packaged into the asar', () => {
    const rendererConfig = readFileSync('electron.vite.config.ts', 'utf8')
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { build: { files: string[] } }
    const publicFontPath = join('public', fontUrl.replace(/^\/+/, ''))

    // The publicDir, outDir, and electron-builder inputs must stay aligned for the font to reach the asar.
    expect(fontUrl).toMatch(/^\/fonts\//)
    expect(existsSync(publicFontPath)).toBe(true)
    expect(rendererConfig).toMatch(/renderer:\s*\{[\s\S]*?\broot:\s*['"]\.['"]/)
    expect(rendererConfig).not.toMatch(/\bpublicDir\s*:/)
    expect(rendererConfig).not.toMatch(/\boutDir\s*:/)
    expect(packageJson.build.files).toContain('out/**/*')
  })

  it('defines 5-tier motion duration tokens, easing curves, and reduced-motion overrides', () => {
    expect(root).toMatch(/--duration-fast:\s*60ms;/)
    expect(root).toMatch(/--duration-snap:\s*120ms;/)
    expect(root).toMatch(/--duration-base:\s*200ms;/)
    expect(root).toMatch(/--duration-sheet:\s*300ms;/)
    expect(root).toMatch(/--duration-slow:\s*450ms;/)
    expect(root).toMatch(/--ease-swift:\s*cubic-bezier\(\.16,\s*1,\s*\.3,\s*1\);/)
    expect(root).toMatch(/--ease-expand:\s*cubic-bezier\(\.19,\s*1,\s*\.22,\s*1\);/)

    const reduceMotionClass = css.match(/:root\.reduce-motion\s*\{([\s\S]*?)\}/)?.[1] ?? ''
    for (const token of ['--duration-fast', '--duration-snap', '--duration-base', '--duration-sheet', '--duration-slow']) {
      expect(reduceMotionClass).toMatch(new RegExp(`${token}:\\s*\\.001ms;`))
    }

    const reduceMotionMedia = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*:root\s*\{([\s\S]*?)\}\s*\}/)?.[1] ?? ''
    for (const token of ['--duration-fast', '--duration-snap', '--duration-base', '--duration-sheet', '--duration-slow']) {
      expect(reduceMotionMedia).toMatch(new RegExp(`${token}:\\s*\\.001ms;`))
    }
  })

  it('defines light and dark font-weight de-dilation tokens and dark-mode smoothing/popover tokens', () => {
    expect(root).toMatch(/--font-weight-normal:\s*400;/)
    expect(root).toMatch(/--font-weight-medium:\s*520;/)
    expect(root).toMatch(/--font-weight-semibold:\s*600;/)

    const darkRoot = css.match(/:root\[data-theme=["']dark["']\]\s*\{([\s\S]*?)\}/)?.[1] ?? ''
    expect(darkRoot).toMatch(/--font-weight-normal:\s*370;/)
    expect(darkRoot).toMatch(/--font-weight-medium:\s*480;/)
    expect(darkRoot).toMatch(/--font-weight-semibold:\s*560;/)
    expect(darkRoot).toMatch(/-webkit-font-smoothing:\s*antialiased;/)
    expect(darkRoot).toMatch(/-moz-osx-font-smoothing:\s*grayscale;/)
    expect(darkRoot).toMatch(/--shadow-popover:\s*0 12px 32px rgba\(0,\s*0,\s*0,\s*\.38\),\s*inset 0 0 0 \.5px rgba\(255,\s*255,\s*255,\s*\.08\);/)
  })

  it('aligns inline Lucide icons optically on the -0.125em baseline', () => {
    expect(css).toMatch(/:where\(p,\s*li,\s*small,\s*label,\s*\.inline-icon\)\s*>\s*svg\.lucide\s*\{\s*vertical-align:\s*-0\.125em;\s*\}/)
  })
})
