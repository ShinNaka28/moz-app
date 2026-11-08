export type MosaicType = 'pixel' | 'blur' | 'black';

export type ShapeType = 'rect' | 'brush' | 'polygon' | 'lasso';

export interface Point {
  x: number;
  y: number;
}

export interface NormalizedPoint {
  u: number; // 0.0〜1.0 (外枠の左端=0.0, 右端=1.0)
  v: number; // 0.0〜1.0 (外枠の上端=0.0, 下端=1.0)
}

export interface Keyframe {
  time: number; // 秒
  x: number; // 外枠 左上 X (作業解像度基準)
  y: number; // 外枠 左上 Y (作業解像度基準)
  width: number; // 外枠 幅
  height: number; // 外枠 高さ
  rotation?: number;
  normalizedPoints?: NormalizedPoint[]; // 固定32頂点の相対座標(0.0〜1.0)
  points?: Point[]; // 互換性＆即時描画用の絶対座標(キャッシュ)
}

export interface MosaicTrack {
  id: string;
  name: string;
  type: 'ai' | 'tracked' | 'manual';
  shape: ShapeType;
  enabled: boolean;
  mosaicType: MosaicType;
  strength: number; // 2〜50 (ピクセルサイズ or ブラー半径)
  
  // 適用時間
  startTime: number;
  endTime: number;
  
  // キーフレーム（手動または追従補正）
  keyframes: Keyframe[];
  
  // 追跡エンジンの内部データ
  trackingData?: {
    templateData?: ImageData;
    templateWidth: number;
    templateHeight: number;
    featurePoints?: Point[];
    lastTrackedTime?: number;
    isOutOfFrame?: boolean; // フレームアウト判定
  };

  // AI人物専用
  aiPersonId?: number;
  aiTarget?: 'face' | 'body';
  lastVelocity?: { vx: number; vy: number };
  missCount?: number; // 見失いフレーム数
}

export interface DetectedPerson {
  trackId: number;
  label: string;
  box: { x: number; y: number; width: number; height: number };
  score: number;
  enabled: boolean;
  missCount: number;
  lastSeenTime: number;
  velocity: { vx: number; vy: number };
}

export type EditorMode = 'select' | 'add_rect' | 'add_lasso' | 'add_brush' | 'add_polygon' | 'adjust_keyframe';

