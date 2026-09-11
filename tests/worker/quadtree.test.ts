// tests/worker/quadtree.test.ts
import { describe, it, expect } from 'vitest'
import { QuadTree } from '@/worker/quadtree'

const BOUNDS = { x: 0, y: 0, w: 10000, h: 100000 }

function makeRects(n: number, seed = 1) {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const ids = new Uint32Array(n)
  const coords = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    ids[i] = i + 1
    coords[i * 4] = rnd() * 9800
    coords[i * 4 + 1] = rnd() * 99000
    coords[i * 4 + 2] = 5 + rnd() * 180
    coords[i * 4 + 3] = 5 + rnd() * 40
  }
  return { ids, coords }
}

const bruteRect = (ids: Uint32Array, c: Float32Array, n: number, x: number, y: number, w: number, h: number) => {
  const r: number[] = []
  for (let i = 0; i < n; i++) {
    const [bx, by, bw, bh] = [c[i*4], c[i*4+1], c[i*4+2], c[i*4+3]]
    if (bx < x + w && bx + bw > x && by < y + h && by + bh > y) r.push(ids[i])
  }
  return r.sort((a, b) => a - b)
}

const brutePoint = (ids: Uint32Array, c: Float32Array, n: number, x: number, y: number) => {
  const r: number[] = []
  for (let i = 0; i < n; i++) {
    const [bx, by, bw, bh] = [c[i*4], c[i*4+1], c[i*4+2], c[i*4+3]]
    if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) r.push(ids[i])
  }
  return r.sort((a, b) => a - b)
}

describe('QuadTree', () => {
  it('matches brute force on rect queries', () => {
    const n = 3000
    const { ids, coords } = makeRects(n)
    const qt = new QuadTree(BOUNDS)
    qt.bulkLoad(ids, coords, n)
    for (const q of [[0,0,500,500],[4000,50000,1200,900],[0,0,10000,100000],[9990,99990,5,5]]) {
      const got = qt.queryRect(q[0], q[1], q[2], q[3], []).slice().sort((a,b)=>a-b)
      expect(got).toEqual(bruteRect(ids, coords, n, q[0], q[1], q[2], q[3]))
    }
  })

  it('matches brute force on point queries', () => {
    const n = 2000
    const { ids, coords } = makeRects(n, 9)
    const qt = new QuadTree(BOUNDS)
    qt.bulkLoad(ids, coords, n)
    for (let t = 0; t < 200; t++) {
      const x = (t * 137) % 10000, y = (t * 4409) % 100000
      const got = qt.queryPoint(x, y, []).slice().sort((a,b)=>a-b)
      expect(got).toEqual(brutePoint(ids, coords, n, x, y))
    }
  })

  it('supports incremental insert matching bulk load', () => {
    const n = 800
    const { ids, coords } = makeRects(n, 3)
    const bulk = new QuadTree(BOUNDS); bulk.bulkLoad(ids, coords, n)
    const inc = new QuadTree(BOUNDS)
    for (let i = 0; i < n; i++) inc.insert(ids[i], coords[i*4], coords[i*4+1], coords[i*4+2], coords[i*4+3])
    const a = bulk.queryRect(100, 100, 3000, 3000, []).sort((x,y)=>x-y)
    const b = inc.queryRect(100, 100, 3000, 3000, []).sort((x,y)=>x-y)
    expect(b).toEqual(a)
  })

  it('removes and updates', () => {
    const qt = new QuadTree(BOUNDS)
    qt.insert(1, 10, 10, 20, 20)
    expect(qt.queryPoint(15, 15, [])).toContain(1)
    qt.update(1, 10, 10, 20, 20, 500, 500, 20, 20)
    expect(qt.queryPoint(15, 15, [])).not.toContain(1)
    expect(qt.queryPoint(505, 505, [])).toContain(1)
    expect(qt.remove(1, 500, 500, 20, 20)).toBe(true)
    expect(qt.size).toBe(0)
  })

  it('answers 10k-node point queries in well under 2ms', () => {
    const n = 10000
    const { ids, coords } = makeRects(n, 5)
    const qt = new QuadTree(BOUNDS)
    qt.bulkLoad(ids, coords, n)
    const out: number[] = []
    const t0 = performance.now()
    for (let i = 0; i < 1000; i++) qt.queryPoint((i * 977) % 10000, (i * 3571) % 100000, out)
    const perQuery = (performance.now() - t0) / 1000
    expect(perQuery).toBeLessThan(0.5)
  })

  it('clear empties the tree', () => {
    const qt = new QuadTree(BOUNDS)
    qt.insert(1, 0, 0, 5, 5); qt.clear()
    expect(qt.size).toBe(0)
    expect(qt.queryPoint(1, 1, [])).toEqual([])
  })
})
