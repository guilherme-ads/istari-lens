import { useState, type ElementType, type ReactNode } from "react";
import { Calendar, ChevronDown } from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export const ConfigSection = ({
  title,
  icon: Icon,
  children,
  defaultOpen = true,
  badge,
}: {
  title: string;
  icon: ElementType;
  children: ReactNode;
  defaultOpen?: boolean;
  badge?: string | number;
}) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-border/60 bg-background/45 p-3">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 text-left text-label font-semibold text-foreground"
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
          {title}
          {badge !== undefined && (
            <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent/15 px-1 text-[10px] font-bold text-accent">
              {badge}
            </span>
          )}
        </span>
        <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open ? "rotate-180" : "")} />
      </button>
      {open && <div className="mt-2.5 space-y-2.5">{children}</div>}
    </div>
  );
};

export type SentenceTone = "agg" | "column" | "time" | "segment";
export type SentenceOption = { value: string; label: string; disabled?: boolean };

export type SentenceTokenSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: SentenceOption[];
  tone: SentenceTone;
  placeholder?: string;
  showCalendarIcon?: boolean;
};

export const SentenceTokenSelect = ({
  value,
  onChange,
  options,
  tone,
  placeholder,
  showCalendarIcon = false,
}: SentenceTokenSelectProps) => {
  const toneClass = tone === "agg"
    ? "border-violet-500/40 bg-violet-500/10 text-violet-300"
    : tone === "column"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : tone === "time"
        ? "border-sky-500/40 bg-sky-500/10 text-sky-300"
        : "border-orange-500/40 bg-orange-500/10 text-orange-300";
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn("h-7 w-auto min-w-[92px] rounded-md px-1.5 text-[11px] font-semibold", toneClass)}>
        {showCalendarIcon && <Calendar className="mr-1 h-3 w-3 shrink-0" />}
        <SelectValue placeholder={placeholder || "Selecionar"} />
      </SelectTrigger>
      <SelectContent position="item-aligned" className="max-h-44 rounded-md p-1">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled} className="h-7 rounded-sm pl-7 pr-2 text-[11px]">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
