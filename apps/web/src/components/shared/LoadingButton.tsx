import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

interface LoadingButtonProps extends ComponentProps<typeof Button> {
  loading?: boolean;
  loadingText?: string;
}

const LoadingButton = ({ loading, loadingText, children, disabled, className, ...props }: LoadingButtonProps) => (
  <Button
    disabled={disabled || loading}
    className={cn(className)}
    {...props}
  >
    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
    {loading && loadingText ? loadingText : children}
  </Button>
);

export default LoadingButton;
