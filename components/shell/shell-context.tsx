"use client";

/** حالة الـ Shell المشتركة: فتح الشريط الجانبي على الجوال من أي صفحة */

import { createContext, useContext, useState } from "react";

interface ShellContextValue {
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <ShellContext.Provider value={{ mobileOpen, setMobileOpen }}>
      {children}
    </ShellContext.Provider>
  );
}

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used within ShellProvider");
  return ctx;
}
