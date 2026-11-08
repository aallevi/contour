/**
 * The image the app opens on.
 *
 * Starting on a blank canvas makes every control inert, and inert controls
 * teach nothing. This is built to exercise the whole pipeline at once: a lit
 * sphere for smooth tone that posterises into clean nested bands, a hard-edged
 * bar for contours with real corners, a fine gradient wedge for watching
 * thresholds move, and a scatter of small discs for seeing what `turdsize`
 * actually suppresses.
 */
export function testCard(width = 900, height = 900): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d')!;

  g.fillStyle = '#f2efe9';
  g.fillRect(0, 0, width, height);

  // Lit sphere, off-centre highlight.
  const cx = width * 0.42;
  const cy = height * 0.44;
  const r = Math.min(width, height) * 0.3;
  const sphere = g.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.05, cx, cy, r);
  sphere.addColorStop(0, '#ffffff');
  sphere.addColorStop(0.35, '#c9b89a');
  sphere.addColorStop(0.75, '#6b5537');
  sphere.addColorStop(1, '#241a10');
  g.fillStyle = sphere;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();

  // Contact shadow, so the sphere's darkest band has somewhere to go.
  const shadow = g.createRadialGradient(cx, cy + r * 1.02, r * 0.1, cx, cy + r * 1.02, r * 0.85);
  shadow.addColorStop(0, 'rgba(20,14,8,0.65)');
  shadow.addColorStop(1, 'rgba(20,14,8,0)');
  g.fillStyle = shadow;
  g.beginPath();
  g.ellipse(cx, cy + r * 1.02, r * 0.85, r * 0.22, 0, 0, Math.PI * 2);
  g.fill();

  // A hard-edged solid: corners for the corner threshold to work on.
  g.fillStyle = '#2b2118';
  g.fillRect(width * 0.7, height * 0.16, width * 0.16, height * 0.42);
  g.fillStyle = '#f2efe9';
  g.fillRect(width * 0.735, height * 0.28, width * 0.09, height * 0.12);

  // Continuous wedge along the foot.
  const wedge = g.createLinearGradient(0, 0, width, 0);
  wedge.addColorStop(0, '#000000');
  wedge.addColorStop(1, '#ffffff');
  g.fillStyle = wedge;
  g.fillRect(0, height * 0.86, width, height * 0.14);

  // Speckle of decreasing size, for turdsize.
  g.fillStyle = '#1b1510';
  for (let i = 0; i < 26; i++) {
    const t = i / 25;
    const rr = 1 + (1 - t) * 7;
    g.beginPath();
    g.arc(width * (0.14 + t * 0.62), height * (0.72 + Math.sin(t * 7) * 0.03), rr, 0, Math.PI * 2);
    g.fill();
  }

  return c;
}
