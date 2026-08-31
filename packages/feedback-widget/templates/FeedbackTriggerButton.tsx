"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { children?: ReactNode };

export function FeedbackTriggerButton({ children = "🐛 不具合・要望", onClick, ...props }: Props) {
  return (
    <button {...props} type="button" onClick={(event) => {
      onClick?.(event);
      if (!event.defaultPrevented) window.dispatchEvent(new CustomEvent("open-feedback"));
    }}>
      {children}
    </button>
  );
}
