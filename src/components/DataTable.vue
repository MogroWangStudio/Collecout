<script setup lang="ts">
import { ref } from 'vue'
import type { Entry, FieldDef } from '../core/models'
import { t } from '../locales/strings'
import ImageLightbox from './ImageLightbox.vue'

const props = defineProps<{
  fields: FieldDef[]
  entries: Entry[]
  selected: Set<string>
  sort: { fieldId: string; dir: 'asc' | 'desc' } | null
  /** 显式多选模式：显示复选框列，点击行即选择 */
  multiSelect?: boolean
  /** 库内图片的 blob URL（key = files/ 存储名） */
  imageUrls?: Record<string, string>
}>()

const emit = defineEmits<{
  select: [id: string, index: number, mod: { shift: boolean; meta: boolean }]
  'toggle-all': []
  sort: [fieldId: string]
  open: [id: string]
}>()

const preview = ref<{ url: string; name: string; from: Element } | null>(null)

/** 条目在某字段列上的单元格图片（含存储名，供预览与无障碍标签用） */
function cellImageOf(entry: Entry, field: FieldDef): { url: string; name: string } | null {
  for (const img of entry.images ?? []) {
    if (img.fieldId !== field.id) continue
    const url = props.imageUrls?.[img.storedAs]
    if (url) return { url, name: img.storedAs }
  }
  return null
}

function cellImage(entry: Entry, field: FieldDef): string | null {
  return cellImageOf(entry, field)?.url ?? null
}

/** 点击缩略图：从它所在的位置长出放大预览 */
function openPreview(entry: Entry, field: FieldDef, e: MouseEvent) {
  const img = cellImageOf(entry, field)
  if (!img) return
  preview.value = { ...img, from: e.currentTarget as Element }
}

function display(field: FieldDef, entry: Entry): string {
  const v = entry.values[field.id]
  if (v === undefined || String(v) === '') return ''
  return String(v)
}

function onHeaderClick(field: FieldDef) {
  emit('sort', field.id)
}

function allSelected(): boolean {
  return props.entries.length > 0 && props.entries.every((e) => props.selected.has(e.id))
}

/** 勾选框：支持 Shift 范围选择与 Ctrl/Cmd 切换 */
function onCheck(entry: Entry, index: number, e: Event) {
  emit('select', entry.id, index, {
    shift: (e as MouseEvent).shiftKey,
    meta: (e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey,
  })
}

/** 行点击：多选模式（或已有选中）下切换选择，否则打开条目 */
function onRowClick(entry: Entry, index: number, e: MouseEvent) {
  if (props.multiSelect || props.selected.has(entry.id)) {
    emit('select', entry.id, index, { shift: e.shiftKey, meta: e.ctrlKey || e.metaKey })
  } else {
    emit('open', entry.id)
  }
}
</script>

<template>
  <div class="data-table-wrap">
    <!-- 单根容器：<Transition mode="out-in"> 要求子组件只有一个根节点，根级注释也算根；
         否则表格/卡片切换会整体卡死（见 DataTable.out-in.spec.ts） -->
    <table class="data-table">
      <thead>
        <tr>
          <th v-if="multiSelect || selected.size > 0" class="col-check">
            <input type="checkbox" :checked="allSelected()" aria-label="全选" @change="emit('toggle-all')" />
          </th>
          <th
            v-for="field in props.fields"
            :key="field.id"
            class="sortable"
            :class="{ sorted: props.sort?.fieldId === field.id }"
            @click="onHeaderClick(field)"
          >
            <span class="th-inner">
              {{ field.name }}
              <span v-if="props.sort?.fieldId === field.id" class="sort-mark">{{ props.sort.dir === 'asc' ? '↑' : '↓' }}</span>
            </span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(entry, i) in props.entries"
          :key="entry.id"
          class="row-click"
          :class="{ selected: props.selected.has(entry.id) }"
          :data-entry-id="entry.id"
          @click="onRowClick(entry, i, $event)"
        >
          <td v-if="multiSelect || selected.size > 0" class="col-check" @click.stop>
            <input
              type="checkbox"
              :checked="props.selected.has(entry.id)"
              :aria-label="`选择 ${entry.id}`"
              @change="onCheck(entry, i, $event)"
            />
          </td>
          <td v-for="field in props.fields" :key="field.id">
            <button
              v-if="cellImage(entry, field)"
              type="button"
              class="cell-image"
              :aria-label="t.common.zoomImage"
              @click.stop="openPreview(entry, field, $event)"
            >
              <img :src="cellImage(entry, field) ?? ''" alt="" loading="lazy" />
            </button>
            <span v-else-if="field.kind === 'tag' && display(field, entry)" class="chip">{{ display(field, entry) }}</span>
            <span v-else-if="field.kind === 'date'" class="cell-date">{{ display(field, entry) }}</span>
            <span v-else class="cell-truncate" :title="display(field, entry)">{{ display(field, entry) }}</span>
          </td>
        </tr>
      </tbody>
    </table>

    <ImageLightbox
      :src="preview?.url ?? null"
      :name="preview?.name"
      :from="preview?.from"
      @close="preview = null"
    />
  </div>
</template>

<style scoped>
/* 容器按表格内容自然宽度展开，水平滚动条仍由外层滚动区接管 */
.data-table-wrap {
  width: max-content;
  min-width: 100%;
}

.cell-image {
  display: inline-flex;
  width: 40px;
  height: 32px;
  padding: 0;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--hairline);
  background: var(--surface-2);
  cursor: zoom-in;
  transition: border-color 120ms ease;
}

.cell-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* 反馈落在按下的一瞬：悬停只提示可点，按下即缩 */
.cell-image:hover {
  border-color: var(--ink-3);
}

.cell-image:active {
  transform: scale(0.96);
  transition: transform 100ms ease-out;
}

.col-check {
  width: 36px;
}

.col-check input {
  accent-color: var(--accent);
}

.th-inner {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.sort-mark {
  color: var(--accent);
  font-size: 1.1rem;
}

.cell-date {
  font-variant-numeric: tabular-nums;
  color: var(--ink-2);
}
</style>
