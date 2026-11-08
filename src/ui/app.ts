import { Dirty, Store, type Change } from '../core/store';
import { defaultProject, normaliseProject } from '../core/defaults';
import type { Project, Scene, Source } from '../core/types';
import { Engine } from '../pipeline/engine';
import { embedSource, loadImage, sourceFromCanvas } from '../image/loader';
import { testCard } from '../image/testcard';
import { exportSVG } from '../export/svg';
import { exportPDF } from '../export/pdf';
import { exportPNG } from '../export/png';
import { sceneWeight } from '../render/scene';
import { exportPlates, planPlates } from '../export/plates';
import { imageExtensions, isTauri, openFile, saveFile, saveFiles } from '../platform';
import { button, el, onResize, Panel } from './controls';
import type { Ctx } from './context';
import {
  bandEditorPanel, bandsPanel, ensureLightest, needsRespace, rebuildBands, respace, takePaletteIntoBands,
} from './bands';
import { documentPanel, imagePanel, regionsPanel, tracePanel } from './panels';
import { PRESETS } from './presets';
import { installTouchSliders } from './controls';
import { FreeformOverlay } from './overlay';
import markSvg from '../../assets/brand/mark.svg?raw';
import { guiColourButton } from './guicolours';

/**
 * The shell.
 *
 * Two things here are worth knowing. The preview is the export — the same
 * `exportSVG` that writes the file puts its output into the DOM, so there is no
 * second renderer that can drift from the first. And changes are routed by how
 * far up the pipeline they reach: anything at `Dirty.Fill` redraws inside the
 * frame it arrived in, and only the rest is debounced into a trace.
 */

const TRACE_DEBOUNCE_MS = 180;

export class App {
  private store = new Store(defaultProject());
  private engine = new Engine();
  private ctx: Ctx;
  private panels: Panel[] = [];

  private root: HTMLElement;
  private stage!: HTMLElement;
  private surface!: HTMLElement;
  private photo!: HTMLCanvasElement;
  private statusEl!: HTMLElement;
  /** A bar along the top of the stage while tracing, over the last drawing. */
  private busyEl!: HTMLElement;
  /**
   * What the stage shows before there is a picture: a place to drop one. The
   * app used to open on a synthetic test card so there was always something on
   * screen, but a drawing of a test card you did not ask for is noise to clear
   * before you can begin. The card is still there behind `?testcard`, for the
   * verification run.
   */
  private dropZone!: HTMLElement;

  private selected: string | null = null;
  private view: 'drawing' | 'photo' | 'split' | 'under' = 'drawing';
  private scene: Scene | null = null;
  /** Where the split view's divider sits, 0..1 across the stage. */
  private split = 0.5;
  private splitEl!: HTMLElement;
  private overlay!: FreeformOverlay;
  private selectedPoint: string | null = null;

  private zoom = 1;
  private panX = 0;
  private panY = 0;
  /** Whether the first fit for this picture has happened. */
  private fitted = false;
  /** Set by a pan or zoom; a view framed by hand is left alone on resize. */
  private framedByHand = false;

  private traceTimer: number | null = null;
  private afterTraceQueue: (() => void)[] = [];
  private pending: Change | null = null;
  private running = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.ctx = {
      store: this.store,
      engine: this.engine,
      selectedBand: () => this.selected,
      selectBand: (id) => {
        this.selected = id;
        this.syncPanels();
      },
      refresh: () => this.syncPanels(),
      status: (m, kind) => this.setStatus(m, kind),
      openImage: () => this.openImage(),
      pickColour: (done) => this.startPicking(done),
      afterTrace: (fn) => { this.afterTraceQueue.push(fn); },
      rebuildBands: () => rebuildBands(this.ctx),
      ensureLightest: () => ensureLightest(this.ctx),
      takePaletteIntoBands: () => takePaletteIntoBands(this.ctx),
      respace: (rule) => respace(this.ctx, rule),
      sampleGradient: (bandId) =>
        this.engine.sampledGradientStops(this.store.get() as Project, bandId),
      selectedFreePoint: () => this.selectedPoint,
      selectFreePoint: (id) => {
        this.selectedPoint = id;
        this.syncPanels();
      },
      sampleFreePoints: (bandId) =>
        this.engine.sampledFreePoints(this.store.get() as Project, bandId),
      scatterFreePoints: (bandId, count) =>
        this.engine.scatterFreePoints(this.store.get() as Project, bandId, count),
    };
  }

  async start(): Promise<void> {
    this.build();
    this.store.subscribe((project, change) => void this.onChange(project, change));

    const tools = await this.engine.detectTools();
    // vtracer is compiled in, so a missing potrace is no longer a degraded
    // mode — it is just the other tracer. Switching to it here means the first
    // run on a machine with nothing installed still produces real curves
    // instead of the coarse built-in fallback.
    if (!tools.potrace && isTauri()) {
      this.store.updateTracer('vtracer');
      this.setStatus('potrace not found — tracing with vtracer instead', 'warn');
    }
    if (new URLSearchParams(location.search).has('testcard')) await this.loadTestCard();
    this.applySourceState();
  }

  /** Show the drop zone until there is a picture, and the sheet after. */
  private applySourceState(): void {
    const has = !!this.store.get().source;
    this.dropZone.hidden = has;
    this.surface.hidden = !has;
  }

  /**
   * Handles for the verification script. Only in a dev build, so nothing of it
   * reaches a shipped one.
   */
  private exposeDebug(): void {
    if (!import.meta.env.DEV) return;
    (window as unknown as { contour: unknown }).contour = {
      store: this.store,
      ctx: this.ctx,
      scene: () => this.scene,
      applyPreset: (name: string) => {
        const p = PRESETS.find((x) => x.name === name);
        if (!p) return false;
        p.apply(this.ctx);
        return true;
      },
      presets: PRESETS.map((p) => p.name),
      plates: () => (this.scene ? exportPlates(this.scene) : null),
      exportSVG: () => (this.scene ? exportSVG(this.scene) : ''),
      exportPDF: async () => (this.scene ? exportPDF(this.scene) : null),
      exportPNG: async () => (this.scene ? exportPNG(this.scene, 1) : null),
      view: (v: 'drawing' | 'photo' | 'split' | 'under') => { this.view = v; this.applyView(); },
      busy: () => this.running || this.traceTimer !== null,
    };
  }

  // -- layout ----------------------------------------------------------------

  private build(): void {
    this.root.replaceChildren();
    const app = el('div', 'app');

    // The toolbar reads left to right as the workflow does — bring a picture
    // in, frame it, compare, step through history, start from a preset — with
    // everything that sends work back out grouped on the right. The same order
    // and the same words as Stipple's.
    const bar = el('header', 'toolbar');
    // The mark doubles as the way into the interface colours, top left where
    // a window's own controls would be.
    const brand = el('button', 'brand');
    brand.type = 'button';
    brand.title = 'Interface colours';
    brand.setAttribute('aria-haspopup', 'dialog');
    const mark = el('span', 'brand-mark');
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = markSvg;
    brand.append(mark, 'Contour');
    bar.append(brand);
    guiColourButton(brand);

    const group = (...nodes: HTMLElement[]): HTMLElement => {
      const g = el('div', 'tool-group');
      g.append(...nodes);
      return g;
    };

    bar.append(group(button('Open image\u2026', () => void this.openImage(), {
      className: 'primary', title: 'Open an image to trace (\u2318O)',
    })));
    bar.append(group(
      button('Fit', () => this.fit(), { title: 'Fit the drawing to the window (0)' }),
      button('100%', () => this.zoomTo(1), { title: 'One canvas pixel per screen pixel' }),
    ));

    // How you look at the picture sits with how it is framed. Pressed in rather
    // than lit: yellow means a change to the work, and this changes only the view.
    const views = el('div', 'segmented compare');
    for (const [key, label, title] of [
      ['drawing', 'Drawing', 'The drawing'],
      ['photo', 'Original', 'The photograph, adjusted'],
      ['split', 'Split', 'The photograph left of a divider you drag'],
      ['under', 'Under', 'The photograph showing faintly through the paper'],
    ] as const) {
      const b = el('button', 'seg');
      b.type = 'button';
      b.textContent = label;
      b.title = `${title} (Tab cycles) \u2014 on screen only, never in a file`;
      b.dataset.view = key;
      b.addEventListener('click', () => {
        this.view = key;
        this.applyView();
      });
      views.append(b);
    }
    bar.append(views);

    bar.append(group(
      button('Undo', () => this.store.undo(), { title: 'Undo (\u2318Z)' }),
      button('Redo', () => this.store.redo(), { title: 'Redo (\u21e7\u2318Z)' }),
    ));

    const presetSel = el('select', 'select preset-select');
    presetSel.title = 'Start from a finished look';
    presetSel.append(new Option('Presets\u2026', ''));
    for (const p of PRESETS) {
      const o = new Option(p.name, p.name);
      o.title = p.about;
      presetSel.append(o);
    }
    presetSel.addEventListener('change', () => {
      const p = PRESETS.find((x) => x.name === presetSel.value);
      presetSel.value = '';
      if (!p) return;
      p.apply(this.ctx);
      this.setStatus(`${p.name}: ${p.about}`);
    });
    bar.append(presetSel);

    bar.append(el('span', 'spacer'));
    const caption = el('span', 'tool-caption');
    caption.textContent = 'Export';
    bar.append(caption, this.exportMenu());
    const exportButtons = group(
      button('PNG', () => void this.exportFile('png'), { title: 'A picture file, at the document\u2019s pixel size' }),
      button('SVG', () => void this.exportFile('svg'), { title: 'Vector drawing, sharp at any size (\u2318E)' }),
      button('PDF', () => void this.exportFile('pdf'), { title: 'Vector, print-ready at the document\u2019s size' }),
      button('Plates', () => void this.exportPlateFiles(), {
        title: 'One black-on-white film per band, plus a colour proof \u2014 for screen printing',
      }),
    );
    exportButtons.classList.add('export-buttons');
    bar.append(exportButtons);
    bar.append(group(
      button('Save', () => void this.saveProject(), { title: 'Save the document (\u2318S)' }),
      button('Load', () => void this.loadProject(), { title: 'Open a saved document' }),
    ));

    // Stage
    this.stage = el('main', 'stage');
    this.surface = el('div', 'surface');
    this.photo = el('canvas', 'photo');
    this.surface.append(this.photo);
    const svgHost = el('div', 'svg-host');
    this.surface.append(svgHost);
    this.stage.append(this.surface);

    // Colour-point handles, over the drawing and outside its transform.
    this.overlay = new FreeformOverlay({
      fill: () => {
        const band = this.store.get().bands.find((b) => b.id === this.selected);
        return band && band.fill.kind === 'freeform' ? band.fill : null;
      },
      bbox: () => (this.selected ? this.engine.bandBBox(this.selected) : null),
      toStage: (x, y) => [this.panX + x * this.zoom, this.panY + y * this.zoom],
      toCanvas: (sx, sy) => [(sx - this.panX) / this.zoom, (sy - this.panY) / this.zoom],
      setPoints: (points, key) => {
        const band = this.store.get().bands.find((b) => b.id === this.selected);
        if (!band || band.fill.kind !== 'freeform') return;
        this.store.updateBand(band.id, { fill: { ...band.fill, points } }, key ?? 'free:points');
      },
      selected: () => this.selectedPoint,
      select: (id) => {
        this.selectedPoint = id;
        this.syncPanels();
      },
    });
    this.stage.append(this.overlay.el);

    // The divider lives on the stage rather than inside the surface, so it
    // stays a constant width on screen instead of being scaled by the zoom —
    // a hairline at 8x and a bar four inches wide at 0.1x is not a handle.
    this.splitEl = el('div', 'split-handle');
    this.splitEl.append(el('span', 'split-grip'));
    this.stage.append(this.splitEl);

    this.busyEl = el('div', 'progress');
    const fill = el('div', 'progress-fill');
    const label = el('span', 'progress-label');
    label.textContent = 'Tracing\u2026';
    this.busyEl.append(fill, label);
    this.stage.append(this.busyEl);

    // Quiet, green on green: the backdrop before there is a picture, not a call
    // to action — the Open image button in the toolbar already is one.
    this.dropZone = el('div', 'drop-zone');
    const dzInner = el('div', 'drop-zone-inner');
    const dzTitle = el('p', 'drop-zone-title');
    dzTitle.textContent = 'Drop an image here';
    const dzHint = el('p', 'drop-zone-hint');
    dzHint.textContent = 'PNG, JPEG, WebP or GIF. It stays on your device.';
    dzInner.append(dzTitle, button('Open image\u2026', () => void this.openImage()), dzHint);
    this.dropZone.append(dzInner);
    this.stage.append(this.dropZone);

    // Sidebar
    const side = el('aside', 'sidebar');
    this.panels = [
      documentPanel(this.ctx),
      imagePanel(this.ctx),
      regionsPanel(this.ctx),
      tracePanel(this.ctx),
      bandsPanel(this.ctx),
      bandEditorPanel(this.ctx),
    ];
    for (const p of this.panels) side.append(p.el);

    // Status
    const footer = el('footer', 'statusbar');
    this.statusEl = el('span', 'status-text');
    footer.append(this.statusEl);

    app.append(bar, this.stage, side, footer);
    this.root.append(app);

    this.wireViewport();
    this.wireKeyboard();
    this.wireDrop();
    installTouchSliders(this.root);
    this.applyView();
    this.exposeDebug();
  }

  private applyView(): void {
    this.stage.dataset.view = this.view;
    // Scoped to the toolbar: the stage carries a `data-view` of its own, and an
    // unscoped query would hand it the button styling too.
    for (const b of this.root.querySelectorAll<HTMLElement>('.toolbar [data-view]')) {
      b.classList.toggle('on', b.dataset.view === this.view);
    }
    this.applySplit();
  }

  /**
   * Put the divider where it belongs, in stage coordinates.
   *
   * The clip is expressed as a percentage of the *surface*, which is under the
   * zoom and pan transform, while the handle is on the stage, which is not. So
   * the one number the user drags has to be converted into the surface's frame
   * — otherwise the seam and the handle part company the moment anyone zooms,
   * which is exactly when a comparison is worth making.
   */
  private applySplit(): void {
    const x = this.split;
    this.splitEl.style.left = `${x * 100}%`;
    const rect = this.stage.getBoundingClientRect();
    const width = Math.max(1, this.store.get().canvas.width * this.zoom);
    const inSurface = Math.min(1, Math.max(0, (x * rect.width - this.panX) / width));
    this.surface.style.setProperty('--split', `${inSurface * 100}%`);
  }

  // -- viewport --------------------------------------------------------------

  private wireViewport(): void {

    // Dragging the divider is a drag on the stage, so it has to claim the
    // pointer before the pan handler sees it.
    this.splitEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.splitEl.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const rect = this.stage.getBoundingClientRect();
        this.split = Math.min(1, Math.max(0, (ev.clientX - rect.left) / Math.max(1, rect.width)));
        this.applySplit();
      };
      const up = () => {
        this.splitEl.removeEventListener('pointermove', move);
        this.splitEl.removeEventListener('pointerup', up);
        this.splitEl.removeEventListener('pointercancel', up);
      };
      this.splitEl.addEventListener('pointermove', move);
      this.splitEl.addEventListener('pointerup', up);
      this.splitEl.addEventListener('pointercancel', up);
      move(e);
    });

    // Every pointer on the stage, by id. One pans; two pinch — zooming by the
    // change in their spread and panning by the travel of their midpoint, so the
    // point between your fingers stays under your fingers.
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; midX: number; midY: number } | null = null;
    const spread = (): { dist: number; midX: number; midY: number } => {
      const [a, b] = [...pointers.values()];
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
    };

    this.stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      // A colour-point handle, or a button on the drop zone, has claimed this press.
      if ((e.target as HTMLElement).closest('.free-handle, .drop-zone button')) return;
      if (this.picking) {
        this.pickAt(e.clientX, e.clientY);
        return;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.stage.setPointerCapture(e.pointerId);
      this.stage.classList.add('panning');
      pinch = pointers.size === 2 ? spread() : null;
    });
    this.stage.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pinch && pointers.size === 2) {
        const now = spread();
        this.panX += now.midX - pinch.midX;
        this.panY += now.midY - pinch.midY;
        if (pinch.dist > 0) this.zoomAbout(now.midX, now.midY, this.zoom * (now.dist / pinch.dist));
        pinch = now;
      } else if (pointers.size === 1) {
        this.panX += dx;
        this.panY += dy;
      } else {
        return;
      }
      this.framedByHand = true;
      this.applyTransform();
    });
    const stop = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      // Lifting one finger of a pinch leaves the other panning from where it is.
      pinch = null;
      if (!pointers.size) this.stage.classList.remove('panning');
    };
    this.stage.addEventListener('pointerup', stop);
    this.stage.addEventListener('pointercancel', stop);

    // Double-click or double-tap: on a freeform band it adds a colour point,
    // anywhere else it fits the drawing to the window.
    let lastTap = 0;
    const doubled = (x: number, y: number): void => {
      if (!this.overlay.addPointAt(x, y)) this.fit();
    };
    this.stage.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.free-handle, .drop-zone')) return;
      e.preventDefault();
      doubled(e.clientX, e.clientY);
    });
    this.stage.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'touch') return;
      const now = performance.now();
      if (now - lastTap < 300) doubled(e.clientX, e.clientY);
      lastTap = now;
    });

    this.stage.addEventListener('wheel', (e) => {
      // Alt-scroll over a colour point resizes it rather than zooming.
      if (e.altKey && (e.target as HTMLElement).closest('.free-handle')) return;
      e.preventDefault();
      this.zoomAbout(e.clientX, e.clientY, this.zoom * Math.exp(-e.deltaY * 0.0015));
      this.framedByHand = true;
      this.applyTransform();
    }, { passive: false });

    // Rotating a phone, or resizing the window, keeps a fitted view fitted; a
    // view framed by hand is left exactly where it was put. Through the helper,
    // because a bare `new ResizeObserver` takes the app down on a host without one.
    onResize(this.stage, () => {
      if (!this.framedByHand) this.fit();
      else this.applySplit();
    });
  }

  /**
   * Zoom about a point on screen: the point under it must not move, which is
   * what makes zooming in on a detail feel like a magnifier rather than a jump.
   */
  private zoomAbout(clientX: number, clientY: number, target: number): void {
    const rect = this.stage.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const next = Math.min(40, Math.max(0.02, target));
    const k = next / this.zoom;
    this.panX = cx - (cx - this.panX) * k;
    this.panY = cy - (cy - this.panY) * k;
    this.zoom = next;
  }

  private zoomTo(zoom: number): void {
    const rect = this.stage.getBoundingClientRect();
    this.zoomAbout(rect.left + rect.width / 2, rect.top + rect.height / 2, zoom);
    this.framedByHand = true;
    this.applyTransform();
  }

  private applyTransform(): void {
    this.surface.style.transform =
      `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    const pct = Math.round(this.zoom * 100);
    this.statusEl.dataset.zoom = `${pct}%`;
    this.applySplit();
    this.overlay.render();
    this.renderStatus();
  }

  private fit(): void {
    const { width, height } = this.store.get().canvas;
    const rect = this.stage.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    // A smaller margin on a small screen, where 48px is a sixth of the width.
    const margin = Math.min(48, Math.min(rect.width, rect.height) * 0.06);
    this.zoom = Math.min(
      (rect.width - margin) / width,
      (rect.height - margin) / height,
    );
    this.panX = (rect.width - width * this.zoom) / 2;
    this.panY = (rect.height - height * this.zoom) / 2;
    this.fitted = true;
    this.framedByHand = false;
    this.applyTransform();
  }

  // -- change routing --------------------------------------------------------

  private async onChange(_project: Project, change: Change): Promise<void> {
    const worstBand = Math.max(Dirty.None, ...[...change.bands.values()]);
    const level = Math.max(change.global, worstBand);

    this.syncPanels();

    if (level <= Dirty.Fill) {
      // Nothing about the geometry moved, so the scene can be rebuilt now and
      // the drag stays live.
      this.render();
      return;
    }

    this.pending = this.pending ? mergeChange(this.pending, change) : change;
    if (this.traceTimer !== null) clearTimeout(this.traceTimer);
    this.busyEl.classList.add('on');
    this.traceTimer = window.setTimeout(() => void this.runPipeline(), TRACE_DEBOUNCE_MS);
  }

  /**
   * Run one pass, and run again afterwards if anything arrived while it ran.
   *
   * The obvious version of this polls: if a trace is already in flight, set
   * another timer and try again in a moment. That works, but it means a slow
   * trace is woken every 180 ms to be told to go back to sleep, and the change
   * that was waiting is picked up whenever the polling happens to land rather
   * than the instant the tracer is free. Here the running pass hands over to
   * the next one itself, so there is exactly one wake-up and no latency beyond
   * the work.
   */
  private async runPipeline(): Promise<void> {
    if (this.running) return;
    const change = this.pending;
    this.pending = null;
    this.traceTimer = null;
    if (!change) {
      this.busyEl.classList.remove('on');
      return;
    }

    this.running = true;
    const started = performance.now();
    try {
      const project = this.store.get() as Project;
      if (change.global >= Dirty.All) await this.engine.setSource(project);
      const result = await this.engine.update(project, change);
      if (result.stale) return;

      this.render();

      // A new image brings a new histogram, so the automatic spacing rules have
      // a different answer than they had for the last one. Applying it here
      // rather than inside the pipeline keeps the bands' thresholds the single
      // source of truth; the guard means it costs a second pass only when the
      // first one actually landed somewhere else.
      if (change.global >= Dirty.All) {
        // A document from an older build may end without its lightest band.
        ensureLightest(this.ctx);
        if (needsRespace(this.ctx)) respace(this.ctx);
      }

      // Work that was waiting for this trace — a palette it has just solved.
      const waiting = this.afterTraceQueue.splice(0);
      for (const fn of waiting) fn();

      const total = Math.round(performance.now() - started);
      const errors = [...result.errors.values()];
      if (errors.length) {
        this.setStatus(`Trace: ${errors[0]}`, 'error');
      } else if (result.fallbackReason) {
        this.setStatus(
          `Falling back to the built-in tracer: ${result.fallbackReason}`,
          'warn',
        );
      } else {
        const named = { potrace: 'potrace', vtracer: 'vtracer', builtin: 'the built-in tracer' };
        this.setStatus(`Traced in ${total} ms with ${named[result.engine]}`);
      }
    } catch (err) {
      this.setStatus((err as Error).message, 'error');
    } finally {
      this.running = false;
      this.syncPanels();
      if (this.pending) {
        // Something landed mid-trace. Its own timer may still be pending, so
        // clear it rather than letting two passes start from one change.
        if (this.traceTimer !== null) clearTimeout(this.traceTimer);
        this.traceTimer = null;
        void this.runPipeline();
      } else {
        this.busyEl.classList.remove('on');
      }
    }
  }

  private render(): void {
    const project = this.store.get() as Project;
    this.scene = this.engine.scene(project);

    const host = this.surface.querySelector('.svg-host')!;
    host.innerHTML = exportSVG(this.scene, { inline: true });
    const svg = host.querySelector('svg');
    if (svg) {
      // The file states its size in inches so it opens correctly in an editor;
      // on screen it has to fill the canvas element instead.
      svg.setAttribute('width', String(project.canvas.width));
      svg.setAttribute('height', String(project.canvas.height));
    }
    this.surface.style.width = `${project.canvas.width}px`;
    this.surface.style.height = `${project.canvas.height}px`;
    // The surface is what the drop shadow is cast by, so it cannot simply be
    // made transparent — a transparent document still has to read as a sheet.
    // The checker says "nothing here" without pretending the sheet is white.
    this.surface.classList.toggle('transparent', project.canvas.paper === null);

    this.drawPhoto();
    if (!this.fitted) this.fit();
    this.renderStatus();
  }

  private drawPhoto(): void {
    const img = this.engine.adjustedImage();
    if (!img) return;
    const { width, height } = this.store.get().canvas;
    // Clear first: the canvas is reused across images and `putImageData`
    // overwrites rather than composites, but a smaller image would otherwise
    // leave the previous one showing round its edge.
    this.photo.getContext('2d')?.clearRect(0, 0, this.photo.width, this.photo.height);
    this.photo.width = img.width;
    this.photo.height = img.height;
    this.photo.style.width = `${width}px`;
    this.photo.style.height = `${height}px`;
    const g = this.photo.getContext('2d')!;
    g.putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
  }

  private renderStatus(): void {
    if (!this.scene) return;
    const { nodes, bytes } = sceneWeight(this.scene);
    const size = this.engine.workingSize();
    const zoom = this.statusEl.dataset.zoom ?? '100%';
    const msg = this.statusEl.dataset.message ?? '';
    this.statusEl.textContent =
      `${msg}${msg ? '  ·  ' : ''}${nodes} node${nodes === 1 ? '' : 's'}  ·  ` +
      `${(bytes / 1024).toFixed(0)} KB of path data  ·  traced at ${size.width}x${size.height}  ·  ${zoom}`;
  }

  private setStatus(message: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
    this.statusEl.dataset.message = message;
    this.statusEl.className = `status-text ${kind}`;
    this.renderStatus();
  }

  private syncPanels(): void {
    for (const p of this.panels) p.sync();
    this.overlay.render();
  }

  // -- files -----------------------------------------------------------------

  /**
   * Take a new source, and take its shape with it.
   *
   * The canvas keeps its long edge and adopts the photograph's aspect ratio.
   * Without this, opening a 4:3 photo into the square default silently
   * stretches the drawing, and the distortion is easy to miss precisely
   * because everything in the frame is distorted by the same amount.
   * Loading a `.contour` document does not go through here: that file has a
   * canvas of its own and it is not up for negotiation.
   */
  private adoptSource(source: Source): void {
    const c = this.store.get().canvas;
    const longEdge = Math.max(c.width, c.height);
    const scale = longEdge / Math.max(1, source.width, source.height);
    const canvas: Partial<Project['canvas']> = {
      width: Math.max(16, Math.round(source.width * scale)),
      height: Math.max(16, Math.round(source.height * scale)),
    };
    // A cut-out is being used as a cut-out. Someone who opens a figure on a
    // transparent ground and gets it back on a white plate has to find the
    // paper control and guess that it is the one at fault; someone who wanted
    // paper can set it in one click, and the status line says so.
    if (source.transparent && c.paper !== null) canvas.paper = null;
    this.store.updateCanvas(canvas, 'canvas:adopt');
    this.store.setSource(source);
    this.fitted = false;
    this.applySourceState();
    if (source.transparent) {
      this.setStatus(`${source.name} has a transparent background — paper set to none`);
    }
  }

  private async openImage(): Promise<void> {
    const extensions = await imageExtensions();
    const picked = await openFile([{ name: 'Images', extensions }]);
    if (!picked) return;
    try {
      const img = await loadImage(picked.bytes, picked.path);
      this.adoptSource(await embedSource(img, picked.name));
      this.setStatus(`Opened ${picked.name}`);
    } catch (err) {
      this.setStatus((err as Error).message, 'error');
    }
  }

  private async loadTestCard(): Promise<void> {
    this.adoptSource(await sourceFromCanvas(testCard(), 'Test card'));
  }

  private async saveProject(): Promise<void> {
    const json = JSON.stringify(this.store.get(), null, 1);
    // iOS file pickers match by type, not extension, and know nothing of
    // `.contour` — a document saved under that name in a browser could not be
    // picked again. In a browser it is JSON by name as well as by content.
    const name = isTauri() ? 'drawing.contour' : 'drawing.contour.json';
    const ok = await saveFile(json, name, [
      { name: 'Contour document', extensions: ['contour'] },
    ]);
    if (ok) this.setStatus('Document saved');
  }

  private async loadProject(): Promise<void> {
    const picked = await openFile(
      [{ name: 'Contour document', extensions: ['contour', 'json'] }],
      { anyInBrowser: true },
    );
    if (!picked) return;
    this.openDocument(picked.name, picked.bytes);
  }

  /**
   * Read a saved document, and say so plainly when a file is not one, rather
   * than failing three modules downstream on a missing field.
   */
  private openDocument(name: string, bytes: Uint8Array): boolean {
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      this.setStatus(`${name} is not a Contour document`, 'error');
      return false;
    }
    const d = data as Partial<Project> | null;
    if (!d || typeof d !== 'object' || !Array.isArray(d.bands) || !d.canvas) {
      this.setStatus(`${name} is not a Contour document`, 'error');
      return false;
    }
    this.store.load(normaliseProject(d));
    this.fitted = false;
    this.applySourceState();
    this.setStatus(`Opened ${name}`);
    return true;
  }

  private async exportFile(kind: 'svg' | 'pdf' | 'png'): Promise<void> {
    if (!this.scene) return;
    try {
      if (kind === 'svg') {
        const text = exportSVG(this.scene);
        const ok = await saveFile(text, 'drawing.svg', [{ name: 'SVG', extensions: ['svg'] }]);
        if (ok) this.setStatus(`Exported SVG — ${(text.length / 1024).toFixed(0)} KB`);
      } else if (kind === 'pdf') {
        const bytes = await exportPDF(this.scene);
        const ok = await saveFile(bytes, 'drawing.pdf', [{ name: 'PDF', extensions: ['pdf'] }]);
        if (ok) this.setStatus(`Exported PDF — ${(bytes.length / 1024).toFixed(0)} KB`);
      } else {
        const bytes = await exportPNG(this.scene, 1);
        const ok = await saveFile(bytes, 'drawing.png', [{ name: 'PNG', extensions: ['png'] }]);
        if (ok) this.setStatus(`Exported PNG — ${(bytes.length / 1024).toFixed(0)} KB`);
      }
    } catch (err) {
      this.setStatus(`Export failed: ${(err as Error).message}`, 'error');
    }
  }

  /**
   * Export as one menu whose every entry says what it makes. The buttons rely
   * on tooltips to explain themselves and a touch screen has no hover, so the
   * stylesheet shows this in their place under a coarse pointer.
   */
  private exportMenu(): HTMLElement {
    const sel = el('select', 'select export-select');
    sel.setAttribute('aria-label', 'Export');
    const entries: [string, string, () => void][] = [
      ['png', 'PNG \u2014 a picture file, at the document\u2019s pixel size', () => void this.exportFile('png')],
      ['svg', 'SVG \u2014 vector drawing, sharp at any size', () => void this.exportFile('svg')],
      ['pdf', 'PDF \u2014 vector, print-ready at the document\u2019s size', () => void this.exportFile('pdf')],
      ['plates', 'Plates \u2014 one black film per band, for burning screens', () => void this.exportPlateFiles()],
    ];
    sel.append(new Option('Export\u2026', ''));
    for (const [value, label] of entries) sel.append(new Option(label, value));
    sel.addEventListener('change', () => {
      const entry = entries.find(([v]) => v === sel.value);
      sel.value = '';
      entry?.[2]();
    });
    return sel;
  }

  private async exportPlateFiles(): Promise<void> {
    if (!this.scene) return;
    const plan = planPlates(this.scene);
    if (!plan.films.length) {
      this.setStatus('No band is a single ink, so there is nothing to make a film of', 'warn');
      return;
    }
    const { files, skipped, paper } = exportPlates(this.scene);
    const res = await saveFiles(files);
    if (res.dir === null) return;
    const bare = paper.length ? ` \u2014 ${paper.join(', ')} prints as the paper` : '';
    const left = (skipped.length ? ` \u2014 left out, not one ink: ${skipped.join(', ')}` : '') + bare;
    const failed = res.failed.length ? ` \u2014 ${res.failed.length} could not be written` : '';
    this.setStatus(`Exported ${files.length - 1} plates and a proof${left}${failed}`, skipped.length || failed ? 'warn' : 'info');
  }

  // -- picking a colour from the picture --------------------------------------

  /** While set, the next click on the stage samples the picture there. */
  private picking: ((rgb: [number, number, number]) => void) | null = null;

  private startPicking(done: (rgb: [number, number, number]) => void): void {
    this.picking = done;
    this.stage.classList.add('picking');
    if (this.view === 'drawing') {
      // You are choosing from the photograph, so show it.
      this.view = 'split';
      this.applyView();
    }
    this.setStatus('Click the picture to pick a colour \u2014 Esc to cancel');
  }

  private stopPicking(message?: string): void {
    this.picking = null;
    this.stage.classList.remove('picking');
    if (message) this.setStatus(message);
  }

  private pickAt(clientX: number, clientY: number): void {
    const img = this.engine.adjustedImage();
    const done = this.picking;
    if (!img || !done) return this.stopPicking();
    const rect = this.stage.getBoundingClientRect();
    const { width, height } = this.store.get().canvas;
    const cx = (clientX - rect.left - this.panX) / this.zoom;
    const cy = (clientY - rect.top - this.panY) / this.zoom;
    if (cx < 0 || cy < 0 || cx >= width || cy >= height) return;
    const x = Math.min(img.width - 1, Math.floor((cx / width) * img.width));
    const y = Math.min(img.height - 1, Math.floor((cy / height) * img.height));
    // A 5x5 average, so a pick lands on the colour of the place, not of one
    // pixel of grain in it.
    let r = 0, g = 0, b = 0, n = 0;
    for (let j = -2; j <= 2; j++) {
      for (let i = -2; i <= 2; i++) {
        const xx = Math.min(img.width - 1, Math.max(0, x + i));
        const yy = Math.min(img.height - 1, Math.max(0, y + j));
        const o = (yy * img.width + xx) * 4;
        if (img.rgba[o + 3] < 8) continue;
        r += img.rgba[o]; g += img.rgba[o + 1]; b += img.rgba[o + 2]; n++;
      }
    }
    this.stopPicking();
    if (n) done([r / n / 255, g / n / 255, b / n / 255]);
  }

  // -- input -----------------------------------------------------------------

  private wireKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const meta = e.metaKey || e.ctrlKey;

      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.store.redo();
        else this.store.undo();
      } else if (meta && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void this.openImage();
      } else if (meta && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void this.saveProject();
      } else if (meta && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        void this.exportFile('svg');
      } else if (e.key === '0' && meta) {
        e.preventDefault();
        this.fit();
      } else if (e.key === 'f' || e.key === '0') {
        this.fit();
      } else if (e.key === 'Escape' && this.picking) {
        this.stopPicking('Picking cancelled');
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const order = ['drawing', 'photo', 'split', 'under'] as const;
        this.view = order[(order.indexOf(this.view) + 1) % order.length];
        this.applyView();
      }
    });
  }

  private wireDrop(): void {
    const stop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    for (const type of ['dragenter', 'dragover', 'dragleave'] as const) {
      window.addEventListener(type, (e) => {
        stop(e);
        this.stage.classList.toggle('drop', type !== 'dragleave');
      });
    }
    window.addEventListener('drop', (e) => {
      stop(e);
      this.stage.classList.remove('drop');
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      void (async () => {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (/\.contour(\.json)?$|\.json$/.test(file.name)) {
            this.openDocument(file.name, bytes);
          } else {
            const img = await loadImage(bytes);
            this.adoptSource(await embedSource(img, file.name));
            this.setStatus(`Opened ${file.name}`);
          }
        } catch (err) {
          this.setStatus((err as Error).message, 'error');
        }
      })();
    });
  }
}

function mergeChange(a: Change, b: Change): Change {
  const bands = new Map(a.bands);
  for (const [id, level] of b.bands) {
    bands.set(id, Math.max(bands.get(id) ?? Dirty.None, level));
  }
  return {
    bands,
    structural: a.structural || b.structural,
    global: Math.max(a.global, b.global),
  };
}
