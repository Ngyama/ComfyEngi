// 拖拽排序（dnd-kit）的通用封装：列表和网格都可以用。

import type { CSSProperties, ReactNode } from 'react'
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

export function SortableArea<T>({
  items,
  getId,
  onReorder,
  grid,
  disabled,
  children,
}: {
  items: T[]
  getId: (item: T, index: number) => string
  onReorder: (from: number, to: number, next: T[]) => void
  grid?: boolean
  disabled?: boolean
  children: ReactNode
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const ids = items.map(getId)
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const from = ids.indexOf(String(e.active.id))
    const to = ids.indexOf(String(e.over.id))
    if (from < 0 || to < 0) return
    onReorder(from, to, arrayMove(items, from, to))
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={grid ? rectSortingStrategy : verticalListSortingStrategy} disabled={disabled}>
        {children}
      </SortableContext>
    </DndContext>
  )
}

/** 整个元素可拖动（handle 为 false），或只通过 handle 拖动 */
export function useSortableItem(id: string) {
  const s = useSortable({ id })
  const style: CSSProperties = {
    transform: CSS.Translate.toString(s.transform),
    transition: s.transition,
    zIndex: s.isDragging ? 20 : undefined,
    position: 'relative',
  }
  return { ...s, style }
}
