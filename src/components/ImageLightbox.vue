<script setup lang="ts">
/**
 * 单元格图片的放大预览（表格 / 卡片 / 详情 / 导入预览共用）。
 * 预览从被点击的缩略图所在方向长出、按同路径缩回；Esc 关闭并把焦点还给缩略图。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { t } from '../locales/strings'

const props = defineProps<{
  /** 图片的 blob URL；null 表示不展示 */
  src: string | null
  /** 图片名（无障碍标签与 alt） */
  name?: string
  /** 触发预览的缩略图元素：预览从它所在的方向长出 */
  from?: Element | EventTarget | null
}>()

const emit = defineEmits<{ close: [] }>()

/** 缩略图中心相对视口中心的偏移（px）：预览图在视口正中，偏移即生长方向 */
const offset = computed(() => {
  const node = props.from as Element | null
  if (!node || typeof node.getBoundingClientRect !== 'function' || typeof window === 'undefined') return null
  const rect = node.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return {
    x: Math.round(rect.left + rect.width / 2 - window.innerWidth / 2),
    y: Math.round(rect.top + rect.height / 2 - window.innerHeight / 2),
  }
})

const imageStyle = computed(() => {
  const o = offset.value
  if (!o) return {}
  return {
    transformOrigin: `calc(50% + ${o.x}px) calc(50% + ${o.y}px)`,
    '--lb-dx': `${Math.round(o.x * 0.4)}px`,
    '--lb-dy': `${Math.round(o.y * 0.4)}px`,
  }
})

const closeBtn = ref<HTMLButtonElement | null>(null)
let restoreTo: HTMLElement | null = null

function close() {
  emit('close')
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

/** 打开时接管 Esc 并记住当前焦点，关闭后把焦点还回去 */
watch(
  () => props.src,
  (now, before) => {
    if (now && !before) {
      restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
      window.addEventListener('keydown', onKey)
      return
    }
    if (!now && before) {
      window.removeEventListener('keydown', onKey)
      restoreTo?.focus?.()
      restoreTo = null
    }
  },
)

onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <Transition name="lightbox" @after-enter="closeBtn?.focus()">
      <div v-if="src" class="lightbox" role="dialog" aria-modal="true" :aria-label="name || t.common.image" @click="close">
        <img :src="src" :alt="name || ''" :style="imageStyle" />
        <button
          ref="closeBtn"
          type="button"
          class="icon-btn lightbox-close"
          :aria-label="t.common.close"
          @click.stop="close"
        >
          <AppIcon name="x" />
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: var(--scrim);
  display: grid;
  place-items: center;
  padding: 32px;
  cursor: zoom-out;
}

.lightbox img {
  max-width: min(920px, 92vw);
  max-height: 88vh;
  border-radius: var(--r-m);
  box-shadow: var(--shadow-2);
  background: #fff;
}

/* 图片内容不可预知，关闭按钮自带一层薄衬底，任何底图上都能看清 */
.lightbox-close {
  position: absolute;
  top: calc(14px + max(env(safe-area-inset-top), var(--safe-top)));
  right: 16px;
  color: var(--ink);
  background: color-mix(in srgb, var(--surface) 74%, transparent);
  border: 1px solid var(--hairline);
}

@media (prefers-reduced-transparency: reduce) {
  .lightbox-close {
    background: var(--surface);
  }
}

/* 遮罩淡入，图片从缩略图方向长出（进场与退场同路径） */
.lightbox-enter-active,
.lightbox-leave-active {
  transition: opacity 200ms ease;
}

.lightbox-enter-active img,
.lightbox-leave-active img {
  transition:
    transform 320ms var(--ease-sheet),
    opacity 240ms ease;
}

.lightbox-enter-from,
.lightbox-leave-to {
  opacity: 0;
}

.lightbox-enter-from img,
.lightbox-leave-to img {
  opacity: 0;
  transform: translate(var(--lb-dx, 0px), var(--lb-dy, 0px)) scale(0.86);
}

/* 减弱动态效果：只交叉淡变，不做位移与缩放 */
@media (prefers-reduced-motion: reduce) {
  .lightbox-enter-active img,
  .lightbox-leave-active img {
    transition: opacity 160ms ease;
  }

  .lightbox-enter-from img,
  .lightbox-leave-to img {
    transform: none;
  }
}
</style>
