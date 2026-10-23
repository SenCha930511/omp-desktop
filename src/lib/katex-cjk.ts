import type { Element, Root } from 'hast'

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

function hasCjkText(node: Element): boolean {
  for (const child of node.children) {
    if (child.type === 'text' && CJK.test(child.value)) return true
    if (child.type === 'element' && hasCjkText(child)) return true
  }
  return false
}

/**
 * KaTeX lays out fractions from its bundled font metrics; CJK glyphs come
 * from the system fallback and run taller, so a fraction like 類別間/類別內
 * renders with the bar crossing the characters. KaTeX knows nothing about
 * CJK, so mark affected roots here and let CSS add the breathing room
 * (letter spacing, taller fraction bar clearance). Pure annotation: no
 * re-render, no math source rewriting.
 */
export function rehypeKatexCjkClass(): (tree: Root) => void {
  return (tree) => {
    const visit = (node: Element): void => {
      const classes = node.properties?.className
      if (Array.isArray(classes) && classes.includes('katex') && hasCjkText(node)) {
        node.properties.className = [...classes, 'katex--cjk']
      }
      for (const child of node.children) {
        if (child.type === 'element') visit(child)
      }
    }
    for (const child of tree.children) {
      if (child.type === 'element') visit(child)
    }
  }
}
