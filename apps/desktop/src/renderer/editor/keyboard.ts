// Keyboard shortcuts and native menu commands → `run` (app spec "Main editor" → Keyboard). Keys typed
// into a text field stay there. Copy and paste also arrive as DOM events from the native Edit menu
// roles (which keep copy/paste working inside text fields).
import { useEffect } from 'react';
import { commandForKey, MENU_COMMANDS, type MenuCommand } from '../../shared/commands.ts';
import { isEditable } from './commands.ts';
import { useCtx } from './context.tsx';

export function useKeyboard(): void {
  const { vox, run } = useCtx();
  useEffect(() => {
    let lastKeyCopy = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditable(e.target as Element | null)) return;
      const c = commandForKey(e);
      if (!c) return;
      e.preventDefault();
      if (c === 'copy' || c === 'paste') lastKeyCopy = Date.now();
      run(c);
    };
    const onClipboard = (c: MenuCommand) => (e: Event) => {
      if (isEditable(document.activeElement) || Date.now() - lastKeyCopy < 200) return;
      e.preventDefault();
      run(c);
    };
    const onCopy = onClipboard('copy');
    const onPaste = onClipboard('paste');
    window.addEventListener('keydown', onKey);
    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);
    const off = vox.on('menu.command', (p) => {
      const c = (p as { command?: unknown } | null)?.command;
      if (typeof c === 'string' && (MENU_COMMANDS as readonly string[]).includes(c)) {
        run(c as MenuCommand);
      }
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('paste', onPaste);
      off();
    };
  }, [vox, run]);
}
