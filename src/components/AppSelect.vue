<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

export interface SelectOption {
  value: string | number
  label: string
}

const props = defineProps<{
  modelValue: string | number
  options: SelectOption[]
  disabled?: boolean
  placeholder?: string
  /** 紧凑尺寸（表格行内） */
  compact?: boolean
  /** 触发器占比宽度拉伸 */
  grow?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string | number] }>()
// aria-label 等透传属性挂到触发按钮上（多根模板不会自动继承）
defineOptions({ inheritAttrs: false })

const selected = computed(() => props.options.find((o) => o.value === props.modelValue))
const selectedLabel = computed(() => selected.value?.label ?? props.placeholder ?? '')

/* ---------- MWS ComboBox：三层几何动画 ----------
   pop（定位层，Teleport 到 body）→ frame（可见窗口，动画 top/height）→ plate（整列条带，动画 top）。
   打开：窗口从「选中行」的位置与高度长成整列，各行按与锚点的距离错峰浮入；
   关闭：窗口收回只剩选中行，其余行淡出；开着重选：窗口滑到新选中行下再收回。
   行高 ROW 与 CSS .cbx-row 高度必须一致（compact 变体同理）。 */
const ROW = props.compact ? 28 : 38
/** 超过 6 行改为窗口内滚动，避免弹层超出视口 */
const CAP = 6 * ROW
const DUR = 420
const MOVE_DUR = 320
/** 打开 / 重选：回弹 cubic-bezier；关闭：加速收场 */
const EO = 'cubic-bezier(0.34, 1.56, 0.64, 1)'
const EC = 'cubic-bezier(0.55, 0, 1, 0.45)'

const open = ref(false)
const phase = ref<'closed' | 'opening' | 'open' | 'closing'>('closed')
const busy = ref(false)
const recenterGeom = ref(false)
const anchor = ref(0)
const hoverI = ref(-1)
const idx = ref(Math.max(0, props.options.findIndex((o) => o.value === props.modelValue)))

watch(
  () => props.modelValue,
  () => {
    idx.value = Math.max(0, props.options.findIndex((o) => o.value === props.modelValue))
  },
)

const trigger = ref<HTMLElement | null>(null)
const pop = ref<HTMLElement | null>(null)
const frame = ref<HTMLElement | null>(null)
const plate = ref<HTMLElement | null>(null)
const chev = ref<SVGElement | null>(null)
const rowEls: HTMLElement[] = []
function setRowRef(el: unknown, i: number) {
  rowEls[i] = el as HTMLElement
}

let timer = 0
let moveTimer = 0
let lastDir: 'center' | 'up' | 'down' = 'center'
let pendingScroll = 0

function setGeom(t: number, h: number, p: number) {
  const f = frame.value
  const pl = plate.value
  if (!f || !pl) return
  f.style.top = `${t}px`
  f.style.height = `${h}px`
  pl.style.top = `${p}px`
}

function curTop(el: HTMLElement): number {
  const v = parseFloat(getComputedStyle(el).top)
  return isNaN(v) ? 0 : v
}

/** 弹层相对触发器顶端的纵向偏移；滚动列表时把需要的 scrollTop 记入 pendingScroll */
function openOffset(to: number): number {
  const el = trigger.value
  if (!el) return 0
  const r = el.getBoundingClientRect()
  const M = 12
  const vh = window.innerHeight
  const n = props.options.length
  const total = n * ROW
  const fh = Math.min(total, CAP)
  pendingScroll = 0
  if (total <= CAP) {
    // 与参考实现一致：整列可容纳时优先把选中行对准触发器，放不下再整体挪到空间更大的一侧
    const up = Math.max(0, r.top - M)
    const down = Math.max(0, vh - (r.top + ROW) - M)
    if (up >= to * ROW && down >= (n - to) * ROW) {
      lastDir = 'center'
      return -to * ROW
    }
    if (down >= total) {
      lastDir = 'down'
      return ROW
    }
    if (up >= total) {
      lastDir = 'up'
      return -total
    }
    lastDir = up >= down ? 'down' : 'up'
    return lastDir === 'down' ? M - r.top : vh - M - fh - r.top
  }
  // 超长列表：窗口取视口内的最大可见高度，滚动让选中行对准触发器
  lastDir = 'center'
  const top = Math.min(Math.max(-to * ROW, M - r.top), vh - M - fh - r.top)
  pendingScroll = Math.min(Math.max(top + to * ROW, 0), total - fh)
  return top
}

/** 定位弹层（左缘 / 宽度与触发器对齐；pop 为 fixed，top = 触发器视口位置 + 相对偏移） */
function place() {
  const el = trigger.value
  const p = pop.value
  if (!el || !p) return
  const r = el.getBoundingClientRect()
  p.style.left = `${r.left}px`
  p.style.width = `${r.width}px`
  p.style.top = `${r.top + openOffset(anchor.value)}px`
}

function layout() {
  const p = pop.value
  if (p) p.style.transition = 'none'
  place()
}

/** pop 顶缘相对触发器顶端的纵向位置（openOffset 的同一坐标系） */
function popTopRel(): number {
  const p = pop.value
  const el = trigger.value
  if (!p || !el) return 0
  return curTop(p) - el.getBoundingClientRect().top
}

/** frame + plate + pop 的复合位移：条带原点相对触发器的当前纵向位置（取实时值，可中断） */
function contentTop(): number {
  const f = frame.value
  const pl = plate.value
  return popTopRel() + (f ? curTop(f) : 0) + (pl ? curTop(pl) : 0)
}

/** 关闭态几何：窗口（单行高）正好罩住触发器位置的选中行 */
function closedGeom(): [number, number] {
  return [-popTopRel(), -idx.value * ROW]
}

/** 错峰入场的行位移方向：锚点行不动，上方行从上落下、下方行从下升起 */
function shift(i: number): number {
  if (lastDir === 'center') return i === anchor.value ? 0 : i > anchor.value ? 8 : -8
  return i === 0 ? 0 : -8
}

/** 回到关闭态几何：清过渡、窗口收成单行、各行归位到透明 + 位移 */
function closedFrame() {
  const f = frame.value
  const pl = plate.value
  if (!f || !pl) return
  f.style.transition = 'none'
  pl.style.transition = 'none'
  layout()
  const g = closedGeom()
  setGeom(g[0], ROW, g[1])
  f.scrollTop = 0
  rowEls.forEach((el, i) => {
    el.style.transition = 'none'
    el.style.opacity = '0'
    el.style.transform = `translateY(${shift(i)}px)`
  })
  void f.offsetWidth
}

function show() {
  const f = frame.value
  const pl = plate.value
  const p = pop.value
  const ch = chev.value
  if (!f || !pl || !p || !ch) return
  clearTimeout(timer)
  clearTimeout(moveTimer)
  busy.value = false
  recenterGeom.value = false
  anchor.value = idx.value
  hoverI.value = -1
  open.value = true
  phase.value = 'opening'
  p.style.visibility = 'visible'
  p.style.pointerEvents = 'auto'
  closedFrame()
  const fh = Math.min(props.options.length * ROW, CAP)
  f.style.transition = `top ${DUR}ms ${EO}, height ${DUR}ms ${EO}`
  pl.style.transition = `top ${DUR}ms ${EO}`
  setGeom(0, fh, 0)
  f.scrollTop = pendingScroll
  ch.style.transition = `transform ${DUR}ms ${EO}`
  ch.style.transform = 'rotate(180deg)'
  rowEls.forEach((el, i) => {
    const d = Math.round(Math.abs(i - anchor.value) * 24)
    el.style.transition = `opacity ${Math.round(DUR * 0.4)}ms ${EO} ${d}ms, transform ${Math.round(DUR * 0.55)}ms ${EO} ${d}ms, background 120ms ease`
    el.style.opacity = '1'
    el.style.transform = 'translateY(0)'
  })
  timer = window.setTimeout(() => {
    if (open.value) phase.value = 'open'
  }, DUR + 160)
  p.focus({ preventScroll: true })
}

function hide() {
  const f = frame.value
  const pl = plate.value
  const p = pop.value
  const ch = chev.value
  if (!open.value || !f || !pl || !p || !ch) return
  open.value = false
  phase.value = 'closing'
  clearTimeout(timer)
  // 滚动归零：位移差记到 pop 上，行位置不变
  const s = f.scrollTop
  if (s) {
    p.style.transition = 'none'
    p.style.top = `${curTop(p) - s}px`
    f.scrollTop = 0
  }
  const cd = Math.round(DUR * 0.6)
  const g = closedGeom()
  f.style.transition = `top ${cd}ms ${EC}, height ${cd}ms ${EC}`
  pl.style.transition = `top ${cd}ms ${EC}`
  setGeom(g[0], ROW, g[1])
  ch.style.transition = `transform ${cd}ms ${EC}`
  ch.style.transform = 'rotate(0deg)'
  rowEls.forEach((el, i) => {
    if (i === anchor.value) {
      el.style.transition = 'none'
      el.style.opacity = '1'
    } else {
      el.style.transition = `opacity ${Math.round(cd * 0.5)}ms ${EC}`
      el.style.opacity = '0'
    }
  })
  timer = window.setTimeout(() => {
    if (open.value) return
    const pp = pop.value
    if (pp) {
      pp.style.visibility = 'hidden'
      pp.style.pointerEvents = 'none'
    }
    phase.value = 'closed'
    anchor.value = idx.value
    recenterGeom.value = false
    hoverI.value = -1
    closedFrame()
  }, cd + 30)
  trigger.value?.focus({ preventScroll: true })
}

/** 打开动画未完成就要重选时：直接跳到整列展开态再滑动 */
function snapOpen() {
  const f = frame.value
  const pl = plate.value
  const ch = chev.value
  if (!f || !pl || !ch) return
  clearTimeout(timer)
  f.style.transition = 'none'
  pl.style.transition = 'none'
  ch.style.transition = 'none'
  setGeom(0, Math.min(props.options.length * ROW, CAP), 0)
  f.scrollTop = pendingScroll
  ch.style.transform = 'rotate(180deg)'
  rowEls.forEach((el) => {
    el.style.transition = 'none'
    el.style.opacity = '1'
    el.style.transform = 'translateY(0)'
  })
  void f.offsetWidth
  phase.value = 'open'
}

/** 窗口滑到新选中行下（弹层整体平移），停稳后原路收回 */
function recenter(to: number) {
  const p = pop.value
  const pl = plate.value
  const f = frame.value
  if (!p || !pl || !f) return
  clearTimeout(timer)
  clearTimeout(moveTimer)
  busy.value = true
  recenterGeom.value = true
  anchor.value = to
  const s = f.scrollTop
  if (s) {
    p.style.transition = 'none'
    p.style.top = `${curTop(p) - s}px`
    f.scrollTop = 0
  }
  const P = curTop(p)
  const delta = openOffset(to) - contentTop()
  pl.style.transition = 'none'
  pl.style.top = `${curTop(pl)}px`
  p.style.transition = 'none'
  p.style.top = `${P}px`
  void p.offsetWidth
  p.style.transition = `top ${MOVE_DUR}ms ${EO}`
  p.style.top = `${P + delta}px`
  moveTimer = window.setTimeout(() => {
    if (!busy.value) return
    busy.value = false
    p.style.transition = 'none'
    if (!open.value) return
    p.style.top = `${P + delta}px`
    hide()
  }, MOVE_DUR + 30)
}

function commit(k: number) {
  const opt = props.options[k]
  if (!opt) return
  const changed = k !== idx.value
  idx.value = k
  emit('update:modelValue', opt.value)
  const slide = props.options.length * ROW <= CAP
  if (changed && slide && open.value && lastDir === 'center') {
    if (phase.value === 'opening') snapOpen()
    recenter(k)
  } else {
    anchor.value = k
    hide()
  }
}

/** 打断滑动：冻结在当前位置（外部点击 / 再按触发器时调用） */
function settle() {
  if (!busy.value) return
  const p = pop.value
  clearTimeout(moveTimer)
  busy.value = false
  if (!p) return
  const v = curTop(p)
  p.style.transition = 'none'
  p.style.top = `${v}px`
}

async function toggle() {
  if (props.disabled || props.options.length === 0) return
  settle()
  if (open.value) hide()
  else show()
}

function move(dir: -1 | 1) {
  if (!open.value) return
  const n = props.options.length
  if (n === 0) return
  const from = hoverI.value < 0 ? idx.value : hoverI.value
  hoverI.value = (from + dir + n) % n
  const el = rowEls[hoverI.value]
  el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

function onKeydown(e: KeyboardEvent) {
  if (props.disabled) return
  switch (e.key) {
    case 'Enter':
    case ' ':
      e.preventDefault()
      if (open.value) {
        if (hoverI.value >= 0) commit(hoverI.value)
        else hide()
      } else {
        toggle()
      }
      break
    case 'ArrowDown':
      e.preventDefault()
      open.value ? move(1) : toggle()
      break
    case 'ArrowUp':
      e.preventDefault()
      open.value ? move(-1) : toggle()
      break
    case 'Escape':
      if (open.value) {
        e.stopPropagation()
        settle()
        hide()
      }
      break
    case 'Tab':
      settle()
      hide()
      break
  }
}

function onOutside(e: PointerEvent) {
  if (!open.value) return
  const t = e.target as Node
  if (trigger.value?.contains(t) || pop.value?.contains(t)) return
  settle()
  hide()
}

onMounted(() => {
  document.addEventListener('pointerdown', onOutside, true)
  closedFrame()
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onOutside, true)
  clearTimeout(timer)
  clearTimeout(moveTimer)
})
</script>

<template>
  <div class="cbx" :class="{ grow }">
    <button
      ref="trigger"
      type="button"
      class="cbx-btn"
      :class="{ compact }"
      :disabled="disabled"
      role="combobox"
      :aria-expanded="open"
      aria-haspopup="listbox"
      v-bind="$attrs"
      @keydown="onKeydown"
      @click="toggle"
    >
      <span class="cbx-label" :class="{ ph: !selected }">{{ selectedLabel }}</span>
      <svg ref="chev" class="cbx-chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2.5 4.5L6 8L9.5 4.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </div>

  <Teleport to="body">
    <div ref="pop" class="cbx-pop" :class="{ compact }" role="listbox" tabindex="-1" @keydown="onKeydown">
      <div ref="frame" class="cbx-frame">
        <div ref="plate" class="cbx-plate">
          <div
            v-for="(opt, i) in options"
            :key="opt.value"
            :ref="(el) => setRowRef(el, i)"
            class="cbx-row"
            :class="{ 'is-sel': opt.value === modelValue, 'is-hover': i === hoverI }"
            role="option"
            :aria-selected="opt.value === modelValue"
            @pointerenter="!busy && (hoverI = i)"
            @pointerleave="hoverI === i && (hoverI = -1)"
            @click.stop="commit(i)"
          >
            <span class="cbx-opt-label">{{ opt.label }}</span>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 6.2L4.7 9L10 3.2" fill="none" stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cbx {
  position: relative;
  display: inline-flex;
  min-width: 0;
}

.cbx.grow {
  flex: 1;
}

.cbx-btn {
  width: 100%;
  height: 38px;
  min-width: 0;
  padding: 0 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: var(--elevated);
  color: var(--ink);
  border: 0.5px solid var(--hairline-strong);
  border-radius: 10px;
  font: inherit;
  font-weight: 400;
  cursor: pointer;
  text-align: left;
  transition: background 120ms ease;
}

.cbx-btn:active:not(:disabled) {
  background: var(--surface-2);
}

.cbx-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.cbx-btn.compact {
  height: 28px;
  border-radius: 8px;
  font-size: 1.25rem;
}

.cbx-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cbx-label.ph {
  color: var(--ink-3);
}

.cbx-chev {
  flex: none;
  color: var(--ink-2);
}

/* 弹层：Teleport 到 body 的固定定位层，可见性由开合流程驱动 */
.cbx-pop {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 90;
  visibility: hidden;
  pointer-events: none;
  outline: none;
}

.cbx-frame {
  position: absolute;
  left: 0;
  width: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--elevated);
  border: 0.5px solid var(--hairline-strong);
  border-radius: 12px;
  box-shadow: var(--shadow-pop);
}

.cbx-plate {
  position: absolute;
  left: 0;
  width: 100%;
}

/* 行高与脚本里的 ROW（compact 时 28）必须一致 */
.cbx-row {
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 10px;
  cursor: pointer;
  color: var(--ink);
  font-weight: 400;
  border-left: 2px solid transparent;
  opacity: 0;
}

.cbx-pop.compact .cbx-row {
  height: 28px;
}

.cbx-row svg {
  flex: none;
  opacity: 0;
}

.cbx-row.is-sel {
  background: var(--accent-soft);
  font-weight: 500;
  border-left-color: var(--accent);
}

.cbx-row.is-sel svg {
  opacity: 1;
}

.cbx-row.is-hover {
  background: var(--surface-2);
}

.cbx-opt-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .cbx-row {
    opacity: 1;
  }
}
</style>
