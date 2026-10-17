/** Command output is terminal text, never HTML. Discard terminal control protocols. */
export function commandOutputText(text: string): string {
  const output: string[] = []
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 27 || code === 155 || code === 157) {
      const kind = code === 27 ? text[++index] : code === 155 ? '[' : ']'
      if (kind === '[') {
        while (index + 1 < text.length) {
          const next = text.charCodeAt(++index)
          if (next >= 64 && next <= 126) break
        }
      } else if (kind === ']' || kind === 'P' || kind === '_' || kind === '^' || kind === 'X') {
        while (index + 1 < text.length) {
          const next = text.charCodeAt(++index)
          if (next === 7 || next === 156) break
          if (next === 27 && text[index + 1] === '\\') { index += 1; break }
        }
      }
      continue
    }
    if (code === 8) { if (output.at(-1) !== '\n') output.pop(); continue }
    if (code === 13) { if (text[index + 1] !== '\n') output.push('\n'); continue }
    if ((code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159)) continue
    output.push(text[index])
  }
  return output.join('')
}
