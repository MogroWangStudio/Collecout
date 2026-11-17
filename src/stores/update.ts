import { defineStore } from 'pinia'
import { t } from '../locales/strings'
import {
  cancelDownload,
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  quitApp,
  resolveDownloadUrl,
  type ReleaseInfo,
} from '../lib/update'
import { useSettingsStore } from './settings'

/**
 * 更新流程状态机：检查 → 可选下载 → 读秒 → 重启安装。
 * 放在 store 里而不是关于页里，切换页面不会丢掉下载进度或读秒。
 */

export type UpdateStatus = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error'

/** 下载完成后的自动重启读秒（秒） */
const COUNTDOWN_SECONDS = 5

let countdownTimer: ReturnType<typeof setInterval> | null = null
/** 下载速度采样：每 0.5 秒按区间增量估算一次，避免单块抖动 */
let sampleAt = 0
let sampleBytes = 0

export const useUpdateStore = defineStore('update', {
  state: () => ({
    status: 'idle' as UpdateStatus,
    release: null as ReleaseInfo | null,
    error: '',
    received: 0,
    total: 0,
    speed: 0,
    downloadedPath: '',
    /** 距离自动重启还剩几秒；0 表示没有在读秒 */
    countdown: 0,
  }),
  getters: {
    percent: (s) => (s.total > 0 ? Math.min(100, (s.received / s.total) * 100) : 0),
  },
  actions: {
    /** 通道或下载源变了：已查到的结果不再对应当前设置，回到初始态 */
    reset() {
      this.cancelCountdown()
      this.status = 'idle'
      this.release = null
      this.error = ''
      this.received = 0
      this.total = 0
      this.speed = 0
      this.downloadedPath = ''
    },

    async check() {
      if (this.status === 'checking' || this.status === 'downloading') return
      const settings = useSettingsStore()
      this.reset()
      this.status = 'checking'
      try {
        const release = await checkForUpdate(settings.settings.updateChannel, t.version)
        this.release = release
        this.status = release ? 'available' : 'latest'
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e)
        this.status = 'error'
      }
    },

    async download() {
      const release = this.release
      if (!release?.asset || this.status === 'downloading') return
      const settings = useSettingsStore()
      this.status = 'downloading'
      this.error = ''
      this.received = 0
      this.total = release.asset.size
      this.speed = 0
      sampleAt = 0
      sampleBytes = 0
      try {
        const url = resolveDownloadUrl(release.asset.url, settings.settings.updateSource)
        const path = await downloadUpdate(url, release.asset.name, (received, total) => {
          const now = Date.now()
          if (sampleAt === 0) {
            sampleAt = now
            sampleBytes = received
          } else if (now - sampleAt >= 500) {
            this.speed = ((received - sampleBytes) * 1000) / (now - sampleAt)
            sampleAt = now
            sampleBytes = received
          }
          this.received = received
          if (total > 0) this.total = total
        })
        this.downloadedPath = path
        this.status = 'ready'
        this.startCountdown()
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        // 主动取消不是错误，界面回到「可以下载」即可
        this.error = message.includes('取消') ? '' : message
        this.status = 'available'
      }
    },

    /** 中断下载：原生侧收到标志后清掉半截文件，download() 的 await 随之结束 */
    async abortDownload() {
      try {
        await cancelDownload()
      } catch {
        /* 原生侧已经结束下载时会拒绝，忽略即可 */
      }
    },

    startCountdown() {
      this.cancelCountdown()
      this.countdown = COUNTDOWN_SECONDS
      countdownTimer = setInterval(() => {
        if (this.countdown > 1) {
          this.countdown -= 1
          return
        }
        this.cancelCountdown()
        void this.install()
      }, 1000)
    },

    cancelCountdown() {
      if (countdownTimer) {
        clearInterval(countdownTimer)
        countdownTimer = null
      }
      this.countdown = 0
    },

    async install() {
      if (!this.downloadedPath) return
      this.error = ''
      try {
        await installUpdate(this.downloadedPath)
        // 助手进程在等本进程退出后才替换文件，正常情况不会再执行到这里
        await quitApp()
      } catch (e) {
        this.cancelCountdown()
        this.error = e instanceof Error ? e.message : String(e)
        this.status = 'ready'
      }
    },
  },
})
