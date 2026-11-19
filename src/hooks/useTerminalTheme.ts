import { useEffect, useState } from 'react';

// --- xterm theme from the app tokens (Primer dark, light-aware) ------------

function terminalTheme(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const bg = v('--bg-panel', '#161b22');
  const fg = v('--text-primary', '#e6edf3');
  const accent = v('--accent', '#4493f8');
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: `${accent}55`,
    // Primer dark ANSI palette.
    black: '#484f58',
    red: v('--red', '#f85149'),
    green: v('--green', '#3fb950'),
    yellow: '#d29922',
    blue: accent,
    magenta: '#db61a2',
    cyan: '#39c5cf',
    white: '#e6edf3',
    brightBlack: '#6e7681',
    brightRed: '#ff6a60',
    brightGreen: '#61d176',
    brightYellow: '#e3b341',
    brightBlue: '#6cb6ff',
    brightMagenta: '#f7a5cb',
    brightCyan: '#6fd7e0',
    brightWhite: '#ffffff',
  };
}

export function useTerminalTheme(): Record<string, string> {
  const [theme, setTheme] = useState(terminalTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(terminalTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}
