export type Platform = 'tauri' | 'capacitor' | 'web'

export function platform(): Platform {
  if (typeof window === 'undefined') return 'web'
  if ('__TAURI_INTERNALS__' in window) return 'tauri'
  const cap = (window as unknown as Record<string, unknown>).Capacitor as { isNativePlatform?: () => boolean } | undefined
  if (cap?.isNativePlatform?.()) return 'capacitor'
  return 'web'
}

export function isDesktop(): boolean {
  return platform() === 'tauri'
}

/** 桌面端区分 macOS：UA 含 Macintosh（Tauri WebView 报告宿主系统）。
 *  macOS 用系统原生标题栏（红绿灯 + 系统级圆角），见 src-tauri/tauri.macos.conf.json。 */
export function isMac(): boolean {
  return isDesktop() && /Macintosh|Mac OS X/.test(navigator.userAgent)
}

export function isMobileLayout(): boolean {
  return window.matchMedia('(max-width: 860px)').matches
}
