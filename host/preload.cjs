// The only surface the pet page gets from the window process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petHost', {
  /** true: the window takes the mouse; false: clicks pass through to what is underneath. */
  setInteractive: (on) => ipcRenderer.send('pet:interactive', !!on),
  focus: () => ipcRenderer.send('pet:focus'),
  /** Takes the keyboard from whatever window has it (a question's number keys), and gives it back. */
  grabFocus: () => ipcRenderer.send('pet:grabFocus'),
  releaseFocus: () => ipcRenderer.send('pet:releaseFocus'),
  hide: () => ipcRenderer.send('pet:hide'),
  openDress: () => ipcRenderer.send('pet:openDress'),
  /** Screen pixels behind `rect`, minus `skip` rects (page coordinates), as a flat [r, g, b, …]; null where the screen cannot be read. */
  sampleBackdrop: (rect, skip) => ipcRenderer.invoke('pet:sampleBackdrop', { rect, skip }),
});
