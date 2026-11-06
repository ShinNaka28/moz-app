import { MosaicType, MosaicTrack, Point } from '../types';

/**
 * モザイク描画ユーティリティ
 */

export function applyMosaicEffect(
  ctx: CanvasRenderingContext2D,
  type: MosaicType,
  strength: number,
  drawShapeCallback: () => void,
  bounds: { x: number; y: number; width: number; height: number },
  sourceCanvas: HTMLCanvasElement
) {
  const { x, y, width, height } = bounds;
  if (width <= 0 || height <= 0) return;

  ctx.save();
  ctx.beginPath();
  drawShapeCallback();
  ctx.clip();

  if (type === 'black') {
    // 黒塗り
    ctx.fillStyle = '#000000';
    ctx.fill();
  } else if (type === 'blur') {
    // すりガラスぼかし
    ctx.filter = `blur(${Math.max(2, strength)}px)`;
    // ブラーの境界が薄くならないようにマージンを広げて元画像を転写
    const pad = strength * 2;
    ctx.drawImage(
      sourceCanvas,
      x - pad,
      y - pad,
      width + pad * 2,
      height + pad * 2,
      x - pad,
      y - pad,
      width + pad * 2,
      height + pad * 2
    );
  } else if (type === 'pixel') {
    // ピクセルモザイク
    const pixelSize = Math.max(3, Math.round(strength));
    const smallW = Math.max(1, Math.floor(width / pixelSize));
    const smallH = Math.max(1, Math.floor(height / pixelSize));

    // 一時オフスクリーンキャンバスでモザイク化
    const offscreen = document.createElement('canvas');
    offscreen.width = smallW;
    offscreen.height = smallH;
    const offCtx = offscreen.getContext('2d');
    if (offCtx) {
      offCtx.imageSmoothingEnabled = true;
      offCtx.drawImage(sourceCanvas, x, y, width, height, 0, 0, smallW, smallH);

      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(offscreen, 0, 0, smallW, smallH, x, y, width, height);
      ctx.imageSmoothingEnabled = true;
    }
  }

  ctx.restore();
}

/**
 * 単一トラックのモザイクをキャンバスにレンダリング
 */
export function renderTrackMosaic(
  ctx: CanvasRenderingContext2D,
  track: MosaicTrack,
  pos: { x: number; y: number; width: number; height: number; points?: Point[] },
  sourceCanvas: HTMLCanvasElement
) {
  if (!track.enabled) return;

  const { x, y, width, height, points } = pos;

  if (track.shape === 'rect') {
    applyMosaicEffect(
      ctx,
      track.mosaicType,
      track.strength,
      () => {
        ctx.rect(x, y, width, height);
      },
      { x, y, width, height },
      sourceCanvas
    );
  } else if ((track.shape === 'polygon' || track.shape === 'lasso') && points && points.length >= 3) {
    applyMosaicEffect(
      ctx,
      track.mosaicType,
      track.strength,
      () => {
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
          ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.closePath();
      },
      { x, y, width, height },
      sourceCanvas
    );
  } else if (track.shape === 'brush' && points && points.length >= 2) {
    applyMosaicEffect(
      ctx,
      track.mosaicType,
      track.strength,
      () => {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(16, track.strength * 1.5);
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
          ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.stroke();
      },
      { x, y, width, height },
      sourceCanvas
    );
  }
}

export interface ProtectedRegion {
  shape: 'rect' | 'brush' | 'polygon' | 'lasso';
  x: number;
  y: number;
  width: number;
  height: number;
  points?: Point[];
}

/**
 * 反転モザイク（選択した人物やPC画面以外の「背景全体」にモザイクをかける）
 */
export function renderInverseMosaic(
  ctx: CanvasRenderingContext2D,
  protectedRegions: ProtectedRegion[],
  canvasWidth: number,
  canvasHeight: number,
  type: MosaicType,
  strength: number,
  sourceCanvas: HTMLCanvasElement
) {
  if (canvasWidth <= 0 || canvasHeight <= 0) return;

  ctx.save();
  ctx.beginPath();

  // 外枠: 画面全体
  ctx.rect(0, 0, canvasWidth, canvasHeight);

  // 内枠: 保護対象領域（くり抜き）
  for (const reg of protectedRegions) {
    if ((reg.shape === 'polygon' || reg.shape === 'lasso') && reg.points && reg.points.length >= 3) {
      ctx.moveTo(reg.points[0].x, reg.points[0].y);
      for (let i = 1; i < reg.points.length; i++) {
        ctx.lineTo(reg.points[i].x, reg.points[i].y);
      }
      ctx.closePath();
    } else {
      ctx.rect(reg.x, reg.y, reg.width, reg.height);
    }
  }

  // evenodd 規則でくり抜いて背景全体のみをクリッピング
  ctx.clip('evenodd');

  if (type === 'black') {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  } else if (type === 'blur') {
    ctx.filter = `blur(${Math.max(2, strength)}px)`;
    ctx.drawImage(sourceCanvas, 0, 0, canvasWidth, canvasHeight);
  } else if (type === 'pixel') {
    const pixelSize = Math.max(4, Math.round(strength));
    const smallW = Math.max(1, Math.floor(canvasWidth / pixelSize));
    const smallH = Math.max(1, Math.floor(canvasHeight / pixelSize));

    const offscreen = document.createElement('canvas');
    offscreen.width = smallW;
    offscreen.height = smallH;
    const offCtx = offscreen.getContext('2d');
    if (offCtx) {
      offCtx.imageSmoothingEnabled = true;
      offCtx.drawImage(sourceCanvas, 0, 0, smallW, smallH);

      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(offscreen, 0, 0, smallW, smallH, 0, 0, canvasWidth, canvasHeight);
      ctx.imageSmoothingEnabled = true;
    }
  }

  ctx.restore();
}

/**
 * 編集UI用のガイド枠・選択枠描画
 */
export function renderTrackOverlay(
  ctx: CanvasRenderingContext2D,
  track: MosaicTrack,
  pos: { x: number; y: number; width: number; height: number; points?: Point[] },
  isSelected: boolean,
  hasKeyframeAtCurrentTime: boolean
) {
  const { x, y, width, height, points } = pos;
  ctx.save();

  // 1080p/4K動画でもスマホ画面上で枠線やハンドルが細すぎて消えたように見えないよう解像度に応じてスケール補正
  const scale = Math.max(1, Math.min(3.5, ctx.canvas.width / 720));

  const strokeColor = !track.enabled
    ? '#94a3b8' // 無効時はグレー
    : isSelected
    ? '#38bdf8' // 選択時はシアン
    : track.type === 'ai'
    ? '#10b981' // AIはエメラルド
    : '#f59e0b'; // トラッキングはアンバー

  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = (isSelected ? 3 : 2) * scale;
  ctx.setLineDash(isSelected ? [5 * scale, 5 * scale] : []);

  // 選択枠の内側ハイライト（ドラッグ可能エリアの視覚化）
  if (isSelected) {
    ctx.save();
    ctx.fillStyle = 'rgba(56, 189, 248, 0.16)';
    if (track.shape === 'rect' || !points) {
      ctx.fillRect(x, y, width, height);
    } else if (points && points.length > 0) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      if (track.shape === 'polygon' || track.shape === 'lasso') ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  if (track.shape === 'rect' || !points) {
    ctx.strokeRect(x, y, width, height);
  } else if (points && points.length > 0) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    if (track.shape === 'polygon' || track.shape === 'lasso') ctx.closePath();
    ctx.stroke();

    // 選択中のみリサイズハンドル操作の目安として外枠バウンディングボックスを補助描画（非選択時は体のラインの輪郭線のみをクリアに表示）
    if (isSelected) {
      ctx.save();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
      ctx.lineWidth = 1.5 * scale;
      ctx.setLineDash([3 * scale, 4 * scale]);
      ctx.strokeRect(x, y, width, height);
      ctx.restore();
    }
  }

  // 選択時の四隅ハンドル ＆ 中央移動アイコン
  if (isSelected) {
    const handleSize = Math.round(12 * scale);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2 * scale;
    ctx.setLineDash([]);
    const corners = [
      { cx: x, cy: y },
      { cx: x + width, cy: y },
      { cx: x + width, cy: y + height },
      { cx: x, cy: y + height },
    ];
    for (const c of corners) {
      ctx.fillRect(c.cx - handleSize / 2, c.cy - handleSize / 2, handleSize, handleSize);
      ctx.strokeRect(c.cx - handleSize / 2, c.cy - handleSize / 2, handleSize, handleSize);
    }

    // 枠の中央に「✥ 枠内ドラッグで移動」を表示
    if (width >= 40 * scale && height >= 24 * scale) {
      ctx.save();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      const moveText = '✥ 枠内ドラッグで移動';
      const fontSize = Math.round(11 * scale);
      ctx.font = `bold ${fontSize}px sans-serif`;
      const moveW = ctx.measureText(moveText).width + 12 * scale;
      const moveH = 20 * scale;
      const moveX = x + width / 2 - moveW / 2;
      const moveY = y + height / 2 - moveH / 2;
      ctx.fillRect(moveX, moveY, moveW, moveH);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5 * scale;
      ctx.strokeRect(moveX, moveY, moveW, moveH);

      ctx.fillStyle = '#38bdf8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(moveText, x + width / 2, y + height / 2);
      ctx.restore();
    }
  }

  // ラベルバッジ（トラック名 + ON/OFFステータス）
  ctx.setLineDash([]);
  const label = `${track.name} [${track.enabled ? 'ON' : 'OFF'}]${
    hasKeyframeAtCurrentTime ? ' ★Key' : ''
  }`;
  const badgeFontSize = Math.round(11 * scale);
  ctx.font = `bold ${badgeFontSize}px sans-serif`;
  const textWidth = ctx.measureText(label).width;
  const badgeH = 18 * scale;
  const badgeW = textWidth + 12 * scale;
  const badgeX = x;
  const badgeY = Math.max(0, y - badgeH - 2 * scale);

  ctx.fillStyle = track.enabled ? 'rgba(15, 23, 42, 0.85)' : 'rgba(71, 85, 105, 0.85)';
  ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.5 * scale;
  ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);

  ctx.fillStyle = track.enabled ? '#ffffff' : '#cbd5e1';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, badgeX + 6 * scale, badgeY + badgeH / 2);

  ctx.restore();
}

