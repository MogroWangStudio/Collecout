<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '../locales/strings'
import { useUiStore } from '../stores/ui'
import { useSettingsStore } from '../stores/settings'
import { useUpdateStore } from '../stores/update'
import { openInBrowser } from '../lib/desktop'
import { isDesktop } from '../lib/platform'
import {
  PROXY_PREFIX,
  REPO,
  formatBytes,
  formatDate,
  formatSpeed,
  probeSpeed,
  probeTargetUrl,
} from '../lib/update'
import AppIcon from '../components/AppIcon.vue'

const ui = useUiStore()
ui.setPageTitle(t.about.title)

const settings = useSettingsStore()
const update = useUpdateStore()

const releasesUrl = `https://github.com/${REPO}/releases`
/** 当前这个构建本身是不是预发布（决定版本号旁边是否标注） */
const isBetaBuild = t.version.includes('-')

const channelOptions = [
  { id: 'stable', label: t.about.channelStable },
  { id: 'beta', label: t.about.channelBeta },
] as const

const sourceOptions = [
  { id: 'github', label: t.about.sourceGithub },
  { id: 'ghproxy', label: t.about.sourceGithubProxy },
] as const

function setChannel(id: 'stable' | 'beta') {
  if (settings.settings.updateChannel === id) return
  void settings.set({ updateChannel: id })
  // 已查到的版本是按旧通道筛的，换通道后作废
  update.reset()
}

function setSource(id: 'github' | 'ghproxy') {
  if (settings.settings.updateSource === id) return
  void settings.set({ updateSource: id })
}

/* ---------- 双下载源测速 ---------- */

const speedState = ref<'idle' | 'testing' | 'done'>('idle')
const speeds = ref({ github: 0, ghproxy: 0 })

const speedRows = computed(() => {
  const max = Math.max(speeds.value.github, speeds.value.ghproxy)
  return sourceOptions.map((opt) => {
    const bps = speeds.value[opt.id]
    return {
      id: opt.id,
      label: opt.label,
      bps,
      // 较慢的一侧保留 2% 的最小可见长度，避免读成「没有数据」
      width: max > 0 ? `${Math.max(2, (bps / max) * 100)}%` : '0%',
      fast: max > 0 && bps === max,
    }
  })
})

async function runSpeedTest() {
  if (speedState.value === 'testing') return
  if (!isDesktop()) {
    ui.toast(t.about.desktopOnly)
    return
  }
  speedState.value = 'testing'
  try {
    const target = await probeTargetUrl(update.release?.asset?.url ?? null)
    // 两个源同时测，避免先后顺序受瞬时带宽影响
    const [direct, proxy] = await Promise.all([
      probeSpeed(target).then((r) => r.bps).catch(() => 0),
      probeSpeed(PROXY_PREFIX + target).then((r) => r.bps).catch(() => 0),
    ])
    speeds.value = { github: direct, ghproxy: proxy }
    speedState.value = 'done'
    if (!direct && !proxy) ui.toast(t.about.speedFailed, 'danger')
  } catch {
    speedState.value = 'idle'
    ui.toast(t.about.speedFailed, 'danger')
  }
}

/* ---------- 更新操作 ---------- */

const release = computed(() => update.release)
const hasPanel = computed(
  () => release.value !== null && update.status !== 'idle' && update.status !== 'latest',
)
const sizeText = computed(() => formatBytes(release.value?.asset?.size ?? 0))
const canInstall = computed(() => isDesktop() && release.value?.asset != null)
const published = computed(() => formatDate(release.value?.publishedAt ?? ''))
/** GitHub 对匿名请求限流，撞上了说清楚，别让用户以为是自己网络坏了 */
const checkError = computed(() =>
  /HTTP 403|rate limit/i.test(update.error) ? t.about.checkRateLimited : t.about.checkFailed,
)

function openReleases() {
  void openInBrowser(releasesUrl)
}

function openDownloadPage() {
  void openInBrowser(release.value?.asset?.url ?? releasesUrl)
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <button class="icon-btn" :aria-label="t.common.back" @click="$router.back()">
        <AppIcon name="arrow-left" />
      </button>
      <h1 class="large-title">{{ t.about.title }}</h1>
    </header>

    <div class="column">
      <section class="about-card card">
        <img src="/logo-text.svg" alt="" class="about-logo" />
        <p class="version meta">
          v{{ t.version }}
          <span v-if="isBetaBuild" class="chip warn">{{ t.about.prerelease }}</span>
        </p>
        <p class="hint tagline">{{ t.settings.aboutLine }}</p>

        <div class="update-row">
          <button
            class="btn"
            :disabled="update.status === 'checking' || update.status === 'downloading'"
            @click="update.check()"
          >
            <AppIcon :name="update.status === 'checking' ? 'spinner' : 'refresh'" :size="15" :class="{ spin: update.status === 'checking' }" />
            {{ update.status === 'checking' ? t.about.checking : t.about.checkUpdate }}
          </button>
          <span v-if="update.status === 'latest'" class="hint up-to-date">
            <AppIcon name="check" :size="14" />
            {{ t.about.upToDate(t.version) }}
          </span>
          <span v-else-if="update.status === 'available'" class="chip">
            {{ t.about.newVersion(release?.version ?? '') }}
          </span>
          <span v-else-if="update.status === 'error'" class="hint error">{{ checkError }}</span>
        </div>

        <footer class="about-foot">
          <p class="hint">© 2026 MogroWang Studio · MIT License</p>
          <button class="btn btn-ghost btn-sm" @click="openReleases">
            <AppIcon name="doc" :size="14" />
            {{ t.about.releasesPage }}
          </button>
        </footer>
      </section>

      <!-- 新版本详情：只在查到更新后出现，位置就在「检查更新」正下方 -->
      <section v-if="hasPanel && release" class="group release">
        <header class="release-head">
          <div class="release-title">
            <span class="release-version">v{{ release.version }}</span>
            <span v-if="release.prerelease" class="chip warn">{{ t.about.prerelease }}</span>
          </div>
          <span class="meta release-meta">
            {{ sizeText }}
            <template v-if="published"> · {{ t.about.publishedAt(published) }}</template>
          </span>
        </header>

        <div v-if="release.notes" class="notes">
          <p class="notes-label meta">{{ t.about.releaseNotes }}</p>
          <p class="notes-body">{{ release.notes }}</p>
        </div>

        <div v-if="update.status === 'available'" class="release-actions">
          <button v-if="canInstall" class="btn btn-primary" @click="update.download()">
            <AppIcon name="import" :size="15" />
            {{ t.about.download(sizeText) }}
          </button>
          <button v-else class="btn btn-primary" @click="openDownloadPage">
            <AppIcon name="export" :size="15" />
            {{ t.about.downloadBrowser }}
          </button>
          <button class="btn btn-ghost" @click="openReleases">{{ t.about.gotoRelease }}</button>
          <span v-if="!release.asset" class="hint note-line">{{ t.about.noAsset }}</span>
          <span v-else-if="!isDesktop()" class="hint note-line">{{ t.about.desktopOnly }}</span>
        </div>

        <div v-else-if="update.status === 'downloading'" class="download">
          <div
            class="bar"
            role="progressbar"
            :aria-valuenow="Math.round(update.percent)"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <i :style="{ width: `${update.percent}%` }" />
          </div>
          <div class="download-meta">
            <span class="meta num">{{ formatBytes(update.received) }} / {{ formatBytes(update.total) }}</span>
            <span class="meta num">{{ formatSpeed(update.speed) }}</span>
            <span class="foot-spacer" />
            <button class="btn btn-sm btn-ghost" @click="update.abortDownload()">
              {{ t.about.downloadCancel }}
            </button>
          </div>
        </div>

        <div v-else-if="update.status === 'ready'" class="release-actions">
          <span class="hint">{{ t.about.readyBody(release.version) }}</span>
          <span class="foot-spacer" />
          <button class="btn btn-primary" @click="update.startCountdown()">
            <AppIcon name="refresh" :size="15" />
            {{ t.about.restartNow }}
          </button>
        </div>

        <p v-if="update.error && update.status !== 'downloading'" class="hint error">{{ update.error }}</p>
      </section>

      <section class="group">
        <h2 class="group-title">{{ t.about.updateSection }}</h2>

        <div class="row">
          <span>{{ t.about.channel }}</span>
          <div class="seg">
            <button
              v-for="opt in channelOptions"
              :key="opt.id"
              :class="{ on: settings.settings.updateChannel === opt.id }"
              @click="setChannel(opt.id)"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>
        <p class="hint row-note">
          {{
            settings.settings.updateChannel === 'beta' ? t.about.channelBetaHint : t.about.channelStableHint
          }}
        </p>

        <div class="row">
          <span>{{ t.about.source }}</span>
          <div class="seg">
            <button
              v-for="opt in sourceOptions"
              :key="opt.id"
              :class="{ on: settings.settings.updateSource === opt.id }"
              @click="setSource(opt.id)"
            >
              {{ opt.label }}
            </button>
          </div>
          <button class="btn btn-sm" :disabled="speedState === 'testing'" @click="runSpeedTest">
            {{ speedState === 'testing' ? t.about.speedTesting : t.about.speedTest }}
          </button>
        </div>

        <div v-if="speedState === 'done' && (speeds.github > 0 || speeds.ghproxy > 0)" class="speed-list">
          <div v-for="row in speedRows" :key="row.id" class="speed-row" :class="{ fast: row.fast }">
            <span class="speed-name">{{ row.label }}</span>
            <span class="speed-bar"><i :style="{ width: row.width }" /></span>
            <span class="speed-value meta num">{{ formatSpeed(row.bps) }}</span>
            <span v-if="row.fast" class="chip">{{ t.about.speedFaster }}</span>
          </div>
        </div>
        <p v-else class="hint row-note">{{ t.about.sourceHint }}</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: 28px 32px 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.page-head {
  width: 100%;
  max-width: 560px;
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 20px;
}

.column {
  width: min(560px, 100%);
  display: flex;
  flex-direction: column;
}

.about-card {
  width: 100%;
  padding: 36px 32px 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  text-align: center;
}

.about-logo {
  height: 40px;
  width: auto;
  margin-bottom: 6px;
}

.version {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
}

.version .chip {
  height: 18px;
  font-size: 1.1rem;
}

.tagline {
  max-width: 360px;
  margin-bottom: 18px;
}

.update-row {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 10px;
  padding-top: 16px;
  border-top: 1px solid var(--hairline);
  width: 100%;
}

.up-to-date {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--accent);
}

.about-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 22px;
  padding-top: 12px;
  border-top: 1px solid var(--hairline);
  width: 100%;
}

.btn-sm {
  height: 28px;
  font-size: 1.2rem;
}

/* ---------- 分组（与设置页同一套语言） ---------- */
.group {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-radius: var(--r-m);
  padding: 16px 18px;
  margin-bottom: 14px;
}

.about-card + .group {
  margin-top: 14px;
}

.group-title {
  font-size: 1.3rem;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--ink-2);
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 32px;
  flex-wrap: wrap;
}

.row + .row {
  margin-top: 12px;
}

.row > span:first-child {
  font-weight: 500;
  flex: none;
  margin-right: auto;
}

.row-note {
  margin-top: 8px;
}

/* ---------- 新版本面板 ---------- */
.release-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.release-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.release-version {
  font-size: 1.7rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}

.release-meta {
  font-variant-numeric: tabular-nums;
}

.notes {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--hairline);
}

.notes-label {
  margin-bottom: 6px;
}

.notes-body {
  font-size: 1.25rem;
  line-height: 1.6;
  color: var(--ink-2);
  white-space: pre-wrap;
  /* 发行说明只作参考，超出六行折成省略号——不要把行切一半，也不给第二个滚动区 */
  display: -webkit-box;
  -webkit-line-clamp: 6;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.release-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 14px;
}

.release-actions .note-line {
  flex: 1 1 100%;
  margin-top: 2px;
}

/* ---------- 下载进度 ---------- */
.download {
  margin-top: 16px;
}

.bar {
  height: 4px;
  border-radius: 999px;
  background: var(--hairline-strong);
  overflow: hidden;
}

.bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 220ms linear;
}

.download-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

.num {
  font-variant-numeric: tabular-nums;
}

/* ---------- 测速 ---------- */
.speed-list {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.speed-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.speed-name {
  width: 96px;
  flex: none;
  font-size: 1.2rem;
  color: var(--ink-2);
}

.speed-row.fast .speed-name {
  color: var(--ink);
  font-weight: 500;
}

.speed-bar {
  flex: 1;
  height: 4px;
  border-radius: 999px;
  background: var(--surface-2);
  overflow: hidden;
}

.speed-bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent-soft-2);
  transition: width 300ms var(--ease-sheet);
}

.speed-row.fast .speed-bar i {
  background: var(--accent);
}

.speed-value {
  width: 68px;
  flex: none;
  text-align: right;
}

.speed-row.fast .speed-value {
  color: var(--ink);
}

/* ---------- 读秒入口 ---------- */
.foot-spacer {
  flex: 1;
}

.error {
  color: var(--danger);
}

@media (max-width: 860px) {
  .page {
    padding: 20px 16px 32px;
  }

  .about-card {
    padding: 28px 20px 20px;
  }

  .speed-name {
    width: 84px;
  }
}
</style>
