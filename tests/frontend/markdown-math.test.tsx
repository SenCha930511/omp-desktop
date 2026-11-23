import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownText } from '../../src/components/MarkdownText'
import { normalizeLatexDelimiters } from '../../src/lib/markdown-math'

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

  it('renders backslash inline \\(...\\) and display \\[...\\] LaTeX delimiters', () => {
    const inlineHtml = render('Inline: \\( a^2 + b^2 = c^2 \\) done.')
    expect(inlineHtml).toContain('class="katex"')
    expect(inlineHtml).not.toContain('\\(')
    expect(inlineHtml).not.toContain('\\)')

    const singleLineDisplay = render('Before \\[ \\sum_{i=1}^n i = \\frac{n(n+1)}{2} \\] after')
    expect(singleLineDisplay).toContain('katex-display')
    expect(singleLineDisplay).not.toContain('\\[')

    const multiLineDisplay = render('Formula:\n\\[\nx^2 + y^2\n= z^2\n\\]\nEnd.')
    expect(multiLineDisplay).toContain('katex-display')
    expect(multiLineDisplay).toContain('z')
  })

  it('applies CJK spacing annotation to backslash-delimited math', () => {
    const html = render('比率：\\( \\frac{\\text{類別間}}{\\text{類別內}} \\)')
    expect(html).toContain('katex--cjk')
  })

  it('keeps math inside fenced code blocks and inline code literal', () => {
    const fenced = render('```\n$e^{i\\pi}$ and \\(x\\) and \\[y\\] stay literal\n```')
    expect(fenced).not.toContain('katex')
    expect(fenced).toContain('$e^{i\\pi}$')
    expect(fenced).toContain('\\(x\\)')
    expect(fenced).toContain('\\[y\\]')

    const inlineCode = render('Use `\\(x\\)` or ``\\[y\\]`` literally.')
    expect(inlineCode).not.toContain('katex')
    expect(inlineCode).toContain('\\(x\\)')
    expect(inlineCode).toContain('\\[y\\]')
  })

  it('preserves escaped delimiters and unclosed streaming delimiters', () => {
    expect(normalizeLatexDelimiters('Escaped \\\\(x\\\\) and \\\\[y\\\\]')).toBe('Escaped \\\\(x\\\\) and \\\\[y\\\\]')
    expect(normalizeLatexDelimiters('Streaming \\(x + y')).toBe('Streaming \\(x + y')
    expect(normalizeLatexDelimiters('Streaming\n\\[\nx + y')).toBe('Streaming\n\\[\nx + y')
  })

  it('renders broken LaTeX as a themed error instead of crashing', () => {
    const html = render('$\\fracc{1}{2}$')
    expect(html).toContain('var(--danger)')
    expect(html).toContain('\\fracc')
  })
})
