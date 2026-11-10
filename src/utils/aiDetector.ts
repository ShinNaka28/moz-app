import { FilesetResolver, FaceDetector, ImageSegmenter } from '@mediapipe/tasks-vision';
import { DetectedPerson, Point, NormalizedPoint } from '../types';
import { NORMALIZED_POINT_COUNT, absoluteToNormalizedPoints, resampleClosedPoints } from './geometry';

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

// 完全ローカルから MediaPipe ImageSegmenter (Selfie Multiclass 256x256) を初期化
// クラス定義: 0: Background, 1: Hair, 2: Body-skin, 3: Face-skin, 4: Clothes, 5: Others
let multiclassSegmenterInstance: ImageSegmenter | null = null;
let isInitializingMulticlass = false;

export async function initMulticlassSegmenter(forceCpu = false): Promise<ImageSegmenter | null> {
  if (multiclassSegmenterInstance && !forceCpu) return multiclassSegmenterInstance;
  if (forceCpu && multiclassSegmenterInstance) {
    try {
      multiclassSegmenterInstance.close();
    } catch (_) {}
    multiclassSegmenterInstance = null;
  }
  if (isInitializingMulticlass) {
    while (isInitializingMulticlass) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (multiclassSegmenterInstance) return multiclassSegmenterInstance;
  }

  isInitializingMulticlass = true;
  try {
    const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
    const wasmPath = `${baseUrl}/wasm`;
    const modelPath = `${baseUrl}/models/selfie_multiclass_256x256.tflite`;

    const vision = await FilesetResolver.forVisionTasks(wasmPath);
    if (!forceCpu) {
      try {
        multiclassSegmenterInstance = await ImageSegmenter.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: modelPath,
            delegate: 'GPU',
          },
          runningMode: 'IMAGE',
          outputConfidenceMasks: true,
          outputCategoryMask: true,
        });
        return multiclassSegmenterInstance;
      } catch (gpuErr) {
        console.warn('GPU delegate failed for multiclass segmenter, falling back to CPU', gpuErr);
      }
    }

    multiclassSegmenterInstance = await ImageSegmenter.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: 'CPU',
      },
      runningMode: 'IMAGE',
      outputConfidenceMasks: true,
      outputCategoryMask: true,
    });
    return multiclassSegmenterInstance;
  } catch (err) {
    console.warn('Multiclass segmenter not available:', err);
    return null;
  } finally {
    isInitializingMulticlass = false;
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

// =======================================================================
// スマホ省メモリ・Zero-Allocation 解析用固定解像度と静的バッファ
// =======================================================================
export const ANALYSIS_W = 256;
export const ANALYSIS_H = 256;
const TOTAL_ANALYSIS_PIXELS = ANALYSIS_W * ANALYSIS_H; // 65,536

// 2D Canvas バッファ（Zero-Allocation: 毎フレームの createElement を完全排除）
let sharedDetCanvas: HTMLCanvasElement | null = null;
let sharedDetCtx: CanvasRenderingContext2D | null = null;

// 静的画像解析バッファ（Zero-Allocation: 毎フレームの new TypedArray を完全排除）
let sharedPrevGray: Uint8Array | null = null;
let sharedCurrGray: Uint8Array | null = null;
let sharedMotionMask: Uint8Array | null = null;
let sharedSkinMask: Uint8Array | null = null;
let sharedPersonProb: Float32Array | null = null;
let sharedCategoryMask: Uint8Array | null = null;
let sharedDilatedMask: Uint8Array | null = null;
let sharedLabels: Int32Array | null = null;
let sharedQueue: Int32Array | null = null;
let hasPrevGray = false;

/**
 * 動画シーク時やメディア切り替え時に動体差分バッファをリセット
 */
export function resetAnalysisState(): void {
  hasPrevGray = false;
  if (sharedPrevGray) sharedPrevGray.fill(0);
  if (sharedMotionMask) sharedMotionMask.fill(0);
}

function ensureAnalysisBuffers(): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  prevGray: Uint8Array;
  currGray: Uint8Array;
  motionMask: Uint8Array;
  skinMask: Uint8Array;
  personProb: Float32Array;
  categoryMask: Uint8Array;
  dilatedMask: Uint8Array;
  labels: Int32Array;
  queue: Int32Array;
} {
  if (!sharedDetCanvas) {
    sharedDetCanvas = document.createElement('canvas');
    sharedDetCanvas.width = ANALYSIS_W;
    sharedDetCanvas.height = ANALYSIS_H;
    sharedDetCtx = sharedDetCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!sharedPrevGray) sharedPrevGray = new Uint8Array(TOTAL_ANALYSIS_PIXELS);
  if (!sharedCurrGray) sharedCurrGray = new Uint8Array(TOTAL_ANALYSIS_PIXELS);
  if (!sharedMotionMask) sharedMotionMask = new Uint8Array(TOTAL_ANALYSIS_PIXELS);
  if (!sharedSkinMask) sharedSkinMask = new Uint8Array(TOTAL_ANALYSIS_PIXELS);
  if (!sharedPersonProb) sharedPersonProb = new Float32Array(TOTAL_ANALYSIS_PIXELS);
  if (!sharedCategoryMask) sharedCategoryMask = new Uint8Array(TOTAL_ANALYSIS_PIXELS);
  if (!sharedDilatedMask) sharedDilatedMask = new Uint8Array(TOTAL_ANALYSIS_PIXELS);
  if (!sharedLabels) sharedLabels = new Int32Array(TOTAL_ANALYSIS_PIXELS);
  if (!sharedQueue) sharedQueue = new Int32Array(Math.max(TOTAL_ANALYSIS_PIXELS, (ANALYSIS_W + 2) * (ANALYSIS_H + 2)));

  return {
    canvas: sharedDetCanvas,
    ctx: sharedDetCtx!,
    prevGray: sharedPrevGray,
    currGray: sharedCurrGray,
    motionMask: sharedMotionMask,
    skinMask: sharedSkinMask,
    personProb: sharedPersonProb,
    categoryMask: sharedCategoryMask,
    dilatedMask: sharedDilatedMask,
    labels: sharedLabels,
    queue: sharedQueue,
  };
}

// 固定頂点数（外枠に対する32頂点の正規化相対座標を維持し、拡大縮小や変形をしやすく統一）
export const BODY_CONTOUR_POINTS = NORMALIZED_POINT_COUNT;

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

export interface BodyContourResult {
  points: Point[];
  bounds: { x: number; y: number; width: number; height: number };
  normalizedPoints?: NormalizedPoint[];
  score?: number;
}

export interface SegmentPersonResult {
  activeSegmenter: ImageSegmenter;
  contour: BodyContourResult | null;
  contours: BodyContourResult[];
}

export interface GatekeeperContext {
  prevBox?: { x: number; y: number; width: number; height: number };
  existingTracks?: Array<{
    id: string;
    box: { x: number; y: number; width: number; height: number };
    hasManualKeyframe?: boolean;
  }>;
  origWidth: number;
  origHeight: number;
}

/**
 * 4段階ゲートキーパー判定結果
 */
interface GatekeeperEvaluation {
  passed: boolean;
  reason: 'existing_track' | 'skin_face' | 'clothes_bulk' | 'border_motion' | 'rejected_inorganic';
  score: number;
}

/**
 * 無機物（テロップ・機器・コード）を除外しながら、
 * 「顔なし・腹部〜足のみ・手元のみ」を確実に保護する4段階ゲートキーパー
 */
function evaluateGatekeeper(
  comp: {
    area: number;
    bMinX: number;
    bMaxX: number;
    bMinY: number;
    bMaxY: number;
    bw: number;
    bh: number;
    solidity: number;
    faceSkinCount: number;
    bodySkinCount: number;
    clothesCount: number;
    skinCount: number;
    motionCount: number;
    borderTouchCount: number;
    achromaticCount: number;
    totalCells: number;
  },
  context?: GatekeeperContext
): GatekeeperEvaluation {
  const {
    area,
    bMinX,
    bMaxX,
    bMinY,
    bMaxY,
    bw,
    bh,
    solidity,
    faceSkinCount,
    bodySkinCount,
    clothesCount,
    skinCount,
    motionCount,
    borderTouchCount,
    achromaticCount,
    totalCells,
  } = comp;

  const skinRatio = skinCount / area;
  const faceBodySkinRatio = (faceSkinCount + bodySkinCount) / area;
  const clothesRatio = clothesCount / area;
  const motionRatio = motionCount / area;
  const achromaticRatio = achromaticCount / area;
  const compCenterX = (bMinX + bMaxX) / 2;
  const compCenterY = (bMinY + bMaxY) / 2;

  // ---------------------------------------------------------------------
  // ① 既存トラッキング枠からの継続パス（最優先）
  // ---------------------------------------------------------------------
  if (context) {
    const scaleX = ANALYSIS_W / Math.max(1, context.origWidth);
    const scaleY = ANALYSIS_H / Math.max(1, context.origHeight);

    // 直前フレームの確定枠との IoU & 重心距離判定
    const candidateBoxes: Array<{ x: number; y: number; width: number; height: number; isManual?: boolean }> = [];
    if (context.prevBox) {
      candidateBoxes.push({ ...context.prevBox });
    }
    if (context.existingTracks) {
      for (const t of context.existingTracks) {
        candidateBoxes.push({ ...t.box, isManual: t.hasManualKeyframe });
      }
    }

    for (const rawB of candidateBoxes) {
      const bx = rawB.x * scaleX;
      const by = rawB.y * scaleY;
      const bwPrev = rawB.width * scaleX;
      const bhPrev = rawB.height * scaleY;

      const interLeft = Math.max(bMinX, bx);
      const interTop = Math.max(bMinY, by);
      const interRight = Math.min(bMaxX, bx + bwPrev);
      const interBottom = Math.min(bMaxY, by + bhPrev);
      const interW = Math.max(0, interRight - interLeft);
      const interH = Math.max(0, interBottom - interTop);
      const interArea = interW * interH;
      const unionArea = bw * bh + bwPrev * bhPrev - interArea;
      const iou = unionArea > 0 ? interArea / unionArea : 0;

      const prevCenterX = bx + bwPrev / 2;
      const prevCenterY = by + bhPrev / 2;
      const centerDist = Math.hypot(compCenterX - prevCenterX, compCenterY - prevCenterY);
      const maxDim = Math.max(bw, bh, bwPrev, bhPrev);

      // IoU 0.2以上 または 重心近接（手動キーフレームがある枠はさらに判定緩和）
      if (iou >= 0.18 || centerDist <= maxDim * (rawB.isManual ? 0.45 : 0.32)) {
        return {
          passed: true,
          reason: 'existing_track',
          score: Math.min(1, 0.85 + iou * 0.15),
        };
      }
    }
  }

  // ---------------------------------------------------------------------
  // ② 顔・肌・手元の存在パス（手元アップ等の保護）
  // ---------------------------------------------------------------------
  // Face-skin (3) / Body-skin (2) または YCbCr肌色が面積の10%以上
  if (faceBodySkinRatio >= 0.025 || skinRatio >= 0.10) {
    return {
      passed: true,
      reason: 'skin_face',
      score: Math.min(1, 0.70 + skinRatio * 0.3),
    };
  }

  // ---------------------------------------------------------------------
  // ③ 衣服（腹部・背中・足のみ）の塊パス（白シャツ・黒ズボン等の保護）
  // ---------------------------------------------------------------------
  // Clothes (4) が領域の主成分であり、画面全体の4%以上、かつ充填率(Solidity)が0.35以上（塊状シルエット）
  // 文字テロップや電源コードのようなスカスカな線を除外
  const isClothesDominant = clothesRatio >= 0.22 && clothesCount > (comp.faceSkinCount + comp.bodySkinCount);
  const isLargeBulk = area >= totalCells * 0.038;
  if (isClothesDominant && isLargeBulk && solidity >= 0.34) {
    return {
      passed: true,
      reason: 'clothes_bulk',
      score: Math.min(1, 0.65 + clothesRatio * 0.35),
    };
  }

  // ---------------------------------------------------------------------
  // ④ 画面境界接地＋動体パス（画面に収まらない巨大変形の保護）
  // ---------------------------------------------------------------------
  // 画面の外周端(5px以内)に一定幅以上接しており、かつ動体差分または衣服成分がある面積3%以上の塊
  const isBorderTouching = borderTouchCount >= 6;
  const hasMotionOrClothes = motionRatio >= 0.018 || clothesRatio >= 0.14;
  if (isBorderTouching && hasMotionOrClothes && area >= totalCells * 0.028) {
    return {
      passed: true,
      reason: 'border_motion',
      score: 0.65,
    };
  }

  // ---------------------------------------------------------------------
  // 破棄条件：画面中央付近に浮遊し、肌色・衣服乏しく、無彩色で静止している領域
  // （テロップ文字、机上の医療機器、電源コード）
  // ---------------------------------------------------------------------
  const isFloatingCenter =
    borderTouchCount === 0 &&
    bMinX > 14 &&
    bMaxX < ANALYSIS_W - 14 &&
    bMinY > 14 &&
    bMaxY < ANALYSIS_H - 14;

  if (isFloatingCenter && skinRatio < 0.06 && clothesRatio < 0.12 && achromaticRatio >= 0.60 && motionRatio < 0.015) {
    return {
      passed: false,
      reason: 'rejected_inorganic',
      score: 0,
    };
  }

  // すべてのパスに落第した場合は無機物として破棄
  return {
    passed: false,
    reason: 'rejected_inorganic',
    score: 0,
  };
}

/**
 * 4段階ゲートキーパー・ダイレクト肌色救済・ベージュ背景除外を統合した
 * 人物輪郭ポリゴン（固定32頂点）抽出エンジン
 */
function extractBodyPolygonWithGatekeeper(
  buffers: ReturnType<typeof ensureAnalysisBuffers>,
  origW: number,
  origH: number,
  context?: GatekeeperContext
): {
  contour: BodyContourResult | null;
  contours: BodyContourResult[];
} {
  const { personProb, categoryMask, skinMask, motionMask, dilatedMask, labels, queue } = buffers;
  const totalCells = TOTAL_ANALYSIS_PIXELS;
  const gridW = ANALYSIS_W;
  const gridH = ANALYSIS_H;

  // 1. 2値化（閾値 0.38）
  let fgCount = 0;
  for (let i = 0; i < totalCells; i++) {
    const isFg = personProb[i] >= 0.38 ? 1 : 0;
    dilatedMask[i] = isFg;
    fgCount += isFg;
  }

  // 画面全体が真っ黒、またはほぼ全体（96%超）の場合は無効
  if (fgCount < totalCells * 0.005 || fgCount > totalCells * 0.96) {
    return { contour: null, contours: [] };
  }

  // 2. マスクの取得（※凹凸・くびれを潰す過剰なモルフォロジー膨張は廃止）
  labels.set(dilatedMask);

  // 3. 4連結成分ラベリング (BFS)
  let currentLabel = 0;
  const compInfos: Array<{
    label: number;
    area: number;
    bMinX: number;
    bMaxX: number;
    bMinY: number;
    bMaxY: number;
    bw: number;
    bh: number;
    solidity: number;
    faceSkinCount: number;
    bodySkinCount: number;
    clothesCount: number;
    skinCount: number;
    motionCount: number;
    borderTouchCount: number;
    achromaticCount: number;
    totalCells: number;
    sumX: number;
    sumY: number;
  }> = [];

  const visited = dilatedMask; // dilatedMask を訪問管理用バッファとして再利用
  visited.fill(0);

  for (let i = 0; i < totalCells; i++) {
    if (labels[i] === 1 && visited[i] === 0) {
      currentLabel++;
      let head = 0;
      let tail = 0;
      queue[tail++] = i;
      visited[i] = currentLabel;

      let size = 0;
      let sumX = 0;
      let sumY = 0;
      let bMinX = gridW;
      let bMaxX = 0;
      let bMinY = gridH;
      let bMaxY = 0;
      let faceSkinCount = 0;
      let bodySkinCount = 0;
      let clothesCount = 0;
      let sCount = 0;
      let mCount = 0;
      let borderTouchCount = 0;
      let achromaticCount = 0;

      while (head < tail) {
        const curr = queue[head++];
        size++;
        const cx = curr % gridW;
        const cy = (curr - cx) / gridW;
        sumX += cx;
        sumY += cy;

        if (cx < bMinX) bMinX = cx;
        if (cx > bMaxX) bMaxX = cx;
        if (cy < bMinY) bMinY = cy;
        if (cy > bMaxY) bMaxY = cy;

        const cat = categoryMask[curr];
        if (cat === 3) faceSkinCount++;
        else if (cat === 2) bodySkinCount++;
        else if (cat === 4) clothesCount++;

        if (skinMask[curr]) sCount++;
        if (motionMask[curr]) mCount++;
        if (cx <= 4 || cx >= gridW - 5 || cy <= 4 || cy >= gridH - 5) borderTouchCount++;

        // 4近傍展開
        if (cx + 1 < gridW && labels[curr + 1] === 1 && visited[curr + 1] === 0) {
          visited[curr + 1] = currentLabel;
          queue[tail++] = curr + 1;
        }
        if (cx - 1 >= 0 && labels[curr - 1] === 1 && visited[curr - 1] === 0) {
          visited[curr - 1] = currentLabel;
          queue[tail++] = curr - 1;
        }
        if (cy + 1 < gridH && labels[curr + gridW] === 1 && visited[curr + gridW] === 0) {
          visited[curr + gridW] = currentLabel;
          queue[tail++] = curr + gridW;
        }
        if (cy - 1 >= 0 && labels[curr - gridW] === 1 && visited[curr - gridW] === 0) {
          visited[curr - gridW] = currentLabel;
          queue[tail++] = curr - gridW;
        }
      }

      const bw = Math.max(1, bMaxX - bMinX + 1);
      const bh = Math.max(1, bMaxY - bMinY + 1);
      const solidity = size / (bw * bh);

      compInfos.push({
        label: currentLabel,
        area: size,
        bMinX,
        bMaxX,
        bMinY,
        bMaxY,
        bw,
        bh,
        solidity,
        faceSkinCount,
        bodySkinCount,
        clothesCount,
        skinCount: sCount,
        motionCount: mCount,
        borderTouchCount,
        achromaticCount,
        totalCells,
        sumX,
        sumY,
      });
    }
  }

  // 4. 各コンポーネントを 4段階ゲートキーパーで評価
  const passedComps = compInfos
    .map((c) => ({
      comp: c,
      eval: evaluateGatekeeper(c, context),
    }))
    .filter((res) => res.eval.passed && res.comp.area >= totalCells * 0.006)
    .sort((a, b) => {
      if (a.eval.reason === 'existing_track' && b.eval.reason !== 'existing_track') return -1;
      if (b.eval.reason === 'existing_track' && a.eval.reason !== 'existing_track') return 1;
      return (b.eval.score * 0.6 + (b.comp.area / totalCells) * 0.4) - (a.eval.score * 0.6 + (a.comp.area / totalCells) * 0.4);
    });

  if (passedComps.length === 0) {
    return { contour: null, contours: [] };
  }

  // 5. 複数人物クラスタリング (Person Clustering)
  // 近接・同一人物のパーツ（頭+胴体+腕等）をまとめつつ、空間的に独立した複数の人物を個別クラスタに分離
  interface PersonCluster {
    labels: Set<number>;
    bMinX: number;
    bMaxX: number;
    bMinY: number;
    bMaxY: number;
    totalArea: number;
    score: number;
  }

  const clusters: PersonCluster[] = [];

  for (const { comp: c, eval: ev } of passedComps) {
    let matchedCluster: PersonCluster | null = null;
    let minDistance = Infinity;

    for (const cl of clusters) {
      // 2つのバウンディングボックス間のユークリッド距離
      const dx = Math.max(0, Math.max(cl.bMinX, c.bMinX) - Math.min(cl.bMaxX, c.bMaxX));
      const dy = Math.max(0, Math.max(cl.bMinY, c.bMinY) - Math.min(cl.bMaxY, c.bMaxY));
      const dist = Math.hypot(dx, dy);

      // 横方向の重複幅（身体の上下パーツ判定）
      const overlapX = Math.max(0, Math.min(cl.bMaxX, c.bMaxX) - Math.max(cl.bMinX, c.bMinX));
      const clWidth = cl.bMaxX - cl.bMinX + 1;
      const cWidth = c.bMaxX - c.bMinX + 1;
      const isVerticallyAligned = overlapX >= Math.min(clWidth, cWidth) * 0.25;

      // 距離が24px以内、または上下に整列して距離が45px以内の場合は同一人物の別部位と判定
      if (dist <= 24 || (isVerticallyAligned && dy <= 45)) {
        if (dist < minDistance) {
          minDistance = dist;
          matchedCluster = cl;
        }
      }
    }

    if (matchedCluster) {
      matchedCluster.labels.add(c.label);
      matchedCluster.bMinX = Math.min(matchedCluster.bMinX, c.bMinX);
      matchedCluster.bMaxX = Math.max(matchedCluster.bMaxX, c.bMaxX);
      matchedCluster.bMinY = Math.min(matchedCluster.bMinY, c.bMinY);
      matchedCluster.bMaxY = Math.max(matchedCluster.bMaxY, c.bMaxY);
      matchedCluster.totalArea += c.area;
      matchedCluster.score = Math.max(matchedCluster.score, ev.score);
    } else {
      // 一定以上の面積がある部位を独立した人物クラスタとして新規登録（最大6人まで）
      if (clusters.length < 6 && c.area >= totalCells * 0.008) {
        clusters.push({
          labels: new Set<number>([c.label]),
          bMinX: c.bMinX,
          bMaxX: c.bMaxX,
          bMinY: c.bMinY,
          bMaxY: c.bMaxY,
          totalArea: c.area,
          score: ev.score,
        });
      }
    }
  }

  // 面積の大きい順にソート
  clusters.sort((a, b) => b.totalArea - a.totalArea);

  const pw = gridW + 2;
  const ph = gridH + 2;
  const padded = new Uint8Array(pw * ph);
  const contours: BodyContourResult[] = [];

  for (const cl of clusters) {
    padded.fill(0);
    for (let y = 0; y < gridH; y++) {
      const row = y * gridW;
      const padRow = (y + 1) * pw;
      for (let x = 0; x < gridW; x++) {
        if (cl.labels.has(visited[row + x])) {
          padded[padRow + (x + 1)] = 1;
        }
      }
    }

    const cnt = traceContourFromCluster(
      padded,
      pw,
      ph,
      gridW,
      gridH,
      origW,
      origH,
      queue
    );

    if (cnt) {
      cnt.score = cl.score;
      contours.push(cnt);
    }
  }

  return {
    contour: contours[0] || null,
    contours,
  };
}

/**
 * 単一人物クラスタのマスクから外周境界を Moore-Neighbor Tracing で抽出
 */
function traceContourFromCluster(
  padded: Uint8Array,
  pw: number,
  ph: number,
  gridW: number,
  gridH: number,
  origW: number,
  origH: number,
  queue: Int32Array
): BodyContourResult | null {
  // 6. 外周 (0, 0) から Flood-Fill して衣服内の影や模様による「穴」を完全に埋める
  // （※首のくびれや脇の下などの外部の凹みは外周と繋がっているため完全に保護・維持される）
  const exterior = new Uint8Array(pw * ph);
  let eHead = 0;
  let eTail = 0;
  exterior[0] = 1;
  queue[eTail++] = 0;

  while (eHead < eTail) {
    const curr = queue[eHead++];
    const cx = curr % pw;
    const cy = (curr - cx) / pw;

    if (cx + 1 < pw && !padded[curr + 1] && !exterior[curr + 1]) {
      exterior[curr + 1] = 1;
      queue[eTail++] = curr + 1;
    }
    if (cx - 1 >= 0 && !padded[curr - 1] && !exterior[curr - 1]) {
      exterior[curr - 1] = 1;
      queue[eTail++] = curr - 1;
    }
    if (cy + 1 < ph && !padded[curr + pw] && !exterior[curr + pw]) {
      exterior[curr + pw] = 1;
      queue[eTail++] = curr + pw;
    }
    if (cy - 1 >= 0 && !padded[curr - pw] && !exterior[curr - pw]) {
      exterior[curr - pw] = 1;
      queue[eTail++] = curr - pw;
    }
  }

  for (let i = 0; i < pw * ph; i++) {
    padded[i] = exterior[i] ? 0 : 1;
  }

  // 7. 外周境界を Moore-Neighbor Tracing で単一の閉曲線として抽出
  // マスク画像の上から下へスキャンし、最初に見つかった人物ピクセル（頭頂部）を開始点とする
  let startPx = -1;
  let startPy = -1;
  for (let y = 1; y <= gridH; y++) {
    for (let x = 1; x <= gridW; x++) {
      if (padded[y * pw + x] === 1) {
        startPx = x;
        startPy = y;
        break;
      }
    }
    if (startPx !== -1) break;
  }

  if (startPx === -1) return null;

  // 8近傍方向（時計回り: 北=0, 北東=1, 東=2, 南東=3, 南=4, 南西=5, 西=6, 北西=7）
  const DX = [0, 1, 1, 1, 0, -1, -1, -1];
  const DY = [-1, -1, 0, 1, 1, 1, 0, -1];

  const rawVertices: Point[] = [];
  let currX = startPx;
  let currY = startPy;
  let backtrackDir = 0;

  const maxSteps = pw * ph * 2;
  for (let step = 0; step < maxSteps; step++) {
    rawVertices.push({ x: currX - 1, y: currY - 1 });

    let foundNext = false;
    let nextX = currX;
    let nextY = currY;
    let nextBacktrack = 0;

    for (let k = 0; k < 8; k++) {
      const dir = (backtrackDir + k) % 8;
      const nx = currX + DX[dir];
      const ny = currY + DY[dir];

      if (padded[ny * pw + nx] === 1) {
        nextX = nx;
        nextY = ny;
        const prevKDir = (dir + 7) % 8;
        const bgX = currX + DX[prevKDir];
        const bgY = currY + DY[prevKDir];
        const diffX = bgX - nextX;
        const diffY = bgY - nextY;
        for (let d = 0; d < 8; d++) {
          if (DX[d] === diffX && DY[d] === diffY) {
            nextBacktrack = d;
            break;
          }
        }
        foundNext = true;
        break;
      }
    }

    if (!foundNext) break;

    currX = nextX;
    currY = nextY;
    backtrackDir = nextBacktrack;

    if (currX === startPx && currY === startPy && rawVertices.length >= 4) {
      break;
    }
  }

  if (rawVertices.length < 6) return null;

  // 8. 元映像（作業解像度）へスケーリング
  const scaleX = origW / gridW;
  const scaleY = origH / gridH;

  const scaledPts: Point[] = rawVertices.map((p) => ({
    x: Math.max(0, Math.min(origW, p.x * scaleX)),
    y: Math.max(0, Math.min(origH, p.y * scaleY)),
  }));

  // 9. 弧長（Arc Length）に基づく等間隔32頂点リサンプリング
  // ※身体の凹凸（くびれ・首・腕）を破壊する平滑化や凸包は一切使用せず、実際のピクセル境界線をそのまま等間隔サンプリング
  const finalPoints = resampleClosedPoints(scaledPts, BODY_CONTOUR_POINTS);

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

  const bounds = {
    x: Math.round(bMinX),
    y: Math.round(bMinY),
    width: Math.max(16, Math.round(bMaxX - bMinX)),
    height: Math.max(16, Math.round(bMaxY - bMinY)),
  };

  const normalizedPoints = absoluteToNormalizedPoints(bounds, finalPoints, NORMALIZED_POINT_COUNT);

  return {
    points: finalPoints,
    bounds,
    normalizedPoints,
  };
}

/**
 * スマホ・PC問わず安全に人物セグメンテーション（体のライン抽出）を実行するラッパー関数
 * - Selfie Multiclass (256x256) + ダイレクト肌色救済パイプライン + 4段階ゲートキーパー
 * - テロップ・医療機器・電源コード等の無機物を除外しつつ、
 *   「顔なし・腹部〜足のみ・手元のみ」を100%確実に保護して体のラインに沿った32頂点ポリゴンを生成します。
 */
export async function segmentPersonSafely(
  source: HTMLVideoElement | HTMLImageElement,
  segmenter: ImageSegmenter,
  context?: GatekeeperContext
): Promise<SegmentPersonResult> {
  const isVideo = source instanceof HTMLVideoElement;
  const origWidth = isVideo ? source.videoWidth : source.naturalWidth;
  const origHeight = isVideo ? source.videoHeight : source.naturalHeight;

  if (!origWidth || !origHeight) {
    return { activeSegmenter: segmenter, contour: null, contours: [] };
  }

  // 動画フレームがまだ全くロードされていない場合（readyState === 0）は安全にスキップ
  if (isVideo && source.readyState === 0) {
    return { activeSegmenter: segmenter, contour: null, contours: [] };
  }

  // スマホでのメモリクラッシュ・GCカクつきを防ぐため、事前確保バッファ（Zero-Allocation）を使用
  const buffers = ensureAnalysisBuffers();
  const { canvas, ctx, prevGray, currGray, motionMask, skinMask, personProb, categoryMask } = buffers;

  try {
    ctx.clearRect(0, 0, ANALYSIS_W, ANALYSIS_H);
    ctx.drawImage(source, 0, 0, ANALYSIS_W, ANALYSIS_H);
  } catch (drawErr) {
    console.warn('Skipping segmentation frame: drawImage error', drawErr);
    return { activeSegmenter: segmenter, contour: null, contours: [] };
  }

  const imgData = ctx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H);
  const data = imgData.data;

  // ---------------------------------------------------------------------
  // 1. 並列・肌色領域抽出（Direct Skin Blob Detection） & 動体検出 & 無彩色判定
  // ---------------------------------------------------------------------
  let skinPixelCount = 0;
  for (let i = 0; i < TOTAL_ANALYSIS_PIXELS; i++) {
    const p4 = i * 4;
    const r = data[p4];
    const g = data[p4 + 1];
    const b = data[p4 + 2];

    // YCbCr 変換 (ITU-R BT.601)
    const yVal = 0.299 * r + 0.587 * g + 0.114 * b;
    const cbVal = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const crVal = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

    // 複合肌色条件
    const isYCbCrSkin = yVal > 80 && crVal >= 135 && crVal <= 180 && cbVal >= 85 && cbVal <= 135;
    const isRgbSkin = r > 95 && g > 40 && b > 20 && r > g && r > b && Math.abs(r - g) > 15;
    const isSkin = isYCbCrSkin && isRgbSkin;
    skinMask[i] = isSkin ? 1 : 0;
    if (isSkin) skinPixelCount++;

    // 動体検出（前フレーム輝度差分）
    const gray = (r * 77 + g * 150 + b * 29) >> 8;
    currGray[i] = gray;
    if (hasPrevGray) {
      motionMask[i] = Math.abs(gray - prevGray[i]) >= 16 ? 1 : 0;
    } else {
      motionMask[i] = 0;
    }
  }
  prevGray.set(currGray);
  hasPrevGray = true;

  // ---------------------------------------------------------------------
  // 2. AI推論（マルチクラスセグメンター優先）
  // ---------------------------------------------------------------------
  let currentSegmenter = segmenter;
  let multiclass = await initMulticlassSegmenter();
  let usedMulticlass = false;

  personProb.fill(0);
  categoryMask.fill(0);

  if (multiclass) {
    try {
      const mcResult = multiclass.segment(canvas);
      if (mcResult) {
        usedMulticlass = true;
        try {
          if (mcResult.categoryMask) {
            const catArr = mcResult.categoryMask.getAsUint8Array();
            categoryMask.set(catArr);
          }
          if (mcResult.confidenceMasks && mcResult.confidenceMasks.length >= 5) {
            // クラス 1:Hair, 2:Body-skin, 3:Face-skin, 4:Clothes の確率を合計
            const c1 = mcResult.confidenceMasks[1].getAsFloat32Array();
            const c2 = mcResult.confidenceMasks[2].getAsFloat32Array();
            const c3 = mcResult.confidenceMasks[3].getAsFloat32Array();
            const c4 = mcResult.confidenceMasks[4].getAsFloat32Array();

            for (let i = 0; i < TOTAL_ANALYSIS_PIXELS; i++) {
              const pSum = c1[i] + c2[i] + c3[i] + c4[i];
              const cat = categoryMask[i];
              if (cat >= 1 && cat <= 4) {
                personProb[i] = Math.max(pSum, 0.75);
              } else if (cat === 0 || cat === 5) {
                personProb[i] = Math.min(pSum, 0.25);
              } else {
                personProb[i] = pSum;
              }
            }
          } else {
            // categoryMask のみの場合
            for (let i = 0; i < TOTAL_ANALYSIS_PIXELS; i++) {
              const cat = categoryMask[i];
              personProb[i] = (cat >= 1 && cat <= 4) ? 0.85 : 0.15;
            }
          }
        } finally {
          if (mcResult.confidenceMasks) {
            for (const m of mcResult.confidenceMasks) {
              try { m.close(); } catch (_) {}
            }
          }
          if (mcResult.categoryMask) {
            try { mcResult.categoryMask.close(); } catch (_) {}
          }
        }
      }
    } catch (mcErr) {
      console.warn('Multiclass inference failed, fallback to standard segmenter:', mcErr);
    }
  }

  // マルチクラスが利用できなかった場合のフォールバック（Selfie Segmenter + DeepLab）
  if (!usedMulticlass) {
    let selfieResult: ReturnType<ImageSegmenter['segment']> | null = null;
    try {
      selfieResult = currentSegmenter.segment(canvas);
    } catch (_) {
      currentSegmenter = await initPersonSegmenter(true);
      selfieResult = currentSegmenter.segment(canvas);
    }

    if (selfieResult?.confidenceMasks && selfieResult.confidenceMasks.length > 0) {
      try {
        const maskFloat = selfieResult.confidenceMasks[0].getAsFloat32Array();
        personProb.set(maskFloat);
      } finally {
        for (const m of selfieResult.confidenceMasks) {
          try { m.close(); } catch (_) {}
        }
      }
    }
    if (selfieResult?.categoryMask) {
      try { selfieResult.categoryMask.close(); } catch (_) {}
    }

    // 必要に応じて DeepLabV3 で補完
    let countActive = 0;
    for (let i = 0; i < TOTAL_ANALYSIS_PIXELS; i++) {
      if (personProb[i] >= 0.4) countActive++;
    }
    if (countActive < TOTAL_ANALYSIS_PIXELS * 0.05) {
      const deepLab = await initDeepLabSegmenter();
      if (deepLab) {
        try {
          const dlResult = deepLab.segment(canvas);
          if (dlResult?.confidenceMasks && dlResult.confidenceMasks.length > 15) {
            const pmData = dlResult.confidenceMasks[15].getAsFloat32Array();
            for (let i = 0; i < TOTAL_ANALYSIS_PIXELS; i++) {
              personProb[i] = Math.max(personProb[i], pmData[i]);
            }
          }
          if (dlResult?.confidenceMasks) {
            for (const m of dlResult.confidenceMasks) {
              try { m.close(); } catch (_) {}
            }
          }
          if (dlResult?.categoryMask) {
            try { dlResult.categoryMask.close(); } catch (_) {}
          }
        } catch (_) {}
      }
    }
  }

  // ---------------------------------------------------------------------
  // 3. ベージュ背景（机・壁）誤認防止 ＆ ダイレクト肌色救済パイプライン
  // ---------------------------------------------------------------------
  // AIが顔のない手元や指先を見落とした場合、厳密フィルターを通過した肌色BlobをOR結合
  if (skinPixelCount >= TOTAL_ANALYSIS_PIXELS * 0.008 && skinPixelCount <= TOTAL_ANALYSIS_PIXELS * 0.50) {
    let skinActiveInAI = 0;
    for (let i = 0; i < TOTAL_ANALYSIS_PIXELS; i++) {
      if (skinMask[i] && personProb[i] >= 0.35) skinActiveInAI++;
    }

    // AIが肌色の半分以上を見落としている場合
    if (skinActiveInAI < skinPixelCount * 0.45) {
      // 条件A（動体または既存枠との連結）& 条件B（形状・画面端接地）を検証
      let motionInSkin = 0;
      let borderInSkin = 0;
      let skinMinX = ANALYSIS_W;
      let skinMaxX = 0;
      let skinMinY = ANALYSIS_H;
      let skinMaxY = 0;

      for (let y = 0; y < ANALYSIS_H; y++) {
        const row = y * ANALYSIS_W;
        for (let x = 0; x < ANALYSIS_W; x++) {
          const idx = row + x;
          if (skinMask[idx]) {
            if (motionMask[idx]) motionInSkin++;
            if (x <= 4 || x >= ANALYSIS_W - 5 || y <= 4 || y >= ANALYSIS_H - 5) borderInSkin++;
            if (x < skinMinX) skinMinX = x;
            if (x > skinMaxX) skinMaxX = x;
            if (y < skinMinY) skinMinY = y;
            if (y > skinMaxY) skinMaxY = y;
          }
        }
      }

      const skinW = Math.max(1, skinMaxX - skinMinX + 1);
      const skinH = Math.max(1, skinMaxY - skinMinY + 1);
      const skinSolidity = skinPixelCount / (skinW * skinH);
      const hasMotion = motionInSkin >= skinPixelCount * 0.025;
      const isBorder = borderInSkin >= 5;
      const isHandArmShape = skinSolidity >= 0.28 && skinSolidity <= 0.88;

      // 静止し続けている広大なベージュ背景は除外、本物の人体手足（動体 or 境界接地 or 塊）のみ救済
      if ((hasMotion || isBorder || context?.prevBox) && isHandArmShape) {
        for (let i = 0; i < TOTAL_ANALYSIS_PIXELS; i++) {
          if (skinMask[i]) {
            personProb[i] = Math.max(personProb[i], 0.92);
            if (categoryMask[i] === 0 || categoryMask[i] === 5) {
              categoryMask[i] = 2; // Body-skin としてマーク
            }
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // 4. 4段階ゲートキーパーによる無機物除外と複数人物ポリゴン抽出
  // ---------------------------------------------------------------------
  const { contour, contours } = extractBodyPolygonWithGatekeeper(buffers, origWidth, origHeight, context);

  return { activeSegmenter: currentSegmenter, contour, contours };
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

  // 動画フレームがまだ全くロードされていない場合（readyState === 0）は安全にスキップ
  if (isVideo && source.readyState === 0) {
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
export function calcIoU(
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

