import { describe, it, expect } from 'vitest'
import { sizeCanvas, crispOffset } from '@/engine/canvas'

const fakeCanvas = () => ({ width: 0, height: 0, style: {} as Record<string, string> })

describe('sizeCanvas', () => {
  it('sizes the backing store by dpr and the element by css px', () => {
    const c = fakeCanvas()
    sizeCanvas(c as never, 800, 600, 2)
    expect(c.width).toBe(1600)
    expect(c.height).toBe(1200)
    expect(c.style.width).toBe('800px')
    expect(c.style.height).toBe('600px')
  })

  it('rounds fractional dpr up to whole device pixels', () => {
    const c = fakeCanvas()
    sizeCanvas(c as never, 801, 601, 1.5)
    expect(Number.isInteger(c.width)).toBe(true)
    expect(Number.isInteger(c.height)).toBe(true)
  })
})

describe('crispOffset', () => {
  it('is half a device pixel in css units', () => {
    expect(crispOffset(1)).toBeCloseTo(0.5)
    expect(crispOffset(2)).toBeCloseTo(0.25)
  })
})
