import { Point, NormalizedPoint } from '../types';

export const NORMALIZED_POINT_COUNT = 32;

export interface Dimensions {
  width: number;
  height: number;
}

/**
 * 4Kや1080pなどの大きなメディアを、ブラウザのOOM（メモリクラッシュ）を防ぐため
 * アスペクト比を保ちつつ「長辺 1280px 以下」の偶数ピクセル（H.264書き出し必須条件）に縮小計算する
 */
export function getClampedDimensions(
  origWidth: number,
  origHeight: number,
  maxLongEdge = 1280
): Dimensions {
  if (origWidth <= 0 || origHeight <= 0) {
    return { width: 0, height: 0 };
  }
  const longEdge = Math.max(origWidth, origHeight);
  if (longEdge <= maxLongEdge) {
    return {
      width: Math.max(2, Math.floor(origWidth / 2) * 2),
      height: Math.max(2, Math.floor(origHeight / 2) * 2),
    };
  }
  const scale = maxLongEdge / longEdge;
  const w = Math.max(2, Math.floor(Math.round(origWidth * scale) / 2) * 2);
  const h = Math.max(2, Math.floor(Math.round(origHeight * scale) / 2) * 2);
  return { width: w, height: h };
}

/**
 * バウンディングボックスが画面境界（端から margin px 以内、デフォルト 20px）に接しているか判定
 * 画面外への「退場」判定（即時破棄・ゴースト枠防止）に使用
 */
export function isBoxTouchingBorder(
  box: { x: number; y: number; width: number; height: number },
  screenWidth: number,
  screenHeight: number,
  margin = 20
): boolean {
  return (
    box.x <= margin ||
    box.y <= margin ||
    box.x + box.width >= screenWidth - margin ||
    box.y + box.height >= screenHeight - margin
  );
}

/**
 * 閉曲線ポリゴンを指定頂点数（デフォルト32点）に周長均等サンプリングする
 * 最上端の頂点を始点（index 0）として時計回りに整列
 */
export function resampleClosedPoints(points: Point[], targetCount = NORMALIZED_POINT_COUNT): Point[] {
  if (points.length < 3) return points;

  // 1. 最上部（Yが最小）を始点に整列
  let topIdx = 0;
  for (let i = 1; i < points.length; i++) {
    if (
      points[i].y < points[topIdx].y - 1e-3 ||
      (Math.abs(points[i].y - points[topIdx].y) <= 1e-3 && points[i].x < points[topIdx].x)
    ) {
      topIdx = i;
    }
  }

  const ordered: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    ordered.push(points[(topIdx + i) % points.length]);
  }

  // 2. 累積周長を計算
  const n = ordered.length;
  const cumLen = new Float64Array(n + 1);
  cumLen[0] = 0;
  for (let i = 0; i < n; i++) {
    const p0 = ordered[i];
    const p1 = ordered[(i + 1) % n];
    cumLen[i + 1] = cumLen[i] + Math.hypot(p1.x - p0.x, p1.y - p0.y);
  }

  const totalLen = cumLen[n];
  if (totalLen <= 1e-3) return ordered.slice(0, targetCount);

  // 3. 等間隔にサンプリング
  const resampled: Point[] = [];
  let segIdx = 0;
  for (let k = 0; k < targetCount; k++) {
    const targetDist = (k / targetCount) * totalLen;
    while (segIdx < n - 1 && cumLen[segIdx + 1] < targetDist) {
      segIdx++;
    }
    const segStart = cumLen[segIdx];
    const segEnd = cumLen[segIdx + 1];
    const segLen = segEnd - segStart;
    const t = segLen > 1e-6 ? (targetDist - segStart) / segLen : 0;
    const p0 = ordered[segIdx];
    const p1 = ordered[(segIdx + 1) % n];
    resampled.push({
      x: p0.x + (p1.x - p0.x) * t,
      y: p0.y + (p1.y - p0.y) * t,
    });
  }

  return resampled;
}

/**
 * 32個等の閉曲線ポリゴン頂点を滑らかな Catmull-Rom スプライン曲線（Cubic Bezier）で描画
 * 直線（lineTo）によるカクつきを防ぎ、人体の頭・首のくびれ・肩・腕のラインに沿った自然な曲線を描画
 */
export function drawSmoothClosedCurve(ctx: CanvasRenderingContext2D, points: Point[]): void {
  const n = points.length;
  if (n < 3) {
    if (n === 2) {
      ctx.moveTo(points[0].x, points[0].y);
      ctx.lineTo(points[1].x, points[1].y);
    }
    return;
  }

  ctx.moveTo(points[0].x, points[0].y);

  // Catmull-Rom スプライン制御点 (Centripetal tension = 0.5)
  // 各セグメント [P_i, P_{i+1}] を通過し、連続した滑らかな接線を維持
  for (let i = 0; i < n; i++) {
    const pPrev = points[(i - 1 + n) % n];
    const pCur = points[i];
    const pNext = points[(i + 1) % n];
    const pNext2 = points[(i + 2) % n];

    const cp1x = pCur.x + (pNext.x - pPrev.x) / 6;
    const cp1y = pCur.y + (pNext.y - pPrev.y) / 6;

    const cp2x = pNext.x - (pNext2.x - pCur.x) / 6;
    const cp2y = pNext.y - (pNext2.y - pCur.y) / 6;

    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, pNext.x, pNext.y);
  }
}

/**
 * 閉曲線ポリゴンを移動平均フィルタで平滑化
 */
export function smoothClosedPoints(points: Point[], iterations = 2): Point[] {
  let pts = points;
  const n = pts.length;
  if (n < 5) return pts;
  for (let iter = 0; iter < iterations; iter++) {
    const next: Point[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n];
      const curr = pts[i];
      const nxt = pts[(i + 1) % n];
      next[i] = {
        x: prev.x * 0.25 + curr.x * 0.5 + nxt.x * 0.25,
        y: prev.y * 0.25 + curr.y * 0.5 + nxt.y * 0.25,
      };
    }
    pts = next;
  }
  return pts;
}

/**
 * 外枠の左上 (0, 0) 〜 右下 (1, 1) を基準とする初期32頂点（楕円ベース・人体のラインにフィットしやすい滑らかな配置）
 */
export function createDefaultNormalizedPoints(count = NORMALIZED_POINT_COUNT): NormalizedPoint[] {
  const pts: NormalizedPoint[] = [];
  for (let i = 0; i < count; i++) {
    // 真上 (-PI/2) から時計回りに16点配置
    const theta = -Math.PI / 2 + (i / count) * Math.PI * 2;
    pts.push({
      u: Number((0.5 + 0.5 * Math.cos(theta)).toFixed(4)),
      v: Number((0.5 + 0.5 * Math.sin(theta)).toFixed(4)),
    });
  }
  return pts;
}

/**
 * 外枠と16個の相対座標(u, v)から絶対座標(x, y)の配列を計算
 */
export function normalizedToAbsolutePoints(
  box: { x: number; y: number; width: number; height: number },
  normalizedPoints: NormalizedPoint[]
): Point[] {
  return normalizedPoints.map((np) => ({
    x: box.x + np.u * box.width,
    y: box.y + np.v * box.height,
  }));
}

/**
 * 絶対座標の点列から外枠を求め、16個の正規化相対座標(u, v)へ変換
 */
export function absoluteToNormalizedPoints(
  box: { x: number; y: number; width: number; height: number },
  points: Point[],
  targetCount = NORMALIZED_POINT_COUNT
): NormalizedPoint[] {
  const w = Math.max(1, box.width);
  const h = Math.max(1, box.height);
  const sampled = points.length === targetCount ? points : resampleClosedPoints(points, targetCount);

  return sampled.map((p) => ({
    u: Math.max(0, Math.min(1, Number(((p.x - box.x) / w).toFixed(4)))),
    v: Math.max(0, Math.min(1, Number(((p.y - box.y) / h).toFixed(4)))),
  }));
}

