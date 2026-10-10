// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import ImageLightbox from './ImageLightbox.vue'

/** Transition 的退场依赖 rAF 与 transitionend；happy-dom 下需要真实等待若干帧 */
async function settle(frames = 4) {
  for (let i = 0; i < frames; i++) {
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => setTimeout(r, 16))
  }
  await nextTick()
}

/**
 * 回归测试：图片放大预览（表格 / 卡片 / 详情 / 导入预览共用的浮层）。
 * 曾经每个视图各写一份 `div role="button"`，Esc 关不掉、关闭后焦点丢失。
 */
describe('ImageLightbox', () => {
  it('以对话框呈现、Esc 关闭、关闭后把焦点还给原来的缩略图', async () => {
    const host = document.createElement('div')
    const thumb = document.createElement('button')
    document.body.appendChild(host)
    document.body.appendChild(thumb)
    thumb.focus()

    const src = ref<string | null>(null)
    const closes = ref(0)
    const app = createApp({
      setup: () => () =>
        h(ImageLightbox, {
          src: src.value,
          name: 'image3.png',
          from: thumb,
          onClose: () => {
            closes.value++
          },
        }),
    })
    app.mount(host)

    // 未打开时不渲染任何东西
    expect(document.querySelector('.lightbox')).toBeNull()

    src.value = 'blob:preview'
    await nextTick()
    const dialog = document.querySelector('.lightbox')
    expect(dialog?.getAttribute('role')).toBe('dialog')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.getAttribute('aria-label')).toBe('image3.png')
    expect(dialog?.querySelector('img')?.getAttribute('alt')).toBe('image3.png')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(closes.value).toBe(1)

    src.value = null
    await settle()
    expect(document.querySelector('.lightbox')).toBeNull()
    expect(document.activeElement).toBe(thumb)

    app.unmount()
    host.remove()
    thumb.remove()
  })
})
