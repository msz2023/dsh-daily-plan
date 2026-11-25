/**
 * Daily plan: completed-task export.
 *
 * Builds one Markdown table or one minimal .xlsx workbook from the finished
 * tasks. No dependencies: the workbook is assembled from the OOXML parts and
 * packed into a ZIP with node:zlib (the same constraint as the rest of the
 * bundle). Column labels follow the requested language.
 */

import { deflateRawSync } from 'node:zlib'

const LABELS = {
  zh: {
    sheet: '已完成记录',
    title: '每日任务 · 已完成记录',
    generated: '生成时间',
    total: '共 {n} 条',
    completedAt: '完成时间',
    titleCol: '任务',
    note: '备注',
    due: '截止时间',
    priority: '优先级',
    repeat: '重复',
    priorities: { normal: '普通', high: '重要', low: '次要' },
    repeats: { none: '不重复', daily: '每天', weekdays: '工作日', weekly: '每周', monthly: '每月' },
  },
  en: {
    sheet: 'Completed',
    title: 'Daily plan · completed tasks',
    generated: 'Generated',
    total: '{n} items',
    completedAt: 'Completed at',
    titleCol: 'Task',
    note: 'Note',
    due: 'Due',
    priority: 'Priority',
    repeat: 'Repeat',
    priorities: { normal: 'Normal', high: 'Important', low: 'Minor' },
    repeats: { none: 'No repeat', daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', monthly: 'Monthly' },
  },
}

export function labelsFor(lang) {
  return String(lang || '').toLowerCase().startsWith('en') ? LABELS.en : LABELS.zh
}

function pad(value) {
  return String(value).padStart(2, '0')
}

/** "2026-11-25 22:03" in the host's local time; empty for a missing stamp. */
export function formatStamp(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Finished tasks inside [from, to) by completion time, newest first. */
export function completedTasks(tasks, from = 0, to = Number.MAX_SAFE_INTEGER) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter(task => task && task.done === true)
    .filter(task => {
      const at = task.completedAt
      return Number.isFinite(at) && at >= from && at < to
    })
    .sort((a, b) => b.completedAt - a.completedAt)
}

/** One row per task; also the shape both exporters share. */
export function rowsOf(tasks, labels) {
  return tasks.map(task => [
    formatStamp(task.completedAt),
    task.title || '',
    task.note || '',
    task.due ? formatStamp(Date.parse(task.due)) : '',
    labels.priorities[task.priority] || labels.priorities.normal,
    labels.repeats[task.repeat] || labels.repeats.none,
  ])
}

export function renderMarkdown(tasks, { lang = 'zh', now = Date.now() } = {}) {
  const labels = labelsFor(lang)
  const rows = rowsOf(completedTasks(tasks), labels)
  const cell = value => String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const header = [labels.completedAt, labels.titleCol, labels.note, labels.due, labels.priority, labels.repeat]
  const lines = [
    `# ${labels.title}`,
    '',
    `${labels.generated}：${formatStamp(now)} · ${labels.total.replace('{n}', String(rows.length))}`,
    '',
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ]
  for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`)
  return `${lines.join('\n')}\n`
}

/* ------------------------------------------------------------------ *
 * Minimal .xlsx (OOXML) writer: one sheet, inline strings, no styles
 * beyond a bold header row.
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** DOS timestamp for the archive entries (fixed, so the file is reproducible). */
const DOS_TIME = 0
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1

/** A stored/deflated ZIP archive; enough for an OOXML package. */
function createZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8')
    const deflated = deflateRawSync(data)
    const usable = deflated.length < data.length
    const body = usable ? deflated : data
    const method = usable ? 8 : 0
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, ...centrals, end])
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function columnName(index) {
  let name = ''
  let value = index + 1
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

function sheetXml(rows) {
  const widths = [20, 30, 36, 20, 10, 12]
  const cols = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const ref = `${columnName(columnIndex)}${rowIndex + 1}`
      const style = rowIndex === 0 ? ' s="1"' : ''
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
    }).join('')
    return `<row r="${rowIndex + 1}">${cells}</row>`
  }).join('')
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + `<cols>${cols}</cols>`
    + `<sheetData>${body}</sheetData>`
    + '</worksheet>'
}

const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>'

/** One .xlsx workbook with the completed tasks; returns a Buffer. */
export function renderXlsx(tasks, { lang = 'zh', now = Date.now() } = {}) {
  const labels = labelsFor(lang)
  const rows = rowsOf(completedTasks(tasks), labels)
  const header = [labels.completedAt, labels.titleCol, labels.note, labels.due, labels.priority, labels.repeat]
  const sheet = sheetXml([header, ...rows])
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets><sheet name="${escapeXml(labels.sheet)}" sheetId="1" r:id="rId1"/></sheets>`
    + '<definedNames/></workbook>'
  const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '</Relationships>'
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '</Types>'
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>'
  return createZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
    { name: 'xl/styles.xml', data: STYLES_XML },
  ])
}
