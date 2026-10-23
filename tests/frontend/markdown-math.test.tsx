import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownText } from '../../src/components/MarkdownText'

function render(text: string): string {
  return renderToStaticMarkup(createElement(MarkdownText, { text }))
}

describe('Markdown math rendering', () => {
  it('renders inline LaTeX between single dollars', () => {
    const html = render('Euler: $e^{i\\pi} + 1 = 0$ identity.')
    expect(html).toContain('class="katex"')
    // The source dollars are consumed by the math pipeline, not printed.
    expect(html).not.toContain('$e^{i')
  })

  it('renders fenced display math blocks as centered blocks', () => {
    const html = render('Intro\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\nOutro')
    expect(html).toContain('katex-display')
    expect(html).toContain('katex-html')
    expect(html).toContain('display="block"')
  })

  it('keeps math inside fenced code blocks literal', () => {
    const html = render('```\n$e^{i\\pi}$ stays literal\n```')
    expect(html).not.toContain('katex')
    expect(html).toContain('$e^{i\\pi}$')
  })

  it('renders broken LaTeX as a themed error instead of crashing', () => {
    const html = render('$\\fracc{1}{2}$')
    expect(html).toContain('var(--danger)')
    expect(html).toContain('\\fracc')
  })
})
