// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { attachInput, pinchUpdate } from '@/engine/input'
import { screenToWorld, zoomAt, type Viewport } from '@/engine/viewport'
import type { CanvasEngine } from '@/engine/engine'

describe('pinchUpdate', () => {
  it('reports the ratio of pointer separations and their midpoint', () => {
    const prev = { dist: 100, cx: 0, cy: 0 }
    const next = pinchUpdate(prev, { x: 0, y: 0 }, { x: 200, y: 0 })
    expect(next.dist).toBe(200)
    expect(next.factor).toBe(2)
    expect(next.cx).toBe(100)
    expect(next.cy).toBe(0)
  })

  it('is a no-op factor when the fingers do not move', () => {
    expect(pinchUpdate({ dist: 50, cx: 5, cy: 5 }, { x: 0, y: 0 }, { x: 50, y: 0 }).factor).toBe(1)
  })

  it('never divides by zero when both pointers coincide', () => {
    const next = pinchUpdate({ dist: 0, cx: 0, cy: 0 }, { x: 7, y: 7 }, { x: 7, y: 7 })
    expect(next.factor).toBe(1)
  })

  it('composes with zoomAt to keep the pinch midpoint fixed', () => {
    const vp = { scale: 1, tx: 0, ty: 0 }
    const { factor, cx, cy } = pinchUpdate({ dist: 100, cx: 50, cy: 50 }, { x: 0, y: 50 }, { x: 200, y: 50 })
    const next = zoomAt(vp, cx, cy, factor)
    // The world point under the midpoint before the zoom is still under it after.
    const worldBefore = (cx - vp.tx) / vp.scale
    const worldAfter = (cx - next.tx) / next.scale
    expect(worldAfter).toBeCloseTo(worldBefore, 5)
    expect(next.scale).toBe(2)
  })

  it('preserves the world point under the pinch midpoint from a non-identity viewport', () => {
    const vp: Viewport = { scale: 2, tx: 30, ty: -15 }
    const { factor, cx, cy } = pinchUpdate({ dist: 100, cx: 80, cy: 60 }, { x: 20, y: 40 }, { x: 140, y: 80 })
    const [wxBefore, wyBefore] = screenToWorld(vp, cx, cy)
    const next = zoomAt(vp, cx, cy, factor)
    const [wxAfter, wyAfter] = screenToWorld(next, cx, cy)
    expect(wxAfter).toBeCloseTo(wxBefore, 5)
    expect(wyAfter).toBeCloseTo(wyBefore, 5)
  })
})

/**
 * Handler-level coverage for the pointer bookkeeping in `attachInput` itself
 * (`pinchUpdate` above only exercises the pure math). jsdom's canvas has no
 * pointer-capture backend, so those three methods are stubbed per element;
 * everything else is real `PointerEvent` dispatch through the real listeners.
 */
describe('attachInput pointer bookkeeping', () => {
  function makeCanvas() {
    const canvas = document.createElement('canvas')
    canvas.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON() {},
    })
    canvas.setPointerCapture = () => {}
    canvas.releasePointerCapture = () => {}
    canvas.hasPointerCapture = () => false
    return canvas
  }

  function makeEngine() {
    let vp: Viewport = { scale: 1, tx: 0, ty: 0 }
    return {
      get viewport() {
        return vp
      },
      setViewport(next: Viewport) {
        vp = next
      },
    } as unknown as CanvasEngine
  }

  function down(canvas: HTMLCanvasElement, id: number, x: number, y: number) {
    canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: id, clientX: x, clientY: y, button: 0 }))
  }
  function move(canvas: HTMLCanvasElement, id: number, x: number, y: number) {
    canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: id, clientX: x, clientY: y }))
  }
  function up(canvas: HTMLCanvasElement, id: number, x: number, y: number) {
    canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: id, clientX: x, clientY: y }))
  }

  it('hands off to a pan when one finger lifts mid-pinch (finding 1)', () => {
    const canvas = makeCanvas()
    const engine = makeEngine()
    const dispose = attachInput(engine, canvas, () => null)

    down(canvas, 1, 0, 50)
    down(canvas, 2, 200, 50)
    move(canvas, 1, 20, 50) // seeds the pinch baseline, no zoom yet
    move(canvas, 1, 40, 50) // a real pinch update
    const vpDuringPinch = engine.viewport

    up(canvas, 1, 40, 50) // finger 1 lifts; finger 2 survives
    // The survivor should now be panning: a move from it pans the viewport
    // immediately, with no extra press/release cycle required.
    move(canvas, 2, 220, 50)
    expect(engine.viewport.tx).not.toBe(vpDuringPinch.tx)
    expect(engine.viewport.scale).toBe(vpDuringPinch.scale) // a pan, not a zoom

    dispose()
  })

  it('hands off to a pan when one finger lifts before any pinch move fires (finding 1, no-move path)', () => {
    const canvas = makeCanvas()
    const engine = makeEngine()
    const dispose = attachInput(engine, canvas, () => null)

    down(canvas, 1, 0, 50)
    down(canvas, 2, 200, 50)
    // No pointermove in between: a quick two-finger tap, or an overshoot,
    // lifts one finger before the pinch baseline is ever seeded.
    up(canvas, 1, 0, 50)

    const before = engine.viewport
    move(canvas, 2, 220, 50)
    expect(engine.viewport.tx).not.toBe(before.tx)
    expect(engine.viewport.scale).toBe(before.scale)

    dispose()
  })

  it('reseeds the baseline when the pinched pair changes identity (finding 2)', () => {
    const canvas = makeCanvas()
    const engine = makeEngine()
    const dispose = attachInput(engine, canvas, () => null)

    down(canvas, 1, 0, 50)
    down(canvas, 2, 200, 50)
    move(canvas, 1, 0, 50) // seed A-B baseline (dist 200)
    down(canvas, 3, 400, 50) // third finger joins, pair stays A-B
    up(canvas, 1, 0, 50) // A lifts; live pair is now B-C, id-wise different from A-B

    const before = engine.viewport
    // First move after the pair swap must only reseed (no jump), not compare
    // B-C's fresh geometry against the stale A-B baseline.
    move(canvas, 2, 200, 50)
    expect(engine.viewport).toEqual(before)

    // A subsequent real move against the now-correct B-C baseline zooms cleanly.
    move(canvas, 2, 150, 50)
    expect(engine.viewport.scale).not.toBe(before.scale)

    dispose()
  })
})
