/**
 * 生成演示用 Excel 示例（零依赖手写 stored ZIP + OOXML，与 src/core/export 的思路一致）：
 * - 商品图鉴.xlsx：「商品列表」工作表每行一张浮动图片（oneCellAnchor），
 *   「缩略图」工作表用 Excel 365 式「嵌入单元格」图片（vm + richValue），
 *   演示两条图片提取路径与筛选用的类别 / 数值 / 日期数据。
 * - 阅读清单.xlsx：两个工作表（2025 / 2026），列名对齐内置「读书笔记」模板，
 *   演示模板匹配与多工作表选择。
 * 运行：node scripts/make-demo-xlsx.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'samples')
mkdirSync(dir, { recursive: true })

/* ---------------- 最小 ZIP 写入器（仅 stored，与项目导出器一致） ---------------- */

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** files: [name, Buffer][] → stored ZIP 的 Buffer */
function zipStore(files) {
  const enc = new TextEncoder()
  const local = []
  const central = []
  let offset = 0
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1
  for (const [name, data] of files) {
    const nameBytes = enc.encode(name)
    const crc = crc32(data)
    const l = Buffer.alloc(30)
    l.writeUInt32LE(0x04034b50, 0)
    l.writeUInt16LE(20, 4)
    l.writeUInt16LE(0, 6)
    l.writeUInt16LE(0, 8) // stored
    l.writeUInt16LE(0, 10)
    l.writeUInt16LE(DOS_DATE, 12)
    l.writeUInt32LE(crc, 14)
    l.writeUInt32LE(data.length, 18)
    l.writeUInt32LE(data.length, 22)
    l.writeUInt16LE(nameBytes.length, 26)
    l.writeUInt16LE(0, 28)
    local.push(l, nameBytes, data)

    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(0, 8)
    c.writeUInt16LE(0, 10)
    c.writeUInt16LE(0, 12)
    c.writeUInt16LE(DOS_DATE, 14)
    c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(data.length, 20)
    c.writeUInt32LE(data.length, 24)
    c.writeUInt16LE(nameBytes.length, 28)
    c.writeUInt16LE(0, 30)
    c.writeUInt16LE(0, 32)
    c.writeUInt16LE(0, 34)
    c.writeUInt16LE(0, 36)
    c.writeUInt32LE(0, 38)
    c.writeUInt32LE(offset, 42)
    central.push(c, nameBytes)

    offset += 30 + nameBytes.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...local, centralBuf, eocd])
}

/* ---------------- 最小 PNG 写入器（8 位 RGB） ---------------- */

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32LE(data.length, 0)
  const head = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32LE(crc32(Buffer.concat([head, data])), 0)
  return Buffer.concat([len, head, data, crc])
}

/** fn(x, y) → [r, g, b]，生成 size × size 的 PNG */
function makePng(size, fn) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  const raw = Buffer.alloc(size * (size * 3 + 1))
  let p = 0
  for (let y = 0; y < size; y++) {
    raw[p++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = fn(x, y)
      raw[p++] = r
      raw[p++] = g
      raw[p++] = b
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function hex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
}

/** 每个商品一张 128×128 的抽象「产品图」：底座 + 斜带 + 圆，配色随序号变化 */
function makeProductPng(i) {
  const [bg, main, deep] = PALETTES[i % PALETTES.length]
  const [br, bg_, bb] = hex(bg)
  const [mr, mg, mb] = hex(main)
  const [dr, dg, db] = hex(deep)
  const radius = 24 + (i % 3) * 4
  return makePng(128, (x, y) => {
    if (y > 104) return [dr, dg, db] // 底座
    if (Math.abs(x - y + 76) < 6) return [mr, mg, mb] // 斜带
    const dx = x - 64
    const dy = y - 54
    const d2 = dx * dx + dy * dy
    if (d2 < radius * radius) return [mr, mg, mb] // 主体圆
    if (d2 < (radius - 12) * (radius - 12)) return [dr, dg, db] // 内芯
    return [br, bg_, bb]
  })
}

const PALETTES = [
  ['#e8f0e9', '#2f6f4f', '#1c4a33'],
  ['#f5efe6', '#b0713a', '#7a4a22'],
  ['#e9eef5', '#3a6ea5', '#25476b'],
  ['#f6e9ec', '#a54868', '#6e2c44'],
  ['#efeaf6', '#6a4fa3', '#472f70'],
  ['#e6f2f1', '#2e8b81', '#1d5c55'],
  ['#f4f1e4', '#8f8a3a', '#5c5922'],
  ['#f0e8e0', '#8a5a3b', '#5a3a24'],
]

/* ---------------- OOXML 组装 ---------------- */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const colLetter = (n) => {
  let s = ''
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

const cellS = (row, col, text) =>
  `<c r="${colLetter(col)}${row}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`
const cellN = (row, col, n) => `<c r="${colLetter(col)}${row}"><v>${n}</v></c>`
/** 嵌入单元格图片的占位单元格（vm = cellMetadata 里第 N 个 bk，1 起始） */
const cellVM = (row, col, vm) => `<c r="${colLetter(col)}${row}" vm="${vm}"/>`

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

function sheetXml(rowXml, { drawing = false, firstColWidth = null } = {}) {
  const cols = firstColWidth
    ? `<cols><col min="1" max="1" width="${firstColWidth}" customWidth="1"/></cols>`
    : ''
  return (
    XML_DECL +
    `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}">` +
    cols +
    `<sheetData>${rowXml}</sheetData>` +
    (drawing ? `<drawing r:id="rId1"/>` : '') +
    `</worksheet>`
  )
}

function relsXml(rels) {
  return (
    XML_DECL +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    rels
      .map(
        ([id, type, target]) =>
          `<Relationship Id="${id}" Type="${NS_R}/${type}" Target="${target}"/>`,
      )
      .join('') +
    `</Relationships>`
  )
}

/** 构造一本两工作表、8 行 8 图的商品图鉴 */
function buildProductWorkbook() {
  const headers = ['图片', '名称', '类别', '单价', '库存', '入库日期', '备注']
  const products = [
    ['无线机械键盘', '数码', 329, 12, '2026-07-02', '青轴，白光背光'],
    ['陶瓷马克杯', '家居', 39.9, 40, '2026-07-15', '月白釉，380ml'],
    ['直杆长柄伞', '日用', 45, 25, '2026-07-20', '防风骨架'],
    ['桌面置物架', '家居', 89, 18, '2026-08-11', '两层，白橡木纹'],
    ['线装笔记本', '文具', 18.5, 120, '2026-08-19', 'A5 点阵内页'],
    ['蓝牙耳机', '数码', 249, 30, '2026-09-01', '主动降噪'],
    ['折叠露营椅', '户外', 159, 9, '2026-09-15', '铝合金骨架'],
    ['保温随行杯', '日用', 99, 22, '2026-09-28', ''],
  ]
  const N = products.length
  const media = products.map((_, i) => [`xl/media/image${i + 1}.png`, makeProductPng(i)])

  // 工作表 1：浮动图片锚在 A 列；工作表 2：A 列单元格嵌入图片
  const row1 = (r, ht) =>
    `<row r="${r}"${ht ? ' ht="60" customHeight="1"' : ''}>` +
    cellS(r, 0, '图片') +
    headers.slice(1).map((h, i) => cellS(r, i + 1, h)).join('') +
    `</row>`
  const sheet1Rows = [
    row1(1, false),
    ...products.map((p, i) => {
      const r = i + 2
      return (
        `<row r="${r}" ht="60" customHeight="1">` +
        `<c r="A${r}"/>` +
        cellS(r, 1, p[0]) +
        cellS(r, 2, p[1]) +
        cellN(r, 3, p[2]) +
        cellN(r, 4, p[3]) +
        cellS(r, 5, p[4]) +
        (p[5] ? cellS(r, 6, p[5]) : `<c r="G${r}"/>`) +
        `</row>`
      )
    }),
  ]
  const sheet2Rows = [
    row1(1, false),
    ...products.map((p, i) => {
      const r = i + 2
      return (
        `<row r="${r}" ht="60" customHeight="1">` +
        cellVM(r, 0, i + 1) +
        cellS(r, 1, p[0]) +
        cellS(r, 2, p[1]) +
        cellN(r, 3, p[2]) +
        cellN(r, 4, p[3]) +
        cellS(r, 5, p[4]) +
        (p[5] ? cellS(r, 6, p[5]) : `<c r="G${r}"/>`) +
        `</row>`
      )
    }),
  ]

  // drawing1.xml：8 个 oneCellAnchor，from = A2..A9
  const EMU = 762000 // 80px
  const anchors = products
    .map(
      (_, i) =>
        `<xdr:oneCellAnchor>` +
        `<xdr:from><xdr:col>0</xdr:col><xdr:colOff>19050</xdr:colOff>` +
        `<xdr:row>${i + 1}</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:from>` +
        `<xdr:ext cx="${EMU}" cy="${EMU}"/>` +
        `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="图片 ${i + 1}"/>` +
        `<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>` +
        `<xdr:blipFill><a:blip r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
        `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${EMU}" cy="${EMU}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>` +
        `<xdr:clientData/></xdr:oneCellAnchor>`,
    )
    .join('')
  const drawing = (
    XML_DECL +
    `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS_R}">` +
    anchors +
    `</xdr:wsDr>`
  )
  const drawingRels = relsXml(
    products.map((_, i) => [`rId${i + 1}`, 'image', `../media/image${i + 1}.png`]),
  )

  // richValue 三件套：metadata → rdrichvalue → richValueRel → media
  // 写成 Excel 365 真实的两段式：futureMetadata 的 bk 用 xlrd:rvb 记 rich value 序号，
  // valueMetadata 的 bk 用 rc@t/v 指回 futureMetadata（单元格 vm 指的是这份）
  const NS_XLRD = 'http://schemas.microsoft.com/office/spreadsheetml/2017/richdata'
  const metadata =
    XML_DECL +
    `<metadata xmlns="${NS_MAIN}" xmlns:xlrd="${NS_XLRD}" count="${N}">` +
    `<metadataTypes count="1"><metadataType name="XLRICHVALUE" minSupportedVersion="120000" copy="1"/></metadataTypes>` +
    `<futureMetadata name="XLRICHVALUE" count="${N}">` +
    products
      .map(
        (_, i) =>
          `<bk><extLst><ext uri="{3e2802c4-18d2-4a3d-9f5e-1a2b3c4d5e6f}"><xlrd:rvb i="${i}"/></ext></extLst></bk>`,
      )
      .join('') +
    `</futureMetadata>` +
    `<valueMetadata count="${N}">` +
    products.map((_, i) => `<bk><rc t="1" v="${i}"/></bk>`).join('') +
    `</valueMetadata></metadata>`
  const NS_RD = 'http://schemas.microsoft.com/office/spreadsheetml/2017/richdata'
  const rdrichvalue =
    XML_DECL +
    `<rd:richValueData xmlns:rd="${NS_RD}" count="${N}">` +
    products.map((_, i) => `<rd:rv s="0"><rd:v>${i}</rd:v><rd:v>5</rd:v></rd:rv>`).join('') +
    `</rd:richValueData>`
  const rdrichvaluestructure =
    XML_DECL +
    `<rd:richValueStructures xmlns:rd="${NS_RD}" count="1">` +
    `<rd:s t="_localImage" count="2"><rd:k n="_rvRel:LocalImageIdentifier" t="i"/>` +
    `<rd:k n="CalcOrigin" t="i"/></rd:s>` +
    `</rd:richValueStructures>`
  const NS_RVR = 'http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel'
  const richValueRel =
    XML_DECL +
    `<richValueRels xmlns="${NS_RVR}" xmlns:r="${NS_R}" count="${N}">` +
    products.map((_, i) => `<rel r:id="rId${i + 1}"/>`).join('') +
    `</richValueRels>`
  const richValueRelsRels = relsXml(
    products.map((_, i) => [`rId${i + 1}`, 'image', `../media/image${i + 1}.png`]),
  )

  const workbook =
    XML_DECL +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><sheets>` +
    `<sheet name="商品列表" sheetId="1" r:id="rId1"/>` +
    `<sheet name="缩略图" sheetId="2" r:id="rId2"/>` +
    `</sheets></workbook>`
  const workbookRels = relsXml([
    ['rId1', 'worksheet', 'worksheets/sheet1.xml'],
    ['rId2', 'worksheet', 'worksheets/sheet2.xml'],
    ['rId3', 'styles', 'styles.xml'],
  ])
  const styles =
    XML_DECL +
    `<styleSheet xmlns="${NS_MAIN}"><fonts count="1"><font><sz val="11"/>` +
    `<name val="Calibri"/></font></fonts><fills count="1">` +
    `<fill><patternFill patternType="none"/></fill></fills>` +
    `<borders count="1"><border/></borders>` +
    `<cellStyleXfs count="1"><xf/></cellStyleXfs>` +
    `<cellXfs count="1"><xf/></cellXfs></styleSheet>`
  const contentTypes =
    XML_DECL +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="png" ContentType="image/png"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` +
    `<Override PartName="/xl/metadata.xml" ContentType="application/vnd.ms-excel.metadata"/>` +
    `<Override PartName="/xl/richData/rdrichvalue.xml" ContentType="application/vnd.ms-excel.richdata.richvaluedata"/>` +
    `<Override PartName="/xl/richData/rdrichvaluestructure.xml" ContentType="application/vnd.ms-excel.richdata.richvaluestructure"/>` +
    `<Override PartName="/xl/richData/richValueRel.xml" ContentType="application/vnd.ms-excel.richdata.richvaluerelationships"/>` +
    `</Types>`
  const rootRels = relsXml([
    ['rId1', 'officeDocument', 'xl/workbook.xml'],
  ])

  const files = [
    ['[Content_Types].xml', Buffer.from(contentTypes)],
    ['_rels/.rels', Buffer.from(rootRels)],
    ['xl/workbook.xml', Buffer.from(workbook)],
    ['xl/_rels/workbook.xml.rels', Buffer.from(workbookRels)],
    ['xl/styles.xml', Buffer.from(styles)],
    ['xl/worksheets/sheet1.xml', Buffer.from(sheetXml(sheet1Rows.join(''), { drawing: true, firstColWidth: 15 }))],
    ['xl/worksheets/_rels/sheet1.xml.rels', Buffer.from(relsXml([['rId1', 'drawing', '../drawings/drawing1.xml']]))],
    ['xl/worksheets/sheet2.xml', Buffer.from(sheetXml(sheet2Rows.join(''), { firstColWidth: 15 }))],
    ['xl/drawings/drawing1.xml', Buffer.from(drawing)],
    ['xl/drawings/_rels/drawing1.xml.rels', Buffer.from(drawingRels)],
    ['xl/metadata.xml', Buffer.from(metadata)],
    ['xl/richData/rdrichvalue.xml', Buffer.from(rdrichvalue)],
    ['xl/richData/rdrichvaluestructure.xml', Buffer.from(rdrichvaluestructure)],
    ['xl/richData/richValueRel.xml', Buffer.from(richValueRel)],
    ['xl/richData/_rels/richValueRel.xml.rels', Buffer.from(richValueRelsRels)],
    ...media,
  ]
  return zipStore(files)
}

/** 构造两工作表的阅读清单（列名对齐内置「读书笔记」模板） */
function buildReadingWorkbook() {
  const headers = ['书名', '作者', '日期', '类型', '评分', '摘要', '摘录']
  const byYear = {
    2025: [
      ['《活着》', '余华', '2025-02-14', '小说', 9.5, '苦难里也要活下去的韧性。', '人是为活着本身而活着的，而不是为了活着之外的任何事物所活着。'],
      ['《置身事内》', '兰小欢', '2025-03-30', '经济', 9, '理解中国政府与经济的入门读本。', '土地财政的本质是抵押未来收入。'],
      ['《人类简史》', '尤瓦尔·赫拉利', '2025-05-21', '历史', 8.5, '从认知革命讲到科技时代的宏大叙事。', '虚构故事是人类大规模协作的基础。'],
      ['《围城》', '钱锺书', '2025-08-09', '小说', 9, '婚姻内外皆是围城，比喻辛辣。', '城外的人想冲进去，城里的人想逃出来。'],
      ['《小王子》', '圣埃克苏佩里', '2025-10-02', '文学', 8.5, '写给大人的童话。', '真正重要的东西，用眼睛是看不见的。'],
    ],
    2026: [
      ['《三体》', '刘慈欣', '2026-01-18', '科幻', 10, '黑暗森林法则的震撼设定。', '宇宙就是一座黑暗森林。'],
      ['《被讨厌的勇气》', '岸见一郎 / 古贺史健', '2026-03-05', '心理', 8.5, '阿德勒心理学的对话体入门。', '一切烦恼都来自人际关系。'],
      ['《纳瓦尔宝典》', '埃里克·乔根森', '2026-05-12', '商业', 8, '财富与幸福的底层逻辑。', '把自己产品化。'],
      ['《哥德尔、艾舍尔、巴赫》', '侯世达', '2026-08-20', '科普', 9, '人工智能与自指结构的奇书。', '怪圈是系统理解自身的必经之路。'],
    ],
  }
  const years = Object.keys(byYear)
  const workbook =
    XML_DECL +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><sheets>` +
    years.map((y, i) => `<sheet name="${y}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    `</sheets></workbook>`
  const workbookRels = relsXml([
    ...years.map((_, i) => [`rId${i + 1}`, 'worksheet', `worksheets/sheet${i + 1}.xml`]),
    [`rId${years.length + 1}`, 'styles', 'styles.xml'],
  ])
  const styles =
    XML_DECL +
    `<styleSheet xmlns="${NS_MAIN}"><fonts count="1"><font><sz val="11"/>` +
    `<name val="Calibri"/></font></fonts><fills count="1">` +
    `<fill><patternFill patternType="none"/></fill></fills>` +
    `<borders count="1"><border/></borders>` +
    `<cellStyleXfs count="1"><xf/></cellStyleXfs>` +
    `<cellXfs count="1"><xf/></cellXfs></styleSheet>`
  const contentTypes =
    XML_DECL +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    years
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`
  const rootRels = relsXml([['rId1', 'officeDocument', 'xl/workbook.xml']])

  const files = [
    ['[Content_Types].xml', Buffer.from(contentTypes)],
    ['_rels/.rels', Buffer.from(rootRels)],
    ['xl/workbook.xml', Buffer.from(workbook)],
    ['xl/_rels/workbook.xml.rels', Buffer.from(workbookRels)],
    ['xl/styles.xml', Buffer.from(styles)],
  ]
  years.forEach((y, i) => {
    const rows = [
      `<row r="1">${headers.map((h, c) => cellS(1, c, h)).join('')}</row>`,
      ...byYear[y].map((b, ri) => {
        const r = ri + 2
        return (
          `<row r="${r}">` +
          cellS(r, 0, b[0]) +
          cellS(r, 1, b[1]) +
          cellS(r, 2, b[2]) +
          cellS(r, 3, b[3]) +
          cellN(r, 4, b[4]) +
          cellS(r, 5, b[5]) +
          cellS(r, 6, b[6]) +
          `</row>`
        )
      }),
    ]
    files.push([`xl/worksheets/sheet${i + 1}.xml`, Buffer.from(sheetXml(rows.join('')))])
  })
  return zipStore(files)
}

/* ---------------- 落盘 ---------------- */

writeFileSync(join(dir, '商品图鉴.xlsx'), buildProductWorkbook())
writeFileSync(join(dir, '阅读清单.xlsx'), buildReadingWorkbook())
console.log('已生成 samples/ 下的演示文件：商品图鉴.xlsx（浮动图片 + 嵌入单元格图片）、阅读清单.xlsx（两工作表）')
