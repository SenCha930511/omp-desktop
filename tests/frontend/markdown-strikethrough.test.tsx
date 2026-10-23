import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownText } from '../../src/components/MarkdownText'

function render(text: string): string {
  return renderToStaticMarkup(createElement(MarkdownText, { text }))
}

describe('Markdown strikethrough', () => {
  it('keeps single-tilde spans literal', () => {
    const html = render('Keep ~this~ literal.')
    expect(html).not.toContain('<del>')
    expect(html).toContain('~this~')
  })

  it('strikes double-tilde spans', () => {
    const html = render('Strike ~~this~~ out.')
    expect(html).toContain('<del>this</del>')
  })
})
