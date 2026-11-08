import './style.css';
import { App } from './ui/app';

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
