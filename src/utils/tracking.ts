import { Keyframe, Point } from '../types';

/**
 * 簡易・高速な Lucas-Kanade オプティカルフロー + Median Flow + テンプレート照合トラッカー
 */

// グレースケール化
export function toGrayscale(imageData: ImageData): Uint8Array {
  const { data, width, height } = imageData;
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    // 輝度 Y = 0.299R + 0.587G + 0.114B
    gray[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return gray;
}

// 領域内の特徴点（高勾配点）をサンプリング
export function extractFeaturePoints(
  gray: Uint8Array,
  imgWidth: number,
  imgHeight: number,
  box: { x: number; y: number; width: number; height: number },
  maxPoints = 25
): Point[] {
  const points: Point[] = [];
  const startX = Math.max(2, Math.floor(box.x));
  const startY = Math.max(2, Math.floor(box.y));
  const endX = Math.min(imgWidth - 3, Math.floor(box.x + box.width));
  const endY = Math.min(imgHeight - 3, Math.floor(box.y + box.height));

  const stepX = Math.max(3, Math.floor((endX - startX) / 6));
  const stepY = Math.max(3, Math.floor((endY - startY) / 6));

  for (let y = startY + 2; y < endY - 2; y += stepY) {
    for (let x = startX + 2; x < endX - 2; x += stepX) {
      // Sobel風の簡易勾配強度
      const idx = y * imgWidth + x;
      const dx = gray[idx + 1] - gray[idx - 1];
      const dy = gray[idx + imgWidth] - gray[idx - imgWidth];
      const grad = dx * dx + dy * dy;

      if (grad > 100) {
        points.push({ x, y });
        if (points.length >= maxPoints) break;
      }
    }
    if (points.length >= maxPoints) break;
  }

  // 特徴点が少なければグリッド点をフォールバックとして配置
  if (points.length < 9) {
    for (let fy = 0.2; fy <= 0.8; fy += 0.3) {
      for (let fx = 0.2; fx <= 0.8; fx += 0.3) {
        const px = Math.min(imgWidth - 3, Math.max(2, Math.floor(box.x + box.width * fx)));
        const py = Math.min(imgHeight - 3, Math.max(2, Math.floor(box.y + box.height * fy)));
        points.push({ x: px, y: py });
      }
    }
  }

  return points;
}

// 単一特徴点に対する簡易 Lucas-Kanade 追跡 (5x5 ウィンドウ)
function trackPointLK(
  p: Point,
  prevGray: Uint8Array,
  currGray: Uint8Array,
  w: number,
  h: number,
  winSize = 4,
  maxIters = 6
): { point: Point; ok: boolean } {
  let curX = p.x;
  let curY = p.y;

  for (let iter = 0; iter < maxIters; iter++) {
    const rx = Math.round(curX);
    const ry = Math.round(curY);

    if (rx < winSize + 1 || rx >= w - winSize - 1 || ry < winSize + 1 || ry >= h - winSize - 1) {
      return { point: { x: curX, y: curY }, ok: false };
    }

    let gxx = 0, gxy = 0, gyy = 0;
    let bx = 0, by = 0;

    for (let dy = -winSize; dy <= winSize; dy++) {
      for (let dx = -winSize; dx <= winSize; dx++) {
        const px = Math.round(p.x) + dx;
        const py = Math.round(p.y) + dy;
        const cx = rx + dx;
        const cy = ry + dy;

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
    if (Math.abs(det) < 1e-4) {
      return { point: { x: curX, y: curY }, ok: false };
    }

    const du = (gyy * bx - gxy * by) / det;
    const dv = (-gxy * bx + gxx * by) / det;

    curX += du;
    curY += dv;

    if (du * du + dv * dv < 0.04) {
      break;
    }
  }

  return { point: { x: curX, y: curY }, ok: true };
}

// 追跡枠の更新（Median Flow アルゴリズム）
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
  const dxList: number[] = [];
  const dyList: number[] = [];
  const newPoints: Point[] = [];

  for (const pt of featurePoints) {
    const res = trackPointLK(pt, prevGray, currGray, imgWidth, imgHeight);
    if (res.ok) {
      const dx = res.point.x - pt.x;
      const dy = res.point.y - pt.y;
      
      // 極端な急激移動は除外
      if (Math.hypot(dx, dy) < Math.max(imgWidth, imgHeight) * 0.25) {
        dxList.push(dx);
        dyList.push(dy);
        newPoints.push(res.point);
      }
    }
  }

  const successRatio = featurePoints.length > 0 ? dxList.length / featurePoints.length : 0;

  // 成功した点が3割未満なら見失い・追跡失敗判定
  if (dxList.length < 3 || successRatio < 0.25) {
    return {
      newBox: box,
      newPoints: featurePoints,
      isOutOfFrame: true,
      confidence: 0,
    };
  }

  // 中央値（Median）の算出
  dxList.sort((a, b) => a - b);
  dyList.sort((a, b) => a - b);
  const mid = Math.floor(dxList.length / 2);
  const medianDx = dxList[mid];
  const medianDy = dyList[mid];

  const newX = box.x + medianDx;
  const newY = box.y + medianDy;
  const newBox = {
    x: newX,
    y: newY,
    width: box.width,
    height: box.height,
  };

  // 画面外（フレームアウト）チェック
  // 枠の大部分が画面外に出たか判定
  const isOutOfFrame =
    newBox.x + newBox.width * 0.8 < 0 ||
    newBox.x + newBox.width * 0.2 > imgWidth ||
    newBox.y + newBox.height * 0.8 < 0 ||
    newBox.y + newBox.height * 0.2 > imgHeight;

  return {
    newBox,
    newPoints,
    isOutOfFrame,
    confidence: successRatio,
  };
}

// キーフレーム間の線形補間（時刻 t における位置を計算）
export function interpolateKeyframes(
  keyframes: Keyframe[],
  time: number
): { x: number; y: number; width: number; height: number; points?: Point[] } | null {
  if (keyframes.length === 0) return null;
  if (keyframes.length === 1) {
    const k = keyframes[0];
    return { x: k.x, y: k.y, width: k.width, height: k.height, points: k.points };
  }

  // 時間順にソート
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);

  // 範囲外の場合のクランプ
  if (time <= sorted[0].time) {
    const k = sorted[0];
    return { x: k.x, y: k.y, width: k.width, height: k.height, points: k.points };
  }
  if (time >= sorted[sorted.length - 1].time) {
    const k = sorted[sorted.length - 1];
    return { x: k.x, y: k.y, width: k.width, height: k.height, points: k.points };
  }

  // 挟む2つのキーフレームを探索
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

