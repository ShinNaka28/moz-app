import { FilesetResolver, FaceDetector, ImageSegmenter } from '@mediapipe/tasks-vision';
import { DetectedPerson, Point } from '../types';

let faceDetectorInstance: FaceDetector | null = null;
let segmenterInstance: ImageSegmenter | null = null;
let deepLabInstance: ImageSegmenter | null = null;
let isInitializing = false;
let isInitializingSegmenter = false;
let isInitializingDeepLab = false;

export interface FaceFilterOptions {
  minScore?: number;
  minAspect?: number;
  maxAspect?: number;
  verifyFaceKeypoints?: boolean;
}

/**
 * 検出結果が手や物体などの誤検出ではないかを幾何学的に判定する
 */
export function isValidFaceDetection(
  det: {
    boundingBox?: { originX: number; originY: number; width: number; height: number };
    categories?: Array<{ score: number }>;
    keypoints?: Array<{ x: number; y: number; label?: string }>;
  },
  options: FaceFilterOptions = {}
): boolean {
  const minScore = options.minScore ?? 0.55;
  const minAspect = options.minAspect ?? 0.55;
  const maxAspect = options.maxAspect ?? 1.65;
  const verifyKeypoints = options.verifyFaceKeypoints ?? true;

  // 1. 信頼度スコア判定（手や背景ノイズの多くは 0.3〜0.5 前後）
  const score = det.categories?.[0]?.score ?? 0;
  if (score < minScore) return false;

  // 2. バウンディングボックスの検証
  const bb = det.boundingBox;
  if (!bb || bb.width <= 6 || bb.height <= 6) return false;

  // アスペクト比 (顔は通常 0.6〜1.4 程度。手や指先、腕などは極端に横長・縦長になりやすい)
  const aspect = bb.width / bb.height;
  if (aspect < minAspect || aspect > maxAspect) return false;

  // 3. 顔キーポイント（両目、鼻、口）の幾何学的検証
  // BlazeFace は 6点: 0:右目, 1:左目, 2:鼻先, 3:口中心, 4:右耳, 5:左耳
  if (verifyKeypoints && det.keypoints && det.keypoints.length >= 4) {
    const rightEye = det.keypoints[0];
    const leftEye = det.keypoints[1];
    const mouth = det.keypoints[3];

    // 両目間の距離
    const eyeDx = leftEye.x - rightEye.x;
    const eyeDy = leftEye.y - rightEye.y;
    const eyeDist = Math.sqrt(eyeDx * eyeDx + eyeDy * eyeDy);

    // 手の誤検出ではキーポイントが極端に密集することが多い
    if (eyeDist < 0.035) {
      return false;
    }

    // 通常の顔では口が両目より上に来ることはない（手のひらや拳の誤検出防止）
    const eyesCenterY = (rightEye.y + leftEye.y) / 2;
    if (mouth.y < eyesCenterY - eyeDist * 0.3) {
      return false;
    }
  }

  return true;
}

// 完全ローカルから MediaPipe Face Detector を初期化
export async function initFaceDetector(
  confidence = 0.45,
  forceCpu = false
): Promise<FaceDetector> {
  if (faceDetectorInstance && !forceCpu) return faceDetectorInstance;
  if (forceCpu && faceDetectorInstance) {
    try {
      faceDetectorInstance.close();
    } catch (_) {}
    faceDetectorInstance = null;
  }
  if (isInitializing) {
    while (isInitializing) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (faceDetectorInstance) return faceDetectorInstance;
  }

  isInitializing = true;
  try {
    const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
    const wasmPath = `${baseUrl}/wasm`;
    const modelPath = `${baseUrl}/models/blaze_face_short_range.tflite`;

    // ローカルの wasm を参照
    const vision = await FilesetResolver.forVisionTasks(wasmPath);
    if (!forceCpu) {
      faceDetectorInstance = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: modelPath,
          delegate: 'GPU',
        },
        runningMode: 'IMAGE',
        minDetectionConfidence: confidence,
      });
      return faceDetectorInstance;
    }
    throw new Error('Force CPU delegate');
  } catch (err) {
    console.warn('GPU delegate skipped or failed, using CPU delegate', err);
    // CPUフォールバック
    const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
    const wasmPath = `${baseUrl}/wasm`;
    const modelPath = `${baseUrl}/models/blaze_face_short_range.tflite`;

    const vision = await FilesetResolver.forVisionTasks(wasmPath);
    faceDetectorInstance = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: 'CPU',
      },
      runningMode: 'IMAGE',
      minDetectionConfidence: confidence,
    });
    return faceDetectorInstance;
  } finally {
    isInitializing = false;
  }
}

// 完全ローカルから MediaPipe ImageSegmenter (Selfie Segmenter) を初期化
// 注意: selfie_segmenter.tflite は 1チャンネル出力(index 0 = person)のため、
// outputCategoryMask: true にすると人物=0, 背景=255 となり背景全体が選択されてしまうバグが起きる。
// 必ず outputConfidenceMasks: true で 0.0〜1.0 の人物確率マップとして取得する。
export async function initPersonSegmenter(forceCpu = false): Promise<ImageSegmenter> {
  if (segmenterInstance && !forceCpu) return segmenterInstance;
  if (forceCpu && segmenterInstance) {
    try {
      segmenterInstance.close();
    } catch (_) {}
    segmenterInstance = null;
  }
  if (isInitializingSegmenter) {
    while (isInitializingSegmenter) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (segmenterInstance) return segmenterInstance;
  }

  isInitializingSegmenter = true;
  try {
    const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
    const wasmPath = `${baseUrl}/wasm`;
    const modelPath = `${baseUrl}/models/selfie_segmenter.tflite`;

    const vision = await FilesetResolver.forVisionTasks(wasmPath);
    if (!forceCpu) {
      segmenterInstance = await ImageSegmenter.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: modelPath,
          delegate: 'GPU',
        },
        runningMode: 'IMAGE',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      return segmenterInstance;
    }
    throw new Error('Force CPU delegate for segmenter');
  } catch (err) {
    console.warn('GPU delegate failed for segmenter, fallback to CPU delegate', err);
    const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
    const wasmPath = `${baseUrl}/wasm`;
    const modelPath = `${baseUrl}/models/selfie_segmenter.tflite`;

    const vision = await FilesetResolver.forVisionTasks(wasmPath);
    segmenterInstance = await ImageSegmenter.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: 'CPU',
      },
      runningMode: 'IMAGE',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
    return segmenterInstance;
  } finally {
    isInitializingSegmenter = false;
  }
}

// 完全ローカルから DeepLabV3 (PASCAL VOC 21クラス: クラス15 = person) を初期化
// 顔が映っていない全身・下半身・後ろ姿・至近距離の人物検出精度を大幅に強化
export async function initDeepLabSegmenter(forceCpu = false): Promise<ImageSegmenter | null> {
  if (deepLabInstance && !forceCpu) return deepLabInstance;
  if (forceCpu && deepLabInstance) {
    try {
      deepLabInstance.close();
    } catch (_) {}
    deepLabInstance = null;
  }
  if (isInitializingDeepLab) {
    while (isInitializingDeepLab) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (deepLabInstance) return deepLabInstance;
  }

  isInitializingDeepLab = true;
  try {
    const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
    const wasmPath = `${baseUrl}/wasm`;
    const modelPath = `${baseUrl}/models/deeplab_v3.tflite`;

    const vision = await FilesetResolver.forVisionTasks(wasmPath);
    if (!forceCpu) {
      deepLabInstance = await ImageSegmenter.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: modelPath,
          delegate: 'GPU',
        },
        runningMode: 'IMAGE',
        outputConfidenceMasks: true,
        outputCategoryMask: true,
      });
      return deepLabInstance;
    }
    throw new Error('Force CPU delegate for DeepLab');
  } catch (err) {
    try {
      const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
      const wasmPath = `${baseUrl}/wasm`;
      const modelPath = `${baseUrl}/models/deeplab_v3.tflite`;

      const vision = await FilesetResolver.forVisionTasks(wasmPath);
      deepLabInstance = await ImageSegmenter.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: modelPath,
          delegate: 'CPU',
        },
        runningMode: 'IMAGE',
        outputConfidenceMasks: true,
        outputCategoryMask: true,
      });
      return deepLabInstance;
    } catch (cpuErr) {
      console.warn('DeepLab segmenter unavailable:', cpuErr);
      return null;
    }
  } finally {
    isInitializingDeepLab = false;
  }
}

// 2D Canvas バッファ（<video> を直接 WebGL2 texImage2D に渡すとスマホ環境で未デコードや cross-origin エラーになる問題を完全回避）
let sharedDetCanvas: HTMLCanvasElement | null = null;

// 固定頂点数（フレーム間で頂点数を一致させ、キーフレーム補間時にポリゴンが消えて矩形に戻る現象を完全に防止）
const BODY_CONTOUR_POINTS = 72;

/**
 * 閉曲線ポリゴンを移動平均フィルタで滑らかな体のラインに平滑化する
 */
function smoothClosedPolygon(points: Point[], iterations = 3): Point[] {
  let pts = points;
  const n = pts.length;
  if (n < 5) return pts;
  for (let iter = 0; iter < iterations; iter++) {
    const next: Point[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const prev2 = pts[(i - 2 + n) % n];
      const prev1 = pts[(i - 1 + n) % n];
      const curr = pts[i];
      const next1 = pts[(i + 1) % n];
      const next2 = pts[(i + 2) % n];
      next[i] = {
        x: prev2.x * 0.1 + prev1.x * 0.22 + curr.x * 0.36 + next1.x * 0.22 + next2.x * 0.1,
        y: prev2.y * 0.1 + prev1.y * 0.22 + curr.y * 0.36 + next1.y * 0.22 + next2.y * 0.1,
      };
    }
    pts = next;
  }
  return pts;
}

/**
 * 閉曲線ポリゴンの外周長に沿って等間隔な N 個の頂点へリサンプリングする
 * 常に最上部（最小Y）の頂点を始点(index 0)として時計回りに揃えることで、フレーム間の頂点対応を安定化
 */
export function resampleClosedPolygon(points: Point[], targetCount = BODY_CONTOUR_POINTS): Point[] {
  if (points.length < 3) return points;

  // 1. 最も上（Yが最小、同値ならXが中央寄り）の頂点を始点に回転
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

  // 2. 各辺の長さと累積周長を計算
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

  // 3. 等間隔に targetCount 点へ線形補間サンプリング
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
      x: Math.round(p0.x + (p1.x - p0.x) * t),
      y: Math.round(p0.y + (p1.y - p0.y) * t),
    });
  }

  return resampled;
}

/**
 * 2D Canvas の RGB 画像から肌色（YCbCr/RGB色空間）および前景サリエンシー（中心重み付き色差）を計算
 * 顔が映っていない至近距離の身体ショットや照明環境でも体のラインを確実に捉えるための補助マップ
 */
function computeSkinAndForegroundMap(
  ctx: CanvasRenderingContext2D,
  segW: number,
  segH: number,
  gridW: number,
  gridH: number
): Float32Array {
  const map = new Float32Array(gridW * gridH);
  let imgData: ImageData;
  try {
    imgData = ctx.getImageData(0, 0, segW, segH);
  } catch (_) {
    return map;
  }
  const data = imgData.data;

  // 外周エッジ（四隅・上下左右端）の平均色を背景基準色として推定
  let bgR = 0;
  let bgG = 0;
  let bgB = 0;
  let bgCount = 0;
  const stepX = Math.max(1, Math.floor(segW / 32));
  const stepY = Math.max(1, Math.floor(segH / 32));

  for (let x = 0; x < segW; x += stepX) {
    const topIdx = x * 4;
    const botIdx = ((segH - 1) * segW + x) * 4;
    bgR += data[topIdx] + data[botIdx];
    bgG += data[topIdx + 1] + data[botIdx + 1];
    bgB += data[topIdx + 2] + data[botIdx + 2];
    bgCount += 2;
  }
  for (let y = 0; y < segH; y += stepY) {
    const leftIdx = (y * segW) * 4;
    const rightIdx = (y * segW + (segW - 1)) * 4;
    bgR += data[leftIdx] + data[rightIdx];
    bgG += data[leftIdx + 1] + data[rightIdx + 1];
    bgB += data[leftIdx + 2] + data[rightIdx + 2];
    bgCount += 2;
  }
  if (bgCount > 0) {
    bgR /= bgCount;
    bgG /= bgCount;
    bgB /= bgCount;
  }

  for (let gy = 0; gy < gridH; gy++) {
    const sy = Math.min(segH - 1, Math.floor(((gy + 0.5) / gridH) * segH));
    const ny = (gy + 0.5) / gridH - 0.5;
    for (let gx = 0; gx < gridW; gx++) {
      const sx = Math.min(segW - 1, Math.floor(((gx + 0.5) / gridW) * segW));
      const nx = (gx + 0.5) / gridW - 0.5;
      const idx = (sy * segW + sx) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      // YCbCr 変換による肌色尤度（照明変化に強い肌色領域のソフト判定）
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

      let skinScore = 0;
      if (cr >= 130 && cr <= 178 && cb >= 75 && cb <= 132 && r > 55 && g > 35 && b > 20 && r >= g * 0.9) {
        const dCr = Math.abs(cr - 150) / 25;
        const dCb = Math.abs(cb - 105) / 28;
        skinScore = Math.max(0, 1 - 0.45 * (dCr + dCb));
      }

      // 背景基準色との色差スコア
      const colorDist = Math.hypot(r - bgR, g - bgG, b - bgB);
      const contrastScore = Math.min(1, Math.max(0, (colorDist - 22) / 70));

      // 画面中心付近の空間プライオリティ（端の背景ノイズを抑制）
      const radialDist2 = nx * nx * 1.6 + ny * ny * 1.2;
      const centerWeight = Math.max(0.15, Math.exp(-radialDist2 * 2.2));

      map[gy * gridW + gx] = Math.min(1, (skinScore * 0.72 + contrastScore * 0.48) * centerWeight);
    }
  }

  return map;
}

/**
 * 人物の確率マップ (gridW x gridH) からモルフォロジー整形・最大連結成分抽出・穴埋めを行い、
 * 体のラインにぴったり沿った単一閉曲線ポリゴン（72頂点）を抽出する
 */
function extractBodyPolygonFromProbabilityGrid(
  probGrid: Float32Array,
  gridW: number,
  gridH: number,
  origW: number,
  origH: number,
  threshold = 0.35
): { points: Point[]; bounds: { x: number; y: number; width: number; height: number } } | null {
  const totalCells = gridW * gridH;

  // 1. 閾値による2値化（万が一マスクが背景反転している場合は自動補正）
  let rawBin = new Uint8Array(totalCells);
  let fgCount = 0;
  let borderFgCount = 0;
  let borderTotal = 0;

  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const isFg = probGrid[y * gridW + x] >= threshold ? 1 : 0;
      rawBin[y * gridW + x] = isFg;
      fgCount += isFg;
      if (x <= 1 || x >= gridW - 2 || y <= 1 || y >= gridH - 2) {
        borderFgCount += isFg;
        borderTotal++;
      }
    }
  }

  // 四辺の外周の88%以上が前景かつ全体の78%以上が前景の場合は背景と人物が反転していると判断し反転補正
  if (fgCount > totalCells * 0.78 && borderFgCount > borderTotal * 0.88) {
    fgCount = 0;
    for (let i = 0; i < totalCells; i++) {
      rawBin[i] = probGrid[i] < 1 - threshold ? 1 : 0;
      fgCount += rawBin[i];
    }
  }

  // 人物領域が画面の94%を超える（画面全体の矩形になってしまう）場合は閾値を引き上げて再判定
  if (fgCount > totalCells * 0.94) {
    fgCount = 0;
    for (let i = 0; i < totalCells; i++) {
      rawBin[i] = probGrid[i] >= 0.62 ? 1 : 0;
      fgCount += rawBin[i];
    }
  }

  // 逆に少なすぎる場合は閾値を緩和
  if (fgCount < totalCells * 0.012) {
    fgCount = 0;
    for (let i = 0; i < totalCells; i++) {
      rawBin[i] = probGrid[i] >= 0.20 ? 1 : 0;
      fgCount += rawBin[i];
    }
  }

  if (fgCount < totalCells * 0.008 || fgCount > totalCells * 0.96) {
    return null;
  }

  // 2. モルフォロジー膨張 (3x3 Dilation) で体のラインのわずかな途切れを接続
  const dilated = new Uint8Array(totalCells);
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= gridH) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= gridW) continue;
          if (rawBin[ny * gridW + nx]) {
            on = 1;
            break;
          }
        }
      }
      dilated[y * gridW + x] = on;
    }
  }

  // 3. 4連結成分ラベリング (BFS) により背景の細かいノイズ斑点を完全に除去し、人物本体のみを抽出
  const labels = new Int32Array(totalCells);
  const compSizes: number[] = [0];
  const compCentroids: Array<{ sumX: number; sumY: number }> = [{ sumX: 0, sumY: 0 }];
  let currentLabel = 0;
  const queue = new Int32Array(totalCells);

  for (let i = 0; i < totalCells; i++) {
    if (dilated[i] && labels[i] === 0) {
      currentLabel++;
      let head = 0;
      let tail = 0;
      queue[tail++] = i;
      labels[i] = currentLabel;
      let size = 0;
      let sumX = 0;
      let sumY = 0;

      while (head < tail) {
        const curr = queue[head++];
        size++;
        const cx = curr % gridW;
        const cy = (curr - cx) / gridW;
        sumX += cx;
        sumY += cy;

        if (cx + 1 < gridW && dilated[curr + 1] && labels[curr + 1] === 0) {
          labels[curr + 1] = currentLabel;
          queue[tail++] = curr + 1;
        }
        if (cx - 1 >= 0 && dilated[curr - 1] && labels[curr - 1] === 0) {
          labels[curr - 1] = currentLabel;
          queue[tail++] = curr - 1;
        }
        if (cy + 1 < gridH && dilated[curr + gridW] && labels[curr + gridW] === 0) {
          labels[curr + gridW] = currentLabel;
          queue[tail++] = curr + gridW;
        }
        if (cy - 1 >= 0 && dilated[curr - gridW] && labels[curr - gridW] === 0) {
          labels[curr - gridW] = currentLabel;
          queue[tail++] = curr - gridW;
        }
      }
      compSizes[currentLabel] = size;
      compCentroids[currentLabel] = { sumX, sumY };
    }
  }

  let bestLabel = -1;
  let maxCompSize = 0;
  for (let l = 1; l <= currentLabel; l++) {
    if (compSizes[l] > maxCompSize) {
      maxCompSize = compSizes[l];
      bestLabel = l;
    }
  }

  if (bestLabel === -1 || maxCompSize < totalCells * 0.008) {
    return null;
  }

  // パディング付きグリッド (pw x ph) を作成し、主要連結成分（＋25%以上の準主要部位があればブリッジ接続）を配置
  const pw = gridW + 2;
  const ph = gridH + 2;
  const padded = new Uint8Array(pw * ph);

  const keepLabels = new Set<number>([bestLabel]);
  for (let l = 1; l <= currentLabel; l++) {
    if (l !== bestLabel && compSizes[l] >= maxCompSize * 0.25 && compSizes[l] >= totalCells * 0.02) {
      keepLabels.add(l);
    }
  }

  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      if (keepLabels.has(labels[y * gridW + x])) {
        padded[(y + 1) * pw + (x + 1)] = 1;
      }
    }
  }

  // 複数の身体部位が離れた連結成分として検出された場合は、単一ポリゴンとして一筆書きできるよう重心間を接続
  if (keepLabels.size > 1) {
    const mainC = compCentroids[bestLabel];
    const mainX = Math.round(mainC.sumX / compSizes[bestLabel]) + 1;
    const mainY = Math.round(mainC.sumY / compSizes[bestLabel]) + 1;

    keepLabels.forEach((l) => {
      if (l === bestLabel) return;
      const subC = compCentroids[l];
      const subX = Math.round(subC.sumX / compSizes[l]) + 1;
      const subY = Math.round(subC.sumY / compSizes[l]) + 1;
      const steps = Math.max(Math.abs(subX - mainX), Math.abs(subY - mainY), 1);
      for (let s = 0; s <= steps; s++) {
        const bx = Math.round(mainX + ((subX - mainX) * s) / steps);
        const by = Math.round(mainY + ((subY - mainY) * s) / steps);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = Math.max(1, Math.min(gridW, bx + dx));
            const ny = Math.max(1, Math.min(gridH, by + dy));
            padded[ny * pw + nx] = 1;
          }
        }
      }
    });
  }

  // 4. 外周 (0, 0) から背景を Flood-Fill して人物内部の穴（服の模様や影による抜け）を完全に埋める
  const exterior = new Uint8Array(pw * ph);
  const extQueue = new Int32Array(pw * ph);
  let eHead = 0;
  let eTail = 0;
  exterior[0] = 1;
  extQueue[eTail++] = 0;

  while (eHead < eTail) {
    const curr = extQueue[eHead++];
    const cx = curr % pw;
    const cy = (curr - cx) / pw;

    if (cx + 1 < pw && !padded[curr + 1] && !exterior[curr + 1]) {
      exterior[curr + 1] = 1;
      extQueue[eTail++] = curr + 1;
    }
    if (cx - 1 >= 0 && !padded[curr - 1] && !exterior[curr - 1]) {
      exterior[curr - 1] = 1;
      extQueue[eTail++] = curr - 1;
    }
    if (cy + 1 < ph && !padded[curr + pw] && !exterior[curr + pw]) {
      exterior[curr + pw] = 1;
      extQueue[eTail++] = curr + pw;
    }
    if (cy - 1 >= 0 && !padded[curr - pw] && !exterior[curr - pw]) {
      exterior[curr - pw] = 1;
      extQueue[eTail++] = curr - pw;
    }
  }

  let minX = gridW;
  let maxX = 0;
  let minY = gridH;
  let maxY = 0;
  let startPx = -1;
  let startPy = -1;

  for (let y = 1; y <= gridH; y++) {
    for (let x = 1; x <= gridW; x++) {
      const idx = y * pw + x;
      if (!exterior[idx]) {
        padded[idx] = 1;
        const gx = x - 1;
        const gy = y - 1;
        if (gx < minX) minX = gx;
        if (gx > maxX) maxX = gx;
        if (gy < minY) minY = gy;
        if (gy > maxY) maxY = gy;
        if (startPx === -1) {
          startPx = x;
          startPy = y;
        }
      } else {
        padded[idx] = 0;
      }
    }
  }

  if (startPx === -1 || minX >= maxX || minY >= maxY) {
    return null;
  }

  // 5. 穴なし単一連結成分のピクセル頂点境界を時計回りに厳密トレース（途中で止まることがないトポロジカル境界追跡）
  // 頂点 (vx, vy) の周囲4セル: TL=(vx-1, vy-1), TR=(vx, vy-1), BR=(vx, vy), BL=(vx-1, vy)
  // 方向 dir: 0=右(E), 1=下(S), 2=左(W), 3=上(N)
  const dvx = [1, 0, -1, 0];
  const dvy = [0, 1, 0, -1];

  const isCellFilled = (cx: number, cy: number): boolean => {
    if (cx < 0 || cx >= pw || cy < 0 || cy >= ph) return false;
    return padded[cy * pw + cx] === 1;
  };

  let vx = startPx;
  let vy = startPy;
  let dir = 0; // 最上端セルの上辺を左から右(East)へ開始
  const rawVertices: Point[] = [];
  const maxSteps = pw * ph * 4;

  for (let step = 0; step < maxSteps; step++) {
    rawVertices.push({ x: vx - 1, y: vy - 1 });
    vx += dvx[dir];
    vy += dvy[dir];

    if (vx === startPx && vy === startPy && rawVertices.length >= 4) {
      break;
    }

    // 進行方向に対して左前方のセル・右前方のセルの状態で次の折れ曲がり方向を決定（右手法則）
    let leftCell = false;
    let rightCell = false;
    if (dir === 0) {
      // East: 左前=TR(vx, vy-1), 右前=BR(vx, vy)
      leftCell = isCellFilled(vx, vy - 1);
      rightCell = isCellFilled(vx, vy);
    } else if (dir === 1) {
      // South: 左前=BR(vx, vy), 右前=BL(vx-1, vy)
      leftCell = isCellFilled(vx, vy);
      rightCell = isCellFilled(vx - 1, vy);
    } else if (dir === 2) {
      // West: 左前=BL(vx-1, vy), 右前=TL(vx-1, vy-1)
      leftCell = isCellFilled(vx - 1, vy);
      rightCell = isCellFilled(vx - 1, vy - 1);
    } else {
      // North: 左前=TL(vx-1, vy-1), 右前=TR(vx, vy-1)
      leftCell = isCellFilled(vx - 1, vy - 1);
      rightCell = isCellFilled(vx, vy - 1);
    }

    if (leftCell) {
      dir = (dir + 3) % 4; // 左折
    } else if (!rightCell) {
      dir = (dir + 1) % 4; // 右折
    }
  }

  if (rawVertices.length < 6) {
    return null;
  }

  // 6. 元映像の解像度へスケーリングし、平滑化＋固定頂点数(72点)へ等間隔リサンプリング
  const scaleX = origW / gridW;
  const scaleY = origH / gridH;

  const scaledPts: Point[] = rawVertices.map((p) => ({
    x: Math.max(0, Math.min(origW, p.x * scaleX)),
    y: Math.max(0, Math.min(origH, p.y * scaleY)),
  }));

  const smoothedPts = smoothClosedPolygon(scaledPts, 4);
  const finalPoints = resampleClosedPolygon(smoothedPts, BODY_CONTOUR_POINTS);

  // ポリゴン頂点から正確なバウンディングボックスを算出
  let bMinX = origW;
  let bMaxX = 0;
  let bMinY = origH;
  let bMaxY = 0;
  for (const pt of finalPoints) {
    if (pt.x < bMinX) bMinX = pt.x;
    if (pt.x > bMaxX) bMaxX = pt.x;
    if (pt.y < bMinY) bMinY = pt.y;
    if (pt.y > bMaxY) bMaxY = pt.y;
  }

  return {
    points: finalPoints,
    bounds: {
      x: Math.round(bMinX),
      y: Math.round(bMinY),
      width: Math.max(16, Math.round(bMaxX - bMinX)),
      height: Math.max(16, Math.round(bMaxY - bMinY)),
    },
  };
}

/**
 * スマホ・PC問わず安全に人物セグメンテーション（体のライン抽出）を実行するラッパー関数
 * - Selfie Segmenter (confidenceMasks[0]) + DeepLabV3 (PASCAL VOC person class 15) + 肌色/前景サリエンシーのハイブリッド融合
 * - 顔が映っていない映像、後ろ姿、横向き、至近距離のクローズアップでも、矩形ではなく体のラインに沿った滑らかなポリゴン輪郭(72頂点)を生成します
 */
export async function segmentPersonSafely(
  source: HTMLVideoElement | HTMLImageElement,
  segmenter: ImageSegmenter
): Promise<{
  activeSegmenter: ImageSegmenter;
  contour: { points: Point[]; bounds: { x: number; y: number; width: number; height: number } } | null;
}> {
  const isVideo = source instanceof HTMLVideoElement;
  const origWidth = isVideo ? source.videoWidth : source.naturalWidth;
  const origHeight = isVideo ? source.videoHeight : source.naturalHeight;

  if (!origWidth || !origHeight) {
    return { activeSegmenter: segmenter, contour: null };
  }

  if (isVideo && source.readyState < 2) {
    return { activeSegmenter: segmenter, contour: null };
  }

  if (!sharedDetCanvas) {
    sharedDetCanvas = document.createElement('canvas');
  }

  // セグメンテーションの入力解像度を 384px 前後に最適化（高速かつ高精度な輪郭抽出）
  const maxDim = 384;
  const scale = Math.min(1, maxDim / Math.max(origWidth, origHeight));
  const segW = Math.max(16, Math.round(origWidth * scale));
  const segH = Math.max(16, Math.round(origHeight * scale));

  if (sharedDetCanvas.width !== segW || sharedDetCanvas.height !== segH) {
    sharedDetCanvas.width = segW;
    sharedDetCanvas.height = segH;
  }

  const ctx = sharedDetCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return { activeSegmenter: segmenter, contour: null };
  }

  try {
    ctx.clearRect(0, 0, segW, segH);
    ctx.drawImage(source, 0, 0, segW, segH);
  } catch (drawErr) {
    console.warn('Skipping segmentation frame: drawImage error', drawErr);
    return { activeSegmenter: segmenter, contour: null };
  }

  const GRID_W = 160;
  const GRID_H = 160;
  const probGrid = new Float32Array(GRID_W * GRID_H);

  let currentSegmenter = segmenter;
  let selfieResult: ReturnType<ImageSegmenter['segment']> | null = null;

  try {
    selfieResult = currentSegmenter.segment(sharedDetCanvas);
  } catch (err) {
    console.warn('Segmenter GPU failed on canvas, switching to CPU delegate:', err);
    currentSegmenter = await initPersonSegmenter(true);
    selfieResult = currentSegmenter.segment(sharedDetCanvas);
  }

  let confidentCount = 0;
  if (selfieResult && selfieResult.confidenceMasks && selfieResult.confidenceMasks.length > 0) {
    try {
      const mask = selfieResult.confidenceMasks[0];
      const maskFloat = mask.getAsFloat32Array();
      const mw = mask.width;
      const mh = mask.height;

      for (let gy = 0; gy < GRID_H; gy++) {
        const my = Math.min(mh - 1, Math.floor(((gy + 0.5) / GRID_H) * mh));
        for (let gx = 0; gx < GRID_W; gx++) {
          const mx = Math.min(mw - 1, Math.floor(((gx + 0.5) / GRID_W) * mw));
          const p = maskFloat[my * mw + mx];
          probGrid[gy * GRID_W + gx] = p;
          if (p >= 0.4) confidentCount++;
        }
      }
    } catch (e) {
      console.warn('Failed reading selfie confidenceMask:', e);
    } finally {
      for (const m of selfieResult.confidenceMasks) {
        try {
          m.close();
        } catch (_) {}
      }
    }
  }
  if (selfieResult?.categoryMask) {
    try {
      selfieResult.categoryMask.close();
    } catch (_) {}
  }

  const totalGrid = GRID_W * GRID_H;
  const selfieRatio = confidentCount / totalGrid;

  // 顔が映っていない全身・下半身・後ろ姿などで Selfie Segmenter の反応が弱い場合（< 6% または > 88%）、
  // DeepLabV3 (クラス15 = person) を併用して人物領域を高精度に補完
  if (selfieRatio < 0.06 || selfieRatio > 0.88) {
    const deepLab = await initDeepLabSegmenter();
    if (deepLab) {
      let dlResult: ReturnType<ImageSegmenter['segment']> | null = null;
      try {
        dlResult = deepLab.segment(sharedDetCanvas);
      } catch (_) {
        const cpuDl = await initDeepLabSegmenter(true);
        if (cpuDl) {
          try {
            dlResult = cpuDl.segment(sharedDetCanvas);
          } catch (_) {}
        }
      }

      if (dlResult) {
        try {
          // PASCAL VOC class 15 = person
          if (dlResult.confidenceMasks && dlResult.confidenceMasks.length > 15) {
            const personMask = dlResult.confidenceMasks[15];
            const pmData = personMask.getAsFloat32Array();
            const mw = personMask.width;
            const mh = personMask.height;
            for (let gy = 0; gy < GRID_H; gy++) {
              const my = Math.min(mh - 1, Math.floor(((gy + 0.5) / GRID_H) * mh));
              for (let gx = 0; gx < GRID_W; gx++) {
                const mx = Math.min(mw - 1, Math.floor(((gx + 0.5) / GRID_W) * mw));
                const dlProb = pmData[my * mw + mx];
                const idx = gy * GRID_W + gx;
                probGrid[idx] = Math.max(probGrid[idx], dlProb);
              }
            }
          } else if (dlResult.categoryMask) {
            const catData = dlResult.categoryMask.getAsUint8Array();
            const mw = dlResult.categoryMask.width;
            const mh = dlResult.categoryMask.height;
            for (let gy = 0; gy < GRID_H; gy++) {
              const my = Math.min(mh - 1, Math.floor(((gy + 0.5) / GRID_H) * mh));
              for (let gx = 0; gx < GRID_W; gx++) {
                const mx = Math.min(mw - 1, Math.floor(((gx + 0.5) / GRID_W) * mw));
                if (catData[my * mw + mx] === 15) {
                  const idx = gy * GRID_W + gx;
                  probGrid[idx] = Math.max(probGrid[idx], 0.85);
                }
              }
            }
          }
        } catch (dlErr) {
          console.warn('Error reading DeepLab mask:', dlErr);
        } finally {
          if (dlResult.confidenceMasks) {
            for (const m of dlResult.confidenceMasks) {
              try {
                m.close();
              } catch (_) {}
            }
          }
          if (dlResult.categoryMask) {
            try {
              dlResult.categoryMask.close();
            } catch (_) {}
          }
        }
      }
    }
  }

  // 肌色・前景コントラストマップを融合（顔が映っていない至近距離の身体クローズアップでも体の輪郭を正確に抽出）
  const skinFgMap = computeSkinAndForegroundMap(ctx, segW, segH, GRID_W, GRID_H);
  let activeAfterDl = 0;
  for (let i = 0; i < totalGrid; i++) {
    if (probGrid[i] >= 0.35) activeAfterDl++;
  }

  const dlRatio = activeAfterDl / totalGrid;
  for (let i = 0; i < totalGrid; i++) {
    if (dlRatio < 0.04) {
      // ニューラルモデルの反応が薄い極端なクローズアップ時は、低閾値のAI反応と肌色・前景サリエンシーを融合
      probGrid[i] = Math.min(1, probGrid[i] * 1.4 + skinFgMap[i] * 0.78);
    } else {
      // 通常時も手足や身体の端が欠けないよう肌色・前景領域で輪郭を補強
      probGrid[i] = Math.min(1, probGrid[i] * 0.82 + skinFgMap[i] * 0.32);
    }
  }

  const contour = extractBodyPolygonFromProbabilityGrid(probGrid, GRID_W, GRID_H, origWidth, origHeight, 0.36);
  return { activeSegmenter: currentSegmenter, contour };
}

/**
 * スマホ・PC問わず安全に顔検出を実行するラッパー関数
 * - <video> や <img> を一度同一オリジンの2D Canvasに転写してから MediaPipe に渡すことで
 *   WebGL2 texImage2D の "The video element contains cross-origin data, and may not be loaded" エラーを根絶
 * - 万が一 WebGL2 実行時エラーが起きた場合も自動的に CPU デリゲートへフォールバックして継続
 */
export async function detectFacesSafely(
  source: HTMLVideoElement | HTMLImageElement,
  detector: FaceDetector,
  confidence = 0.45
): Promise<{
  detections: Array<{
    boundingBox?: { originX: number; originY: number; width: number; height: number };
    categories?: Array<{ score: number }>;
    keypoints?: Array<{ x: number; y: number; label?: string }>;
  }>;
  activeDetector: FaceDetector;
}> {
  const isVideo = source instanceof HTMLVideoElement;
  const origWidth = isVideo ? source.videoWidth : source.naturalWidth;
  const origHeight = isVideo ? source.videoHeight : source.naturalHeight;

  if (!origWidth || !origHeight) {
    return { detections: [], activeDetector: detector };
  }

  // 動画フレームがまだデコードされていない場合（readyState < 2）は安全にスキップ
  if (isVideo && source.readyState < 2) {
    return { detections: [], activeDetector: detector };
  }

  if (!sharedDetCanvas) {
    sharedDetCanvas = document.createElement('canvas');
  }

  // BlazeFace の入力解像度に合わせ、長辺最大 640px に縮小して転写（スマホでのWebGLメモリ負荷と処理速度も大幅に改善）
  const maxDim = 640;
  const scale = Math.min(1, maxDim / Math.max(origWidth, origHeight));
  const detWidth = Math.max(16, Math.round(origWidth * scale));
  const detHeight = Math.max(16, Math.round(origHeight * scale));

  if (sharedDetCanvas.width !== detWidth || sharedDetCanvas.height !== detHeight) {
    sharedDetCanvas.width = detWidth;
    sharedDetCanvas.height = detHeight;
  }

  const ctx = sharedDetCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return { detections: [], activeDetector: detector };
  }

  try {
    ctx.clearRect(0, 0, detWidth, detHeight);
    ctx.drawImage(source, 0, 0, detWidth, detHeight);
  } catch (drawErr) {
    console.warn('Skipping frame: video frame not ready for drawImage', drawErr);
    return { detections: [], activeDetector: detector };
  }

  let currentDetector = detector;
  let rawResult: ReturnType<FaceDetector['detect']>;

  try {
    rawResult = currentDetector.detect(sharedDetCanvas);
  } catch (detectErr) {
    console.warn('WebGL detect failed on canvas, switching to CPU delegate:', detectErr);
    currentDetector = await initFaceDetector(confidence, true);
    rawResult = currentDetector.detect(sharedDetCanvas);
  }

  const invScaleX = origWidth / detWidth;
  const invScaleY = origHeight / detHeight;

  const scaledDetections = (rawResult.detections || []).map((det) => {
    const bb = det.boundingBox;
    return {
      ...det,
      boundingBox: bb
        ? {
            originX: bb.originX * invScaleX,
            originY: bb.originY * invScaleY,
            width: bb.width * invScaleX,
            height: bb.height * invScaleY,
          }
        : undefined,
    };
  });

  return {
    detections: scaledDetections,
    activeDetector: currentDetector,
  };
}

// IoU (Intersection over Union) 計算
function calcIoU(
  b1: { x: number; y: number; width: number; height: number },
  b2: { x: number; y: number; width: number; height: number }
): number {
  const x1 = Math.max(b1.x, b2.x);
  const y1 = Math.max(b1.y, b2.y);
  const x2 = Math.min(b1.x + b1.width, b2.x + b2.width);
  const y2 = Math.min(b1.y + b1.height, b2.y + b2.height);

  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const interArea = interW * interH;
  if (interArea <= 0) return 0;

  const area1 = b1.width * b1.height;
  const area2 = b2.width * b2.height;
  return interArea / (area1 + area2 - interArea);
}

// 顔の検出枠に安全マージン（35%拡張）を付与して素顔のはみ出し・チラ見えを防止
export function expandBoxWithMargin(
  box: { x: number; y: number; width: number; height: number },
  margin = 0.35,
  videoWidth = 99999,
  videoHeight = 99999
): { x: number; y: number; width: number; height: number } {
  const padW = box.width * margin;
  const padH = box.height * margin;
  const nx = Math.max(0, box.x - padW / 2);
  const ny = Math.max(0, box.y - padH / 2);
  return {
    x: nx,
    y: ny,
    width: Math.min(videoWidth - nx, box.width + padW),
    height: Math.min(videoHeight - ny, box.height + padH),
  };
}

/**
 * 顔の検出枠から上半身〜全身（人物全体）の推定領域を計算
 * 顔の幅と高さを基準に、頭上から肩・胴体・足元方向へ拡張します
 */
export function estimateBodyBoxFromFace(
  faceBox: { x: number; y: number; width: number; height: number },
  videoWidth: number,
  videoHeight: number
): { x: number; y: number; width: number; height: number } {
  // 顔幅の約2.6倍の横幅（左右均等に肩幅をカバー）
  const bodyWidth = faceBox.width * 2.6;
  // 顔高の約4.5〜5.5倍の縦幅（頭上余白 + 首・胸・胴体・腰・足元をカバー）
  const bodyHeight = faceBox.height * 5.0;

  // 顔の中心X
  const centerX = faceBox.x + faceBox.width / 2;
  // 頭頂部（顔の上の余白：顔の高さの30%程度上から開始）
  const startY = Math.max(0, faceBox.y - faceBox.height * 0.35);

  let startX = centerX - bodyWidth / 2;
  startX = Math.max(0, Math.min(videoWidth - 20, startX));

  const actualWidth = Math.max(20, Math.min(videoWidth - startX, bodyWidth));
  const actualHeight = Math.max(20, Math.min(videoHeight - startY, bodyHeight));

  return {
    x: Math.round(startX),
    y: Math.round(startY),
    width: Math.round(actualWidth),
    height: Math.round(actualHeight),
  };
}

/**
 * 顔または身体バウンディングボックスから人体シルエット（頭〜首〜肩〜腕〜胴体〜脚）に沿った72頂点ポリゴンを生成する
 * フォールバック時でも四角形(rect)にならず、自然な身体のラインのポリゴン枠を保証する
 */
export function createBodySilhouettePolygon(
  bodyBox: { x: number; y: number; width: number; height: number },
  videoWidth: number,
  videoHeight: number
): Point[] {
  const { x, y, width: w, height: h } = bodyBox;
  const cx = x + w * 0.5;

  // 時計回りに頭部・首・両肩・腕・胴体・脚のシルエット制御点を定義
  const template: Array<[number, number]> = [
    [0.0, 0.0], // 頭頂
    [0.14, 0.02], // 右側頭部上
    [0.2, 0.09], // 右こめかみ・耳
    [0.16, 0.17], // 右顎
    [0.12, 0.21], // 右首筋
    [0.36, 0.25], // 右肩先
    [0.46, 0.34], // 右上腕外側
    [0.49, 0.52], // 右肘外側
    [0.47, 0.72], // 右前腕・手外側
    [0.39, 0.88], // 右腰・太もも外側
    [0.35, 1.0], // 右裾・足元右
    [0.0, 1.0], // 下端中央
    [-0.35, 1.0], // 左裾・足元左
    [-0.39, 0.88], // 左腰・太もも外側
    [-0.47, 0.72], // 左前腕・手外側
    [-0.49, 0.34], // 左肘〜上腕外側
    [-0.46, 0.34], // 左上腕外側
    [-0.36, 0.25], // 左肩先
    [-0.12, 0.21], // 左首筋
    [-0.16, 0.17], // 左顎
    [-0.2, 0.09], // 左こめかみ・耳
    [-0.14, 0.02], // 左側頭部上
  ];

  const basePts: Point[] = template.map(([ox, oy]) => ({
    x: Math.max(0, Math.min(videoWidth, cx + ox * w)),
    y: Math.max(0, Math.min(videoHeight, y + oy * h)),
  }));

  const dense = resampleClosedPolygon(basePts, BODY_CONTOUR_POINTS);
  const smoothed = smoothClosedPolygon(dense, 3);
  return resampleClosedPolygon(smoothed, BODY_CONTOUR_POINTS);
}

let nextPersonId = 1;

/**
 * 毎フレーム検出結果を受け取り、ID付与＋見失い補間（速度予測バッファ）を行う
 */
export function updatePersonTracks(
  existingTracks: DetectedPerson[],
  rawBoxes: Array<{ x: number; y: number; width: number; height: number; score: number }>,
  currentTime: number,
  maxMissBufferFrames = 8 // 見失い補間フレーム数
): DetectedPerson[] {
  const updated: DetectedPerson[] = [];
  const matchedRawIndices = new Set<number>();

  // 1. 既存のトラックに対して直近の検出ボックスをマッチング
  for (const track of existingTracks) {
    let bestIoU = 0;
    let bestIdx = -1;

    // 前回の速度を考慮した予測位置
    const predictedBox = {
      x: track.box.x + track.velocity.vx,
      y: track.box.y + track.velocity.vy,
      width: track.box.width,
      height: track.box.height,
    };

    for (let i = 0; i < rawBoxes.length; i++) {
      if (matchedRawIndices.has(i)) continue;
      const iou = calcIoU(predictedBox, rawBoxes[i]);
      if (iou > bestIoU) {
        bestIoU = iou;
        bestIdx = i;
      }
    }

    if (bestIdx !== -1 && bestIoU > 0.15) {
      // マッチ成功
      const matched = rawBoxes[bestIdx];
      matchedRawIndices.add(bestIdx);

      // 移動ベクトルの平滑化 (EMA)
      const vx = matched.x - track.box.x;
      const vy = matched.y - track.box.y;
      const smoothedVx = track.velocity.vx * 0.4 + vx * 0.6;
      const smoothedVy = track.velocity.vy * 0.4 + vy * 0.6;

      updated.push({
        ...track,
        box: { ...matched },
        score: matched.score,
        missCount: 0,
        lastSeenTime: currentTime,
        velocity: { vx: smoothedVx, vy: smoothedVy },
      });
    } else {
      // 見失った場合：直前の移動ベクトルで予測位置を維持（見失い補間バッファ）
      if (track.missCount < maxMissBufferFrames) {
        const nextBox = {
          x: track.box.x + track.velocity.vx * 0.9,
          y: track.box.y + track.velocity.vy * 0.9,
          width: track.box.width,
          height: track.box.height,
        };

        updated.push({
          ...track,
          box: nextBox,
          missCount: track.missCount + 1,
          velocity: {
            vx: track.velocity.vx * 0.8,
            vy: track.velocity.vy * 0.8,
          },
        });
      }
    }
  }

  // 2. 新規検出された人物に新しいIDを発行
  for (let i = 0; i < rawBoxes.length; i++) {
    if (!matchedRawIndices.has(i)) {
      const b = rawBoxes[i];
      updated.push({
        trackId: nextPersonId++,
        label: `人物 #${nextPersonId - 1}`,
        box: { ...b },
        score: b.score,
        enabled: true,
        missCount: 0,
        lastSeenTime: currentTime,
        velocity: { vx: 0, vy: 0 },
      });
    }
  }

  return updated;
}

