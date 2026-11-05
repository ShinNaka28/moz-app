import { Keyframe, Point } from '../types';

/**
 * 高精度ハイブリッドトラッカー
 * (大域探索ブロックマッチング + サブピクセルLucas-Kanade + Median Flow)
 */

// 高速グレースケール変換
export function toGrayscale(imageData: ImageData): Uint8Array {
  const { data, width, height } = imageData;
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return gray;
}

// 領域内の特徴点（高コントラスト点）の抽出
export function extractFeaturePoints(
  gray: Uint8Array,
  imgWidth: number,
  imgHeight: number,
  box: { x: number; y: number; width: number; height: number },
  maxPoints = 36
): Point[] {
  const points: Point[] = [];
  const startX = Math.max(4, Math.floor(box.x));
  const startY = Math.max(4, Math.floor(box.y));
  const endX = Math.min(imgWidth - 5, Math.floor(box.x + box.width));
  const endY = Math.min(imgHeight - 5, Math.floor(box.y + box.height));

  if (endX <= startX || endY <= startY) return points;

  const stepX = Math.max(4, Math.floor((endX - startX) / 7));
  const stepY = Math.max(4, Math.floor((endY - startY) / 7));

  for (let y = startY + 2; y < endY - 2; y += stepY) {
    for (let x = startX + 2; x < endX - 2; x += stepX) {
      const idx = y * imgWidth + x;
      const dx = gray[idx + 1] - gray[idx - 1];
      const dy = gray[idx + imgWidth] - gray[idx - imgWidth];
      const grad = dx * dx + dy * dy;

      if (grad > 80) {
        points.push({ x, y });
        if (points.length >= maxPoints) break;
      }
    }
    if (points.length >= maxPoints) break;
  }

  // 特徴点が少ない場合は等間隔グリッドで補填
  if (points.length < 12) {
    for (let fy = 0.2; fy <= 0.8; fy += 0.2) {
      for (let fx = 0.2; fx <= 0.8; fx += 0.2) {
        const px = Math.min(imgWidth - 5, Math.max(4, Math.floor(box.x + box.width * fx)));
        const py = Math.min(imgHeight - 5, Math.max(4, Math.floor(box.y + box.height * fy)));
        points.push({ x: px, y: py });
      }
    }
  }

  return points;
}

/**
 * 大域探索ブロックマッチング (Fast Template Search via SAD)
 * カメラのパンや急激な移動に対応するための周囲探索 (±searchRange px)
 */
export function fastBlockMatch(
  box: { x: number; y: number; width: number; height: number },
  prevGray: Uint8Array,
  currGray: Uint8Array,
  imgWidth: number,
  imgHeight: number,
  searchRange = 28
): { dx: number; dy: number; score: number } {
  const bw = Math.max(8, Math.min(64, Math.floor(box.width)));
  const bh = Math.max(8, Math.min(64, Math.floor(box.height)));
  const bx = Math.max(0, Math.min(imgWidth - bw, Math.floor(box.x + (box.width - bw) / 2)));
  const by = Math.max(0, Math.min(imgHeight - bh, Math.floor(box.y + (box.height - bh) / 2)));

  const step = Math.max(2, Math.floor(Math.min(bw, bh) / 12));

  let bestSAD = Infinity;
  let bestDx = 0;
  let bestDy = 0;

  // 粗い探索 (step 4)
  for (let dy = -searchRange; dy <= searchRange; dy += 4) {
    for (let dx = -searchRange; dx <= searchRange; dx += 4) {
      const targetX = bx + dx;
      const targetY = by + dy;
      if (targetX < 0 || targetX + bw >= imgWidth || targetY < 0 || targetY + bh >= imgHeight) {
        continue;
      }

      let sad = 0;
      let count = 0;
      for (let y = 0; y < bh; y += step) {
        const pRow = (by + y) * imgWidth;
        const cRow = (targetY + y) * imgWidth;
        for (let x = 0; x < bw; x += step) {
          sad += Math.abs(prevGray[pRow + bx + x] - currGray[cRow + targetX + x]);
          count++;
        }
      }
      if (count > 0) {
        const avgSad = sad / count;
        if (avgSad < bestSAD) {
          bestSAD = avgSad;
          bestDx = dx;
          bestDy = dy;
        }
      }
    }
  }

  // 最適候補周辺の精密探索 (step 1)
  const fineRange = 3;
  let finalDx = bestDx;
  let finalDy = bestDy;
  for (let dy = bestDy - fineRange; dy <= bestDy + fineRange; dy++) {
    for (let dx = bestDx - fineRange; dx <= bestDx + fineRange; dx++) {
      const targetX = bx + dx;
      const targetY = by + dy;
      if (targetX < 0 || targetX + bw >= imgWidth || targetY < 0 || targetY + bh >= imgHeight) {
        continue;
      }

      let sad = 0;
      let count = 0;
      for (let y = 0; y < bh; y += step) {
        const pRow = (by + y) * imgWidth;
        const cRow = (targetY + y) * imgWidth;
        for (let x = 0; x < bw; x += step) {
          sad += Math.abs(prevGray[pRow + bx + x] - currGray[cRow + targetX + x]);
          count++;
        }
      }
      if (count > 0) {
        const avgSad = sad / count;
        if (avgSad < bestSAD) {
          bestSAD = avgSad;
          finalDx = dx;
          finalDy = dy;
        }
      }
    }
  }

  return { dx: finalDx, dy: finalDy, score: bestSAD };
}

// 単一特徴点に対する Lucas-Kanade 追跡
function trackPointLK(
  p: Point,
  initDx: number,
  initDy: number,
  prevGray: Uint8Array,
  currGray: Uint8Array,
  w: number,
  h: number,
  winSize = 6,
  maxIters = 8
): { point: Point; ok: boolean } {
  let curX = p.x + initDx;
  let curY = p.y + initDy;

  for (let iter = 0; iter < maxIters; iter++) {
    const rx = Math.round(curX);
    const ry = Math.round(curY);

    if (rx < winSize + 1 || rx >= w - winSize - 1 || ry < winSize + 1 || ry >= h - winSize - 1) {
      return { point: { x: curX, y: curY }, ok: false };
    }

    let gxx = 0, gxy = 0, gyy = 0;
    let bx = 0, by = 0;

    for (let dy = -winSize; dy <= winSize; dy += 2) {
      for (let dx = -winSize; dx <= winSize; dx += 2) {
        const px = Math.round(p.x) + dx;
        const py = Math.round(p.y) + dy;
        const cx = rx + dx;
        const cy = ry + dy;

        if (px < 1 || px >= w - 1 || py < 1 || py >= h - 1) continue;

        const pIdx = py * w + px;
        const cIdx = cy * w + cx;

        const ix = (prevGray[pIdx + 1] - prevGray[pIdx - 1]) * 0.5;
        const iy = (prevGray[pIdx + w] - prevGray[pIdx - w]) * 0.5;
        const it = currGray[cIdx] - prevGray[pIdx];

        gxx += ix * ix;
        gxy += ix * iy;
        gyy += iy * iy;
        bx += -ix * it;
        by += -iy * it;
      }
    }

    const det = gxx * gyy - gxy * gxy;
    if (Math.abs(det) < 1e-3) {
      return { point: { x: curX, y: curY }, ok: false };
    }

    const du = (gyy * bx - gxy * by) / det;
    const dv = (-gxy * bx + gxx * by) / det;

    curX += du;
    curY += dv;

    if (du * du + dv * dv < 0.02) break;
  }

  return { point: { x: curX, y: curY }, ok: true };
}

/**
 * 高精度ハイブリッド追跡枠更新
 */
export function trackBox(
  box: { x: number; y: number; width: number; height: number },
  featurePoints: Point[],
  prevGray: Uint8Array,
  currGray: Uint8Array,
  imgWidth: number,
  imgHeight: number
): {
  newBox: { x: number; y: number; width: number; height: number };
  newPoints: Point[];
  isOutOfFrame: boolean;
  confidence: number;
} {
  // 1. まず大域探索で大まかな移動ベクトル（パン・チルト）を取得
  const coarse = fastBlockMatch(box, prevGray, currGray, imgWidth, imgHeight, 32);

  // 2. 特徴点群を大まかな移動位置を起点として LK で微調整追従
  const dxList: number[] = [];
  const dyList: number[] = [];
  const newPoints: Point[] = [];

  for (const pt of featurePoints) {
    const res = trackPointLK(pt, coarse.dx, coarse.dy, prevGray, currGray, imgWidth, imgHeight);
    if (res.ok) {
      const dx = res.point.x - pt.x;
      const dy = res.point.y - pt.y;
      dxList.push(dx);
      dyList.push(dy);
      newPoints.push(res.point);
    }
  }

  let finalDx = coarse.dx;
  let finalDy = coarse.dy;

  // 特徴点の一致が十分得られたら中央値（Median Flow）を採用
  if (dxList.length >= 4) {
    dxList.sort((a, b) => a - b);
    dyList.sort((a, b) => a - b);
    const mid = Math.floor(dxList.length / 2);
    finalDx = dxList[mid];
    finalDy = dyList[mid];
  }

  const newX = box.x + finalDx;
  const newY = box.y + finalDy;
  const newBox = {
    x: newX,
    y: newY,
    width: box.width,
    height: box.height,
  };

  // 画面外（フレームアウト）自動判定
  const isOutOfFrame =
    newBox.x + newBox.width * 0.75 < 0 ||
    newBox.x + newBox.width * 0.25 > imgWidth ||
    newBox.y + newBox.height * 0.75 < 0 ||
    newBox.y + newBox.height * 0.25 > imgHeight;

  return {
    newBox,
    newPoints: newPoints.length >= 6 ? newPoints : extractFeaturePoints(currGray, imgWidth, imgHeight, newBox),
    isOutOfFrame,
    confidence: dxList.length / Math.max(1, featurePoints.length),
  };
}

// キーフレーム間の線形補間
export function interpolateKeyframes(
  keyframes: Keyframe[],
  time: number
): { x: number; y: number; width: number; height: number; points?: Point[] } | null {
  if (keyframes.length === 0) return null;
  if (keyframes.length === 1) {
    const k = keyframes[0];
    return { x: k.x, y: k.y, width: k.width, height: k.height, points: k.points };
  }

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);

  if (time <= sorted[0].time) {
    const k = sorted[0];
    return { x: k.x, y: k.y, width: k.width, height: k.height, points: k.points };
  }
  if (time >= sorted[sorted.length - 1].time) {
    const k = sorted[sorted.length - 1];
    return { x: k.x, y: k.y, width: k.width, height: k.height, points: k.points };
  }

  let prev = sorted[0];
  let next = sorted[1];
  for (let i = 0; i < sorted.length - 1; i++) {
    if (time >= sorted[i].time && time <= sorted[i + 1].time) {
      prev = sorted[i];
      next = sorted[i + 1];
      break;
    }
  }

  const duration = next.time - prev.time;
  const alpha = duration > 0 ? (time - prev.time) / duration : 0;

  const x = prev.x + (next.x - prev.x) * alpha;
  const y = prev.y + (next.y - prev.y) * alpha;
  const width = prev.width + (next.width - prev.width) * alpha;
  const height = prev.height + (next.height - prev.height) * alpha;

  let points: Point[] | undefined = undefined;
  if (prev.points && next.points && prev.points.length === next.points.length) {
    points = prev.points.map((p, idx) => ({
      x: p.x + (next.points![idx].x - p.x) * alpha,
      y: p.y + (next.points![idx].y - p.y) * alpha,
    }));
  }

  return { x, y, width, height, points };
}
