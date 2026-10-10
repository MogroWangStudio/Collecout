// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSheet } from './xlsx'

/** 仓库里的演示样例（由 npm run samples:demo 生成），按真实 Excel 写出 */
function sample(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(process.cwd(), 'samples', name)))
}

describe('samples/ 演示文件与图片提取的契约', () => {
  it('商品图鉴.xlsx：浮动图片与嵌入单元格图片各 8 张，逐格对应且内容互不相同', async () => {
    const doc = await parseSheet(sample('商品图鉴.xlsx'), '商品图鉴.xlsx')
    const sheets = doc.blocks.flatMap((b) => (b.type === 'table' ? [b.source ?? ''] : []))
    expect(sheets).toEqual(['商品列表', '缩略图'])
    const names = Array.from({ length: 8 }, (_, i) => `image${i + 1}.png`)
    for (const sheet of sheets) {
      const images = (doc.images ?? []).filter((img) => img.sheet === sheet)
      expect(images.map((img) => img.name)).toEqual(names)
      expect(images.map((img) => img.row)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(images.map((img) => img.col)).toEqual(Array(8).fill(0))
      // 同一张图的字节不得被复用到别的单元格上
      expect(new Set(images.map((img) => Array.from(img.bytes).join(','))).size).toBe(8)
    }
  })
})
