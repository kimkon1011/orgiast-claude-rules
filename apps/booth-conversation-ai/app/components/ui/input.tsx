import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn("flex h-11 w-full rounded-lg border bg-white px-3 py-2 text-sm shadow-sm outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-primary/30", className)} {...props} />
));
Input.displayName = "Input";
