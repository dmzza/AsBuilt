/**
 * PNG export of the 2D sheet: rasterize the plan SVG onto a canvas at 2x,
 * paper background under it, title block redrawn in the corner so the
 * exported sheet reads like the on-screen one.
 */

const PAPER = "#f5f3ec";
const INK = "#35322b";
const HAIRLINE = "#c9c4b4";
const LABEL = "#6d6a5f";
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

export interface TitleRow {
  label: string;
  value: string;
  conflict?: boolean;
}

function drawTitleBlock(
  ctx: CanvasRenderingContext2D,
  sheetW: number,
  sheetH: number,
  rows: TitleRow[],
): void {
  const width = 272;
  const rowH = 23;
  const labelW = 62;
  const height = rows.length * rowH;
  const x = sheetW - 16 - width;
  const y = sheetH - 16 - height;

  ctx.fillStyle = "rgb(245 243 236 / 0.93)";
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, width, height);

  rows.forEach((row, i) => {
    const ry = y + i * rowH;
    if (i > 0) {
      ctx.strokeStyle = HAIRLINE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, ry);
      ctx.lineTo(x + width, ry);
      ctx.stroke();
    }
    ctx.textBaseline = "middle";
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = LABEL;
    ctx.fillText(row.label.toUpperCase(), x + 10, ry + rowH / 2 + 0.5);
    ctx.font = `11px ${MONO}`;
    ctx.fillStyle = row.conflict === true ? "#c22a2a" : INK;
    ctx.fillText(row.value, x + labelW + 10, ry + rowH / 2 + 0.5);
  });
}

export async function exportPlanPng(
  svg: SVGSVGElement,
  rows: TitleRow[],
  filename: string,
): Promise<void> {
  const w = svg.clientWidth || Number(svg.getAttribute("width")) || 800;
  const h = svg.clientHeight || Number(svg.getAttribute("height")) || 600;

  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  const xml = new XMLSerializer().serializeToString(clone);

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("could not rasterize the plan SVG"));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  });

  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("no 2d canvas context");
  ctx.scale(scale, scale);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  drawTitleBlock(ctx, w, h, rows);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (blob === null) throw new Error("PNG encoding failed");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
