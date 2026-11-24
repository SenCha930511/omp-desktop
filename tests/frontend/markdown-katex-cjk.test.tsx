import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it } from 'vitest'
import { MarkdownText } from '../../src/components/MarkdownText'
import { preloadMarkdownMathPlugins, readMarkdownMathPlugins } from '../../src/components/markdown-math-plugins'

function render(text: string): string {
  return renderToStaticMarkup(createElement(MarkdownText, { text }))
}

beforeAll(async () => {
  await preloadMarkdownMathPlugins()
  expect(readMarkdownMathPlugins()).toBeDefined()
})

describe('KaTeX CJK spacing', () => {
  it('marks CJK math roots for the spacing overrides', () => {
    const html = render('$$J(w) = \\frac{類別間}{類別內}$$')
    expect(html).toContain('katex--cjk')
  })

  it('leaves pure-latin math untouched', () => {
    const html = render('$$J(w) = \\frac{between}{within}$$')
    expect(html).not.toContain('katex--cjk')
  })
})
