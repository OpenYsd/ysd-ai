"use client";

/**
 * إدارة المظهر (داكن/فاتح) وسطوع الواجهة المستمرّ عبر Cookie + سمة data-theme
 * ومتغيّر --ui-b على <html> — بدون وميض.
 */

import { createContext, useCallback, useContext, useState } from "react";
import {
  UI_BRIGHTNESS_COOKIE,
  UI_BRIGHTNESS_DEFAULT,
  uiBrightnessCss,
} from "@/lib/ui-preferences";

export type Theme = "dark" | "light";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  /** 0 … 100 */
  brightness: number;
  setBrightness: (value: number) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
  initialTheme,
  initialBrightness = UI_BRIGHTNESS_DEFAULT,
  children,
}: {
  initialTheme: Theme;
  initialBrightness?: number;
  children: React.ReactNode;
}) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [brightness, setBrightnessState] = useState<number>(initialBrightness);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    document.cookie = `ysd-theme=${t};path=/;max-age=31536000;samesite=lax`;
    document.documentElement.dataset.theme = t;
  }, []);

  /** محلي فقط: Cookie على هذا الجهاز، بلا طلب إلى الخادم */
  const setBrightness = useCallback((value: number) => {
    const css = uiBrightnessCss(value);
    const n = Math.round(Number(css) * 100);
    setBrightnessState(n);
    document.cookie = `${UI_BRIGHTNESS_COOKIE}=${n};path=/;max-age=31536000;samesite=lax`;
    document.documentElement.style.setProperty("--ui-b", css);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, brightness, setBrightness }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
