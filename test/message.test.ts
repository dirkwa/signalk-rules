import { describe, it, expect } from 'vitest'
import {
  conditionPaths,
  placeholderPaths,
  renderMessage
} from '../src/shared/message.js'

describe('notification message placeholders', () => {
  it('finds each path once', () => {
    expect(
      placeholderPaths('{a.b} then {c.d-e_1} and {a.b} again, {x} {} {a.}')
    ).toEqual(['a.b', 'c.d-e_1'])
  })

  it('replaces only path placeholders', () => {
    expect(renderMessage('Outage {a.b} s, {note} {c.d}', (p) => `<${p}>`)).toBe(
      'Outage <a.b> s, {note} <c.d>'
    )
  })

  it('lists the paths conditions read, each once', () => {
    expect(
      conditionPaths([
        { type: 'numeric', path: 'a.b', operator: 'gt', threshold: 1 },
        { type: 'timeOfDay', from: '08:00', to: '18:00' },
        { type: 'string', path: 'a.b', equals: 'x' },
        { type: 'switch', path: 'c.d', equals: 1 }
      ])
    ).toEqual(['a.b', 'c.d'])
  })
})
