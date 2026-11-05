export type MosaicType = 'pixel' | 'blur' | 'black';

export type ShapeType = 'rect' | 'brush' | 'polygon';

export interface Point {
  x: number;
  y: number;
}

export interface Keyframe {
  time: number; // 秒
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  points?: Point[]; // ブラシやポリゴンの場合
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

export type EditorMode = 'select' | 'add_rect' | 'add_brush' | 'add_polygon' | 'adjust_keyframe';

