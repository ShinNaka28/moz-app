import { FilesetResolver, FaceDetector, ImageSegmenter } from '@mediapipe/tasks-vision';
import { DetectedPerson, Point } from '../types';

let faceDetectorInstance: FaceDetector | null = null;
let segmenterInstance: ImageSegmenter | null = null;
let isInitializing = false;
let isInitializingSegmenter = false;

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
        outputConfidenceMasks: false,
        outputCategoryMask: true,
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
      outputConfidenceMasks: false,
      outputCategoryMask: true,
    });
    return segmenterInstance;
  } finally {
    isInitializingSegmenter = false;
  }
}

// 2D Canvas バッファ（<video> を直接 WebGL2 texImage2D に渡すとスマホ環境で未デコードや cross-origin エラーになる問題を完全回避）
let sharedDetCanvas: HTMLCanvasElement | null = null;

/**
 * 輪郭の点列を Ramer-Douglas-Peucker (RDP) アルゴリズムで間引き・平滑化
 */
function perpendicularDistance(p: Point, p1: Point, p2: Point): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const mag = Math.hypot(dx, dy);
  if (mag === 0) return Math.hypot(p.x - p1.x, p.y - p1.y);
  return Math.abs(dy * p.x - dx * p.y + p2.x * p1.y - p2.y * p1.x) / mag;
}

function rdpSimplify(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points;
  let dmax = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (d > dmax) {
      dmax = d;
      index = i;
    }
  }
  if (dmax > epsilon) {
    const rec1 = rdpSimplify(points.slice(0, index + 1), epsilon);
    const rec2 = rdpSimplify(points.slice(index), epsilon);
    return rec1.slice(0, rec1.length - 1).concat(rec2);
  }
  return [points[0], points[points.length - 1]];
}

/**
 * 2値マスクから境界（アウトライン）をトレースしてポリゴン輪郭を抽出する
 */
function extractContourFromMask(
  mask: Uint8Array,
  maskW: number,
  maskH: number,
  origW: number,
  origH: number
): { points: Point[]; bounds: { x: number; y: number; width: number; height: number } } | null {
  // マスク内の有効ピクセルを走査
  let minX = maskW;
  let maxX = 0;
  let minY = maskH;
  let maxY = 0;
  let count = 0;

  for (let y = 0; y < maskH; y++) {
    for (let x = 0; x < maskW; x++) {
      if (mask[y * maskW + x] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        count++;
      }
    }
  }

  // 人物のピクセル数が少なすぎる場合は無効
  if (count < 120 || minX >= maxX || minY >= maxY) {
    return null;
  }

  // 8方向探索による外周輪郭追跡（ムーア近傍探索）
  const dx = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy = [0, 1, 1, 1, 0, -1, -1, -1];

  let startX = -1;
  let startY = -1;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (mask[y * maskW + x] > 0) {
        startX = x;
        startY = y;
        break;
      }
    }
    if (startX !== -1) break;
  }

  if (startX === -1) return null;

  const rawContour: Point[] = [];
  let cx = startX;
  let cy = startY;
  let dir = 0;
  const maxSteps = maskW * maskH;
  let steps = 0;

  while (steps < maxSteps) {
    rawContour.push({ x: cx, y: cy });
    let found = false;
    for (let d = 0; d < 8; d++) {
      const nd = (dir + d) % 8;
      const nx = cx + dx[nd];
      const ny = cy + dy[nd];
      if (nx >= 0 && nx < maskW && ny >= 0 && ny < maskH && mask[ny * maskW + nx] > 0) {
        cx = nx;
        cy = ny;
        dir = (nd + 5) % 8; // 次の開始方向
        found = true;
        break;
      }
    }
    if (!found || (cx === startX && cy === startY && rawContour.length > 2)) {
      break;
    }
    steps++;
  }

  if (rawContour.length < 4) return null;

  // 座標を元解像度へスケーリング
  const scaleX = origW / maskW;
  const scaleY = origH / maskH;

  const scaledContour: Point[] = rawContour.map((p) => ({
    x: Math.round(p.x * scaleX),
    y: Math.round(p.y * scaleY),
  }));

  // RDP による輪郭線の最適化（頂点数約 40〜80 点に簡略化）
  const simplified = rdpSimplify(scaledContour, Math.max(2, origW / 240));

  return {
    points: simplified,
    bounds: {
      x: Math.round(minX * scaleX),
      y: Math.round(minY * scaleY),
      width: Math.round((maxX - minX + 1) * scaleX),
      height: Math.round((maxY - minY + 1) * scaleY),
    },
  };
}

/**
 * スマホ・PC問わず安全に人物セグメンテーション（体のライン抽出）を実行するラッパー関数
 * 顔が隠れていても、背を向けていても、全身・上半身の体の輪郭ラインを直接抽出します
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

  let currentSegmenter = segmenter;
  let rawResult: ReturnType<ImageSegmenter['segment']>;

  try {
    rawResult = currentSegmenter.segment(sharedDetCanvas);
  } catch (err) {
    console.warn('Segmenter GPU failed on canvas, switching to CPU delegate:', err);
    currentSegmenter = await initPersonSegmenter(true);
    rawResult = currentSegmenter.segment(sharedDetCanvas);
  }

  if (!rawResult.categoryMask) {
    return { activeSegmenter: currentSegmenter, contour: null };
  }

  try {
    const maskData = rawResult.categoryMask.getAsUint8Array();
    const maskW = rawResult.categoryMask.width;
    const maskH = rawResult.categoryMask.height;

    const contour = extractContourFromMask(maskData, maskW, maskH, origWidth, origHeight);
    return { activeSegmenter: currentSegmenter, contour };
  } catch (maskErr) {
    console.warn('Error reading categoryMask data', maskErr);
    return { activeSegmenter: currentSegmenter, contour: null };
  } finally {
    try {
      rawResult.categoryMask.close();
    } catch (_) {}
  }
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

