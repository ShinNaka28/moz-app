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

  const strokeColor = !track.enabled
    ? '#94a3b8' // 無効時はグレー
    : isSelected
    ? '#38bdf8' // 選択時はシアン
    : track.type === 'ai'
    ? '#10b981' // AIはエメラルド
    : '#f59e0b'; // トラッキングはアンバー

  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = isSelected ? 2.5 : 1.5;
  ctx.setLineDash(isSelected ? [4, 4] : []);

  if (track.shape === 'rect' || !points) {
    ctx.strokeRect(x, y, width, height);

    // 四隅のハンドル（選択時）
    if (isSelected) {
      const handleSize = 8;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = strokeColor;
      ctx.setLineDash([]);
      const corners = [
        { cx: x, cy: y },
        { cx: x + width, cy: y },
        { cx: x, cy: y + height },
        { cx: x + width, cy: y + height },
      ];
      for (const c of corners) {
        ctx.fillRect(c.cx - handleSize / 2, c.cy - handleSize / 2, handleSize, handleSize);
        ctx.strokeRect(c.cx - handleSize / 2, c.cy - handleSize / 2, handleSize, handleSize);
      }
    }
  } else if (points && points.length > 0) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    if (track.shape === 'polygon' || track.shape === 'lasso') ctx.closePath();
    ctx.stroke();
  }

  // ラベルバッジ（トラック名 + ON/OFFステータス）
  ctx.setLineDash([]);
  const label = `${track.name} [${track.enabled ? 'ON' : 'OFF'}]${
    hasKeyframeAtCurrentTime ? ' ★Key' : ''
  }`;
  ctx.font = 'bold 11px sans-serif';
  const textWidth = ctx.measureText(label).width;
  const badgeH = 18;
  const badgeW = textWidth + 12;
  const badgeX = x;
  const badgeY = Math.max(0, y - badgeH - 2);

  ctx.fillStyle = track.enabled ? 'rgba(15, 23, 42, 0.85)' : 'rgba(71, 85, 105, 0.85)';
  ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1;
  ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);

  ctx.fillStyle = track.enabled ? '#ffffff' : '#cbd5e1';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, badgeX + 6, badgeY + badgeH / 2);

  // 選択中の場合はバッジ横に直接タップできる「✕ 削除」ボタンを描画
  if (isSelected) {
    const delBtnW = 48;
    const delBtnH = badgeH;
    const delBtnX = badgeX + badgeW + 4;
    const delBtnY = badgeY;

    ctx.fillStyle = '#b91c1c'; // 赤色
    ctx.fillRect(delBtnX, delBtnY, delBtnW, delBtnH);
    ctx.strokeStyle = '#f87171';
    ctx.lineWidth = 1;
    ctx.strokeRect(delBtnX, delBtnY, delBtnW, delBtnH);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('✕ 削除', delBtnX + delBtnW / 2, delBtnY + delBtnH / 2);
  }

  ctx.restore();
}

