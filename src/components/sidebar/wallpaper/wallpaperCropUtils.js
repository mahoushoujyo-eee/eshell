export const MAX_CUSTOM_WALLPAPER_DATA_URL_LENGTH = 2_900_000;
export const CROP_OUTPUT_WIDTH = 1920;
export const CROP_OUTPUT_HEIGHT = 1080;
export const CROP_PREVIEW_WIDTH = 960;
export const CROP_PREVIEW_HEIGHT = 540;

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const getCoverMetrics = ({ image, targetWidth, targetHeight, zoom }) => {
  const safeZoom = clamp(Number(zoom) || 1, 1, 3);
  const baseScale = Math.max(targetWidth / image.naturalWidth, targetHeight / image.naturalHeight);
  const scaledWidth = image.naturalWidth * baseScale * safeZoom;
  const scaledHeight = image.naturalHeight * baseScale * safeZoom;

  return {
    scaledWidth,
    scaledHeight,
    maxOffsetX: Math.max(0, (scaledWidth - targetWidth) / 2),
    maxOffsetY: Math.max(0, (scaledHeight - targetHeight) / 2),
  };
};

export const drawCroppedWallpaper = ({ ctx, image, targetWidth, targetHeight, zoom, panX, panY }) => {
  const metrics = getCoverMetrics({ image, targetWidth, targetHeight, zoom });
  const safePanX = clamp(Number(panX) || 0, -1, 1);
  const safePanY = clamp(Number(panY) || 0, -1, 1);

  const drawX = (targetWidth - metrics.scaledWidth) / 2 + safePanX * metrics.maxOffsetX;
  const drawY = (targetHeight - metrics.scaledHeight) / 2 + safePanY * metrics.maxOffsetY;

  ctx.clearRect(0, 0, targetWidth, targetHeight);
  ctx.fillStyle = "#081214";
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(image, drawX, drawY, metrics.scaledWidth, metrics.scaledHeight);

  return metrics;
};

export const exportCanvasDataUrl = (canvas) => {
  const qualities = [0.9, 0.82, 0.74];
  for (const quality of qualities) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (dataUrl.length <= MAX_CUSTOM_WALLPAPER_DATA_URL_LENGTH) {
      return dataUrl;
    }
  }
  return canvas.toDataURL("image/jpeg", 0.66);
};
