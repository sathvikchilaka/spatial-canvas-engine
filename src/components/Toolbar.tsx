import { MousePointer2, Table2, Workflow } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type ToolName = "select" | "order" | "table"

const TOOLS: Array<{ name: ToolName; label: string; Icon: typeof MousePointer2 }> = [
  { name: "select", label: "Select & edit boxes (V)", Icon: MousePointer2 },
  { name: "order", label: "Reading order (O)", Icon: Workflow },
  { name: "table", label: "Table mesh (T)", Icon: Table2 },
]

export function Toolbar({
  active,
  onChange,
}: {
  active: ToolName
  onChange: (t: ToolName) => void
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-card p-0.5">
      {TOOLS.map(({ name, label, Icon }) => (
        <Button
          key={name}
          size="icon"
          variant="ghost"
          title={label}
          aria-label={label}
          aria-pressed={active === name}
          onClick={() => onChange(name)}
          className={cn("size-7", active === name && "bg-accent text-accent-foreground")}
        >
          <Icon className="size-4" />
        </Button>
      ))}
    </div>
  )
}
