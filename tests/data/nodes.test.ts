import { describe, it, expect } from 'vitest'
import {
  createNodeArrays, pushNode, getRect, indexOfId, NodeType, FLAG_DIRTY,
} from '@/data/nodes'

const mk = (id: number, x = 0) => ({
  id, page: 0, x, y: 1, w: 2, h: 3, type: NodeType.Line, parent: -1, order: id,
})

describe('NodeArrays', () => {
  it('stores and reads back a node', () => {
    const a = createNodeArrays(4)
    const i = pushNode(a, mk(7, 10))
    expect(i).toBe(0)
    expect(a.count).toBe(1)
    const out = new Float32Array(4)
    getRect(a, i, out)
    expect(Array.from(out)).toEqual([10, 1, 2, 3])
    expect(a.ids[0]).toBe(7)
  })

  it('grows past initial capacity preserving contents', () => {
    const a = createNodeArrays(2)
    for (let n = 0; n < 10; n++) pushNode(a, mk(n, n))
    expect(a.count).toBe(10)
    expect(a.capacity).toBeGreaterThanOrEqual(10)
    const out = new Float32Array(4)
    getRect(a, 9, out)
    expect(out[0]).toBe(9)
    expect(a.ids[9]).toBe(9)
  })

  it('finds an index by id and returns -1 when absent', () => {
    const a = createNodeArrays(4)
    pushNode(a, mk(100)); pushNode(a, mk(200))
    expect(indexOfId(a, 200)).toBe(1)
    expect(indexOfId(a, 999)).toBe(-1)
  })

  it('getRect allocates nothing (reuses the out array)', () => {
    const a = createNodeArrays(2)
    pushNode(a, mk(1))
    const out = new Float32Array(4)
    getRect(a, 0, out)
    const same = out
    getRect(a, 0, out)
    expect(out).toBe(same)
  })

  it('flags are independent bits', () => {
    const a = createNodeArrays(2)
    const i = pushNode(a, mk(1))
    a.flags[i] |= FLAG_DIRTY
    expect(a.flags[i] & FLAG_DIRTY).toBeTruthy()
  })
})
