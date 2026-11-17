import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { UpdateChannel, UpdateSource } from '../core/models'
import { platform } from './platform'

/**
 * 应用内更新：版本比较、发行版查询、资产名约定、下载源与测速。
 *
 * 发行包的命名由 .github/workflows/release.yml 保证：
 *   Collecout-<版本>-<平台>-<架构>.zip
 * 平台 windows / macos / android，架构 x64 / arm64 / universal。
 * 检查更新只按名字找资产，所以这个名字是前后端唯一的契约。
 */

export const REPO = 'MogroWangStudio/Collecout'

/** GitHub 加速代理前缀：拼在完整的 GitHub 下载地址前面 */
export const PROXY_PREFIX = 'https://ghproxy.net/'

const API = `https://api.github.com/repos/${REPO}`
const PROGRESS_EVENT = 'update:progress'

export type UpdatePlatform = 'windows' | 'macos' | 'android' | 'linux'

export interface ReleaseAsset {
  name: string
  size: number
  url: string
}

export interface ReleaseInfo {
  version: string
  tag: string
  notes: string
  publishedAt: string
  prerelease: boolean
  htmlUrl: string
  asset: ReleaseAsset | null
}

export interface SpeedResult {
  bytes: number
  millis: number
  bps: number
}

interface ApiAsset {
  name: string
  size: number
  browser_download_url: string
}

interface ApiRelease {
  tag_name: string
  name: string | null
  body: string | null
  published_at: string | null
  prerelease: boolean
  draft: boolean
  html_url: string
  assets: ApiAsset[]
}

/* ---------- 版本号 ---------- */

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** 预发布标识段，如 beta1 → ['beta', 1] */
  pre: (string | number)[]
}

export function parseVersion(raw: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    // beta1 这类写法没有点分隔，按「字母段 / 数字段」拆开，beta10 才会排在 beta9 之后
    pre: m[4] ? m[4].split('.').flatMap(splitIdentifier) : [],
  }
}

function splitIdentifier(segment: string): (string | number)[] {
  const parts = segment.match(/\d+|[^\d]+/g) ?? [segment]
  return parts.map((p) => (/^\d+$/.test(p) ? Number(p) : p))
}

/**
 * semver 比较：主次修订之后比预发布标识。
 * 没有预发布标识的版本更高（1.5.0 > 1.5.0-beta1）；数字标识比字母标识低（beta1 < beta2）。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key]
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1
  const len = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

/* ---------- 平台与资产 ---------- */

export function targetPlatform(): UpdatePlatform {
  if (platform() === 'capacitor') return 'android'
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Android/i.test(ua)) return 'android'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos'
  if (/Windows/i.test(ua)) return 'windows'
  return 'linux'
}

/** 发布矩阵只有 Windows x64、macOS arm64 与安卓通用包 */
export function targetArch(): string {
  switch (targetPlatform()) {
    case 'macos':
      return 'arm64'
    case 'android':
      return 'universal'
    default:
      return 'x64'
  }
}

export function assetName(version: string, p: UpdatePlatform, arch: string): string {
  return `Collecout-${version}-${p}-${arch}.zip`
}

function pickAsset(release: ApiRelease, version: string): ReleaseAsset | null {
  const p = targetPlatform()
  const arch = targetArch()
  const expected = assetName(version, p, arch)
  const found =
    release.assets.find((a) => a.name === expected) ??
    release.assets.find((a) => a.name.includes(`-${p}-${arch}`)) ??
    release.assets.find((a) => a.name.includes(`-${p}-`)) ??
    null
  if (!found) return null
  return { name: found.name, size: found.size, url: found.browser_download_url }
}

export function resolveDownloadUrl(url: string, source: UpdateSource): string {
  if (source !== 'ghproxy') return url
  return url.startsWith('http') ? `${PROXY_PREFIX}${url}` : url
}

/* ---------- 查询 ---------- */

async function getJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    })
    // 仓库还没有任何发布版本
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/** 去掉 Markdown 记号，只留可读正文（发行说明是纯展示，不渲染 HTML） */
function plainNotes(body: string | null): string {
  if (!body) return ''
  return body
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 900)
}

/**
 * 查询当前通道是否有比 current 更新的版本。
 * 稳定通道看 /releases/latest（GitHub 已排除预发布）；测试通道拉列表按版本号取最大，
 * 这样预发布比正式版新时能拿到预发布，正式版反超时也能正常收到正式版。
 */
export async function checkForUpdate(channel: UpdateChannel, current: string): Promise<ReleaseInfo | null> {
  let releases: ApiRelease[]
  if (channel === 'stable') {
    const latest = await getJson<ApiRelease>(`${API}/releases/latest`)
    releases = latest ? [latest] : []
  } else {
    releases = (await getJson<ApiRelease[]>(`${API}/releases?per_page=30`)) ?? []
  }
  releases = releases.filter((r) => !r.draft)

  let best: ApiRelease | null = null
  let bestVersion = ''
  for (const r of releases) {
    const v = r.tag_name.replace(/^v/i, '')
    if (!parseVersion(v)) continue
    if (!best || compareVersions(v, bestVersion) > 0) {
      best = r
      bestVersion = v
    }
  }
  if (!best) return null
  if (compareVersions(bestVersion, current) <= 0) return null

  return {
    version: bestVersion,
    tag: best.tag_name,
    notes: plainNotes(best.body),
    publishedAt: best.published_at ?? '',
    prerelease: best.prerelease,
    htmlUrl: best.html_url,
    asset: pickAsset(best, bestVersion),
  }
}

/**
 * 测速用的目标地址：优先当前发现的新版本包，其次最新正式版的包，
 * 都没有时退回仓库里的变更日志（够小，但足以分辨两个源是否连得上）。
 */
export async function probeTargetUrl(preferred?: string | null): Promise<string> {
  if (preferred) return preferred
  const latest = await getJson<ApiRelease>(`${API}/releases/latest`)
  if (latest) {
    const asset = latest.assets.find((a) => a.name.includes(`-${targetPlatform()}-`))
    if (asset) return asset.browser_download_url
  }
  return `https://raw.githubusercontent.com/${REPO}/main/CHANGELOG.md`
}

/* ---------- 桌面端原生能力 ---------- */

export async function probeSpeed(url: string): Promise<SpeedResult> {
  return invoke<SpeedResult>('probe_speed', { url })
}

export async function downloadUpdate(
  url: string,
  fileName: string,
  onProgress: (received: number, total: number) => void,
): Promise<string> {
  const unlisten = await listen<{ received: number; total: number }>(PROGRESS_EVENT, (event) => {
    onProgress(event.payload.received, event.payload.total)
  })
  try {
    return await invoke<string>('download_update', { url, fileName })
  } finally {
    unlisten()
  }
}

export async function cancelDownload(): Promise<void> {
  await invoke('cancel_download')
}

export async function installUpdate(archive: string): Promise<void> {
  await invoke('install_update', { archive })
}

export async function quitApp(): Promise<void> {
  await invoke('quit_app')
}

/* ---------- 展示格式 ---------- */

export function formatBytes(n: number): string {
  if (!n) return '—'
  const mb = n / 1048576
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

export function formatSpeed(bps: number): string {
  if (!bps) return '—'
  if (bps >= 1048576) return `${(bps / 1048576).toFixed(1)} MB/s`
  return `${Math.max(1, Math.round(bps / 1024))} KB/s`
}

export function formatDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
