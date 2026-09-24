/** Editor chrome follows the embedding console; pet palette remains a separate setting. */
export function bindAppearance(doc, win) {
  const initial = new URLSearchParams(win.location.search).get('appearance');
  const apply = (mode) => {
    if (mode === 'light' || mode === 'dark') doc.documentElement.dataset.uiTheme = mode;
  };
  apply(initial);
  let parentOrigin = null;
  try {
    const ref = new URL(doc.referrer);
    if (ref.protocol === win.location.protocol && ref.hostname === win.location.hostname) parentOrigin = ref.origin;
  } catch { /* A standalone dressing window has no embedding console. */ }
  const onMessage = (event) => {
    if (!parentOrigin || event.source !== win.parent || event.origin !== parentOrigin) return;
    if (event.data?.type === 'companion:appearance') apply(event.data.mode);
  };
  win.addEventListener('message', onMessage);
  return () => win.removeEventListener('message', onMessage);
}
