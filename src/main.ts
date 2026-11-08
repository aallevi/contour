import './style.css';
import { App } from './ui/app';
import { restoreGuiColours } from './ui/guicolours';
import { marbleTile } from './ui/marble';

// The viewer's own interface colours, on before anything is drawn.
restoreGuiColours();
// The marbled ground for the stage takes a moment to comb, so it is
// drawn once the app is up; the plain stage colour stands in until then.
setTimeout(() => {
  const tile = marbleTile();
  if (tile) document.documentElement.style.setProperty('--marble', `url(${tile})`);
}, 0);

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

const app = new App(root);
app.start().catch((err: Error) => {
  // A failure before the UI exists has nowhere to show itself, so say it plainly
  // rather than leaving a blank window and a console nobody opened.
  root.innerHTML = `<div class="fatal"><h1>Contour could not start</h1><p></p></div>`;
  root.querySelector('p')!.textContent = err.message;
  throw err;
});
