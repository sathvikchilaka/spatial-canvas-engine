import { memo } from 'react'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export type DocumentId = 'funsd' | 'synthetic'

export const DocumentPicker = memo(function DocumentPicker({
  value,
  onChange,
}: {
  value: DocumentId
  onChange: (id: DocumentId) => void
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as DocumentId)}>
      <SelectTrigger size="sm" className="w-56" aria-label="Document">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="funsd">Real · FUNSD · 199pp · 41k boxes</SelectItem>
        <SelectItem value="synthetic">Stress · 100pp · 10k boxes</SelectItem>
      </SelectContent>
    </Select>
  )
})
