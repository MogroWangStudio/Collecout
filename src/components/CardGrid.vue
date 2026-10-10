<script setup lang="ts">
import { ref } from 'vue'
import type { Entry, FieldDef } from '../core/models'
import { t } from '../locales/strings'
import ImageLightbox from './ImageLightbox.vue'

const props = defineProps<{
  fields: FieldDef[]
  entries: Entry[]
  selected: Set<string>
  /** 显式多选模式：显示复选框角标，点击卡片即选择 */
  multiSelect?: boolean
  /** 库内图片的 blob URL（key = files/ 存储名） */
  imageUrls?: Record<string, string>
}>()

const emit = defineEmits<{
  open: [id: string]
  select: [id: string, index: number, mod: { shift: boolean; meta: boolean }]
}>()

function titleField(): FieldDef | undefined {
  return props.fields.find((f) => f.kind === 'text')
}

function detailFields(): FieldDef[] {
  const title = titleField()
  return props.fields.filter((f) => f !== title).slice(0, 5)
}

function value(field: FieldDef, entry: Entry): string {
  const v = entry.values[field.id]
  return v === undefined ? '' : String(v)
}

const preview = ref<{ url: string; name: string; from: Element } | null>(null)

/** 条目在某字段上的单元格图片（含存储名，供预览与无障碍标签用） */
function cellImageOf(field: FieldDef, entry: Entry): { url: string; name: string } | null {
  for (const img of entry.images ?? []) {
    if (img.fieldId !== field.id) continue
    const url = props.imageUrls?.[img.storedAs]
    if (url) return { url, name: img.storedAs }
  }
  return null
}

function cellImage(field: FieldDef, entry: Entry): string | null {
  return cellImageOf(field, entry)?.url ?? null
}

/** 点击卡片里的图片：从它所在的位置长出放大预览（不触发卡片的打开详情） */
function openPreview(field: FieldDef, entry: Entry, e: MouseEvent) {
  const img = cellImageOf(field, entry)
  if (!img) return
  preview.value = { ...img, from: e.currentTarget as Element }
}

/** 卡片点击：多选模式下切换选中（支持 Shift / Ctrl），否则打开条目详情 */
function onCardClick(entry: Entry, index: number, e: MouseEvent) {
  const multi = props.multiSelect || props.selected.size > 0
  if (multi || e.shiftKey || e.ctrlKey || e.metaKey) {
    emit('select', entry.id, index, { shift: e.shiftKey, meta: e.ctrlKey || e.metaKey })
  } else {
    emit('open', entry.id)
  }
}

function onCheck(entry: Entry, index: number, e: Event) {
  emit('select', entry.id, index, {
    shift: (e as MouseEvent).shiftKey,
    meta: (e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey,
  })
}
</script>

<template>
  <div class="card-grid">
    <article
      v-for="(entry, i) in props.entries"
      :key="entry.id"
      class="card clickable entry-card"
      :class="{ 'entry-selected': props.selected.has(entry.id) }"
      :data-entry-id="entry.id"
      @click="onCardClick(entry, i, $event)"
    >
      <label v-if="multiSelect || props.selected.size > 0 || props.selected.has(entry.id)" class="card-check" @click.stop>
        <input
          type="checkbox"
          :checked="props.selected.has(entry.id)"
          :aria-label="`选择 ${entry.id}`"
          @change="onCheck(entry, i, $event)"
        />
      </label>
      <header class="card-head">
        <h3 class="card-title">{{ value(titleField() ?? ({ name: '条目' } as FieldDef), entry) || '未命名' }}</h3>
        <span v-if="entry.sourceRef.fileName" class="meta">{{ entry.sourceRef.fileName }}</span>
      </header>
      <dl class="card-rows">
        <template v-for="field in detailFields()" :key="field.id">
          <div v-if="cellImage(field, entry)" class="card-row">
            <dt>{{ field.name }}</dt>
            <dd>
              <button
                type="button"
                class="card-image"
                :aria-label="t.common.zoomImage"
                @click.stop="openPreview(field, entry, $event)"
              >
                <img :src="cellImage(field, entry) ?? ''" alt="" loading="lazy" />
              </button>
            </dd>
          </div>
          <div v-else-if="value(field, entry) !== ''" class="card-row">
            <dt>{{ field.name }}</dt>
            <dd>
              <span v-if="field.kind === 'tag'" class="chip">{{ value(field, entry) }}</span>
              <span v-else class="row-value">{{ value(field, entry) }}</span>
            </dd>
          </div>
        </template>
      </dl>
    </article>

    <ImageLightbox
      :src="preview?.url ?? null"
      :name="preview?.name"
      :from="preview?.from"
      @close="preview = null"
    />
  </div>
</template>

<style scoped>
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}

.entry-card {
  position: relative;
  padding: 14px 16px;
}

.entry-card.entry-selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.card-check {
  position: absolute;
  top: 10px;
  left: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--hairline);
  cursor: pointer;
}

.card-check input {
  accent-color: var(--accent);
  margin: 0;
}

.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.card-title {
  font-size: 1.4rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-rows {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.card-row {
  display: flex;
  gap: 10px;
  font-size: 1.25rem;
  min-width: 0;
}

.card-row dt {
  flex: none;
  width: 52px;
  color: var(--ink-3);
}

.card-row dd {
  margin: 0;
  min-width: 0;
  color: var(--ink);
}

.row-value {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-image {
  max-height: 72px;
  max-width: 100%;
  padding: 0;
  border-radius: var(--r-s);
  border: 1px solid var(--hairline);
  display: block;
  overflow: hidden;
  background: var(--surface-2);
  cursor: zoom-in;
  transition: border-color 120ms ease;
}

.card-image img {
  display: block;
  max-height: 70px;
  max-width: 100%;
  object-fit: cover;
}

/* 反馈落在按下的一瞬 */
.card-image:hover {
  border-color: var(--ink-3);
}

.card-image:active {
  transform: scale(0.97);
  transition: transform 100ms ease-out;
}
</style>
