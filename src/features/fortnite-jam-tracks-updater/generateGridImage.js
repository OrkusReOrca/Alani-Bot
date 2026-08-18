import { createCanvas, loadImage } from "canvas";

const COLUMNS = 8;
const CELL_IMAGE_SIZE = 120;
const CELL_PADDING = 12;
const LABEL_HEIGHT = 40;
const CELL_WIDTH = CELL_IMAGE_SIZE + CELL_PADDING * 2;
const CELL_HEIGHT = CELL_IMAGE_SIZE + LABEL_HEIGHT + CELL_PADDING * 2;
const HEADER_HEIGHT = 70;
const NEW_TRACK_BORDER_COLOR = "#22c55e";
const BACKGROUND_COLOR = "#000000";

function wrapTitle(ctx, title, maxWidth) {
  // At most 2 lines; second line gets an ellipsis if the title is still
  // too long to fit, rather than silently truncating single-word titles.
  const words = title.split(" ");
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      current = word;
      if (lines.length === 2) break;
    } else {
      current = candidate;
    }
  }
  if (lines.length < 2 && current) lines.push(current);

  if (lines.length === 2 && ctx.measureText(lines[1]).width > maxWidth) {
    while (ctx.measureText(lines[1] + "…").width > maxWidth && lines[1].length > 1) {
      lines[1] = lines[1].slice(0, -1);
    }
    lines[1] += "…";
  }

  return lines;
}

// tracks: sorted newest-to-oldest by shop add date. newTrackIds: Set of
// track ids to highlight with a green border. Returns a PNG Buffer.
export async function generateShopGridImage(tracks, newTrackIds, dateLabel) {
  const rows = Math.ceil(tracks.length / COLUMNS);
  const width = COLUMNS * CELL_WIDTH;
  const height = HEADER_HEIGHT + rows * CELL_HEIGHT;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = BACKGROUND_COLOR;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 28px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`Jam Tracks Shop — ${dateLabel}`, width / 2, 46);

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const col = i % COLUMNS;
    const row = Math.floor(i / COLUMNS);
    const cellX = col * CELL_WIDTH;
    const cellY = HEADER_HEIGHT + row * CELL_HEIGHT;
    const imageX = cellX + CELL_PADDING;
    const imageY = cellY + CELL_PADDING;

    try {
      const res = await fetch(track.image);
      const buffer = Buffer.from(await res.arrayBuffer());
      const img = await loadImage(buffer);
      ctx.drawImage(img, imageX, imageY, CELL_IMAGE_SIZE, CELL_IMAGE_SIZE);
    } catch {
      ctx.fillStyle = "#333333";
      ctx.fillRect(imageX, imageY, CELL_IMAGE_SIZE, CELL_IMAGE_SIZE);
    }

    if (newTrackIds.has(track.id)) {
      ctx.strokeStyle = NEW_TRACK_BORDER_COLOR;
      ctx.lineWidth = 4;
      ctx.strokeRect(imageX - 2, imageY - 2, CELL_IMAGE_SIZE + 4, CELL_IMAGE_SIZE + 4);
    }

    ctx.fillStyle = "#ffffff";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    const lines = wrapTitle(ctx, track.title.toUpperCase(), CELL_IMAGE_SIZE);
    const textStartY = imageY + CELL_IMAGE_SIZE + 16;
    lines.forEach((line, idx) => {
      ctx.fillText(line, imageX + CELL_IMAGE_SIZE / 2, textStartY + idx * 14);
    });
  }

  return canvas.toBuffer("image/png");
}
