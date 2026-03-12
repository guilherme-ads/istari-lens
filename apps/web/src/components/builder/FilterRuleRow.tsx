import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type FilterRuleRowVariant = "global" | "widget";

const FILTER_RULE_ROW_VARIANT_CLASS: Record<FilterRuleRowVariant, string> = {
  global: "md:grid-cols-[1fr_150px_1fr_auto_auto]",
  widget: "md:grid-cols-[1fr_120px_minmax(0,1fr)_auto_auto]",
};

interface FilterRuleRowProps {
  children: ReactNode;
  className?: string;
  variant?: FilterRuleRowVariant;
}

export const FilterRuleRow = ({ children, className, variant = "global" }: FilterRuleRowProps) => (
  <div className={cn("grid grid-cols-1 gap-2 items-center", FILTER_RULE_ROW_VARIANT_CLASS[variant], className)}>
    {children}
  </div>
);

export default FilterRuleRow;
