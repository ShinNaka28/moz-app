import React, { useRef, useEffect, useState, useCallback } from 'react';
import { EditorMode, MosaicTrack, MosaicType, Point } from '../types';
import { renderTrackMosaic, renderInverseMosaic, renderTrackOverlay, ProtectedRegion } from '../utils/mosaicRenderer';
import { interpolateKeyframes, extractFeaturePoints, toGrayscale, trackBox } from '../utils/tracking';

interface VideoCanvasProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  imageRef: React.RefObject<HTMLImageElement | null>;
  isImage: boolean;
  tracks: MosaicTrack[];
  selectedTrackId: string | null;
  editorMode: EditorMode;
  currentTime: number;
  isPlaying: boolean;
  isPreviewMode?: boolean;
  isInverseMosaic?: boolean;
  inverseMosaicType?: MosaicType;
  inverseStrength?: number;
  onSelectTrack: (id: string | null) => void;
  onAddTrack: (newTrack: MosaicTrack) => void;
  onUpdateTrackKeyframe: (trackId: string, box: { x: number; y: number; width: number; height: number; points?: Point[] }) => void;
  onToggleTrackEnabled: (trackId: string) => void;
  onUpdateTrackFrameOut: (trackId: string, isOutOfFrame: boolean) => void;
  onDeleteTrack?: (trackId: string) => void;
}

export const VideoCanvas: React.FC<VideoCanvasProps> = ({
  videoRef,
  imageRef,
  isImage,
  tracks,
  selectedTrackId,
  editorMode,
  currentTime,
  isPlaying,
  isPreviewMode = false,
  isInverseMosaic = false,
  inverseMosaicType = 'blur',
  inverseStrength = 18,
  onSelectTrack,
  onAddTrack,
  onUpdateTrackKeyframe,
  onToggleTrackEnabled,
  onUpdateTrackFrameOut,
  onDeleteTrack,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));

  // トラッキング用: 前フレームのグレースケールデータ
  const prevGrayRef = useRef<Uint8Array | null>(null);
  const prevTimeRef = useRef<number>(0);

  // ドラッグ・描画インタラクションの状態
  const [drawingState, setDrawingState] = useState<{
    isDrawing: boolean;
    startPoint: Point;
    currentPoint: Point;
    points: Point[];
  } | null>(null);

  // 選択枠のドラッグ移動・リサイズ
  const [transformState, setTransformState] = useState<{
    type: 'move' | 'nw' | 'ne' | 'se' | 'sw';
    trackId: string;
    startMouse: Point;
    initialBox: { x: number; y: number; width: number; height: number };
  } | null>(null);

  // キャンバス座標系への変換
  const getCanvasCoords = (e: React.MouseEvent | React.TouchEvent): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  };

  // メイン描画ループ
  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const media = isImage ? imageRef.current : videoRef.current;
    if (!media) return;

    const mediaWidth = isImage ? (media as HTMLImageElement).naturalWidth : (media as HTMLVideoElement).videoWidth;
    const mediaHeight = isImage ? (media as HTMLImageElement).naturalHeight : (media as HTMLVideoElement).videoHeight;

    if (!mediaWidth || !mediaHeight) return;

    if (canvas.width !== mediaWidth || canvas.height !== mediaHeight) {
      canvas.width = mediaWidth;
      canvas.height = mediaHeight;
      sourceCanvasRef.current.width = mediaWidth;
      sourceCanvasRef.current.height = mediaHeight;
    }

    const srcCtx = sourceCanvasRef.current.getContext('2d');
    if (!srcCtx) return;

    // 元メディアを一時キャンバスと表示キャンバスに描画
    srcCtx.drawImage(media, 0, 0, mediaWidth, mediaHeight);
    ctx.drawImage(sourceCanvasRef.current, 0, 0, mediaWidth, mediaHeight);

    // オプティカルフロー自動追従処理（再生中かつ時間が進んでいる場合）
    if (isPlaying && !isImage && Math.abs(currentTime - prevTimeRef.current) > 0.01) {
      const currImgData = srcCtx.getImageData(0, 0, mediaWidth, mediaHeight);
      const currGray = toGrayscale(currImgData);

      if (prevGrayRef.current) {
        for (const track of tracks) {
          if (track.type !== 'tracked' || !track.enabled) continue;
          if (currentTime < track.startTime || currentTime > track.endTime) continue;

          // 直前のキーフレームまたは現在位置
          const curPos = interpolateKeyframes(track.keyframes, currentTime);
          if (!curPos) continue;

          const featPoints = track.trackingData?.featurePoints || extractFeaturePoints(prevGrayRef.current, mediaWidth, mediaHeight, curPos);

          const trackRes = trackBox(
            curPos,
            featPoints,
            prevGrayRef.current,
            currGray,
            mediaWidth,
            mediaHeight
          );

          onUpdateTrackFrameOut(track.id, trackRes.isOutOfFrame);

          if (!trackRes.isOutOfFrame) {
            // 追従結果をキーフレームとして滑らかに更新
            onUpdateTrackKeyframe(track.id, {
              ...trackRes.newBox,
              points: curPos.points?.map(p => ({
                x: p.x + (trackRes.newBox.x - curPos.x),
                y: p.y + (trackRes.newBox.y - curPos.y),
              })),
            });
            track.trackingData = {
              ...track.trackingData,
              templateWidth: curPos.width,
              templateHeight: curPos.height,
              featurePoints: trackRes.newPoints,
              isOutOfFrame: false,
            };
          }
        }
      }

      prevGrayRef.current = currGray;
      prevTimeRef.current = currentTime;
    }

    // モザイクを描画（反転モザイク または 通常モザイク）
    if (isInverseMosaic) {
      const protectedRegions: ProtectedRegion[] = [];
      for (const track of tracks) {
        if (!track.enabled) continue;
        if (currentTime < track.startTime || currentTime > track.endTime) continue;
        if (track.trackingData?.isOutOfFrame) continue;

        const pos = interpolateKeyframes(track.keyframes, currentTime);
        if (pos) {
          protectedRegions.push({
            shape: track.shape,
            x: pos.x,
            y: pos.y,
            width: pos.width,
            height: pos.height,
            points: pos.points,
          });
        }
      }
      renderInverseMosaic(
        ctx,
        protectedRegions,
        mediaWidth,
        mediaHeight,
        inverseMosaicType,
        inverseStrength,
        sourceCanvasRef.current
      );
    } else {
      for (const track of tracks) {
        if (!track.enabled) continue;
        if (currentTime < track.startTime || currentTime > track.endTime) continue;
        if (track.trackingData?.isOutOfFrame) continue;

        const pos = interpolateKeyframes(track.keyframes, currentTime);
        if (pos) {
          renderTrackMosaic(ctx, track, pos, sourceCanvasRef.current);
        }
      }
    }

    // 各トラックのオーバーレイ（選択枠・ラベル・ハンドル）を描画（プレビューモード時は非表示）
    if (!isPreviewMode) {
      for (const track of tracks) {
        if (currentTime < track.startTime || currentTime > track.endTime) continue;
        if (track.trackingData?.isOutOfFrame) continue;

        const pos = interpolateKeyframes(track.keyframes, currentTime);
        if (pos) {
          const isSelected = track.id === selectedTrackId;
          const hasKey = track.keyframes.some((k) => Math.abs(k.time - currentTime) < 0.1);
          renderTrackOverlay(ctx, track, pos, isSelected, hasKey);
        }
      }
    }

    // 現在描画中のガイド（矩形、ブラシ、ポリゴン）
    if (!isPreviewMode && drawingState && drawingState.isDrawing) {
      ctx.save();
      ctx.strokeStyle = '#38bdf8';
      ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
      ctx.lineWidth = 2;

      if (editorMode === 'add_rect') {
        const w = drawingState.currentPoint.x - drawingState.startPoint.x;
        const h = drawingState.currentPoint.y - drawingState.startPoint.y;
        ctx.strokeRect(drawingState.startPoint.x, drawingState.startPoint.y, w, h);
        ctx.fillRect(drawingState.startPoint.x, drawingState.startPoint.y, w, h);
      } else if (editorMode === 'add_lasso' && drawingState.points.length > 1) {
        ctx.beginPath();
        ctx.moveTo(drawingState.points[0].x, drawingState.points[0].y);
        for (let i = 1; i < drawingState.points.length; i++) {
          ctx.lineTo(drawingState.points[i].x, drawingState.points[i].y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (editorMode === 'add_brush' && drawingState.points.length > 1) {
        ctx.beginPath();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 20;
        ctx.moveTo(drawingState.points[0].x, drawingState.points[0].y);
        for (let i = 1; i < drawingState.points.length; i++) {
          ctx.lineTo(drawingState.points[i].x, drawingState.points[i].y);
        }
        ctx.stroke();
      } else if (editorMode === 'add_polygon' && drawingState.points.length > 0) {
        ctx.beginPath();
        ctx.moveTo(drawingState.points[0].x, drawingState.points[0].y);
        for (let i = 1; i < drawingState.points.length; i++) {
          ctx.lineTo(drawingState.points[i].x, drawingState.points[i].y);
        }
        ctx.lineTo(drawingState.currentPoint.x, drawingState.currentPoint.y);
        ctx.stroke();
      }
      ctx.restore();
    }
  }, [
    isImage,
    currentTime,
    isPlaying,
    tracks,
    selectedTrackId,
    editorMode,
    drawingState,
    isPreviewMode,
    isInverseMosaic,
    inverseMosaicType,
    inverseStrength,
    onUpdateTrackFrameOut,
    onUpdateTrackKeyframe,
  ]);

  useEffect(() => {
    let animId: number;
    const loop = () => {
      renderFrame();
      animId = requestAnimationFrame(loop);
    };
    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [renderFrame]);

  // マウス/タッチ 開始イベント
  const handlePointerDown = (e: React.MouseEvent | React.TouchEvent) => {
    const pt = getCanvasCoords(e);
    if (!pt) return;

    if (editorMode === 'select') {
      // 既存トラックまたはハンドルのヒットテスト
      for (let i = tracks.length - 1; i >= 0; i--) {
        const track = tracks[i];
        if (currentTime < track.startTime || currentTime > track.endTime) continue;
        const pos = interpolateKeyframes(track.keyframes, currentTime);
        if (!pos) continue;

        // 選択中の場合の「✕ 削除」ボタン判定
        if (track.id === selectedTrackId && onDeleteTrack) {
          const badgeH = 22;
          const badgeY = Math.max(0, pos.y - badgeH - 4);
          // ラベルバッジの右側に表示される削除ボタン（幅約50px）
          if (
            pt.x >= pos.x + 60 &&
            pt.x <= pos.x + 190 &&
            pt.y >= badgeY - 6 &&
            pt.y <= badgeY + badgeH + 6
          ) {
            onDeleteTrack(track.id);
            return;
          }
        }

        // ハンドル判定（選択中の場合）
        if (track.id === selectedTrackId) {
          const handleSize = 16;
          const corners: Array<{ type: 'nw' | 'ne' | 'se' | 'sw'; cx: number; cy: number }> = [
            { type: 'nw', cx: pos.x, cy: pos.y },
            { type: 'ne', cx: pos.x + pos.width, cy: pos.y },
            { type: 'se', cx: pos.x + pos.width, cy: pos.y + pos.height },
            { type: 'sw', cx: pos.x, cy: pos.y + pos.height },
          ];
          for (const c of corners) {
            if (Math.hypot(pt.x - c.cx, pt.y - c.cy) <= handleSize) {
              setTransformState({
                type: c.type,
                trackId: track.id,
                startMouse: pt,
                initialBox: { ...pos },
              });
              return;
            }
          }
        }

        // 枠内クリック判定
        if (
          pt.x >= pos.x &&
          pt.x <= pos.x + pos.width &&
          pt.y >= pos.y &&
          pt.y <= pos.y + pos.height
        ) {
          onSelectTrack(track.id);
          setTransformState({
            type: 'move',
            trackId: track.id,
            startMouse: pt,
            initialBox: { ...pos },
          });
          return;
        }
      }

      onSelectTrack(null);
    } else if (editorMode === 'add_rect' || editorMode === 'add_brush' || editorMode === 'add_lasso') {
      setDrawingState({
        isDrawing: true,
        startPoint: pt,
        currentPoint: pt,
        points: [pt],
      });
    } else if (editorMode === 'add_polygon') {
      if (!drawingState) {
        setDrawingState({
          isDrawing: true,
          startPoint: pt,
          currentPoint: pt,
          points: [pt],
        });
      } else {
        // 始点近くならポリゴンを閉じて確定
        const first = drawingState.points[0];
        if (drawingState.points.length >= 3 && Math.hypot(pt.x - first.x, pt.y - first.y) < 20) {
          finishDrawingPolygon(drawingState.points);
        } else {
          setDrawingState({
            ...drawingState,
            currentPoint: pt,
            points: [...drawingState.points, pt],
          });
        }
      }
    }
  };

  // マウス/タッチ 移動イベント
  const handlePointerMove = (e: React.MouseEvent | React.TouchEvent) => {
    const pt = getCanvasCoords(e);
    if (!pt) return;

    if (transformState) {
      const dx = pt.x - transformState.startMouse.x;
      const dy = pt.y - transformState.startMouse.y;
      const init = transformState.initialBox;

      let newBox = { ...init };

      if (transformState.type === 'move') {
        newBox.x = init.x + dx;
        newBox.y = init.y + dy;
      } else if (transformState.type === 'se') {
        newBox.width = Math.max(10, init.width + dx);
        newBox.height = Math.max(10, init.height + dy);
      } else if (transformState.type === 'sw') {
        newBox.x = init.x + dx;
        newBox.width = Math.max(10, init.width - dx);
        newBox.height = Math.max(10, init.height + dy);
      } else if (transformState.type === 'ne') {
        newBox.y = init.y + dy;
        newBox.width = Math.max(10, init.width + dx);
        newBox.height = Math.max(10, init.height - dy);
      } else if (transformState.type === 'nw') {
        newBox.x = init.x + dx;
        newBox.y = init.y + dy;
        newBox.width = Math.max(10, init.width - dx);
        newBox.height = Math.max(10, init.height - dy);
      }

      onUpdateTrackKeyframe(transformState.trackId, newBox);
      return;
    }

    if (drawingState && drawingState.isDrawing) {
      setDrawingState({
        ...drawingState,
        currentPoint: pt,
        points: [...drawingState.points, pt],
      });
    }
  };

  // マウス/タッチ 終了イベント
  const handlePointerUp = () => {
    if (transformState) {
      setTransformState(null);
      return;
    }

    if (!drawingState || !drawingState.isDrawing) return;

    if (editorMode === 'add_rect') {
      const minX = Math.min(drawingState.startPoint.x, drawingState.currentPoint.x);
      const minY = Math.min(drawingState.startPoint.y, drawingState.currentPoint.y);
      const width = Math.abs(drawingState.currentPoint.x - drawingState.startPoint.x);
      const height = Math.abs(drawingState.currentPoint.y - drawingState.startPoint.y);

      if (width > 8 && height > 8) {
        const newTrack: MosaicTrack = {
          id: `track-${Date.now()}`,
          name: `矩形追従 #${tracks.length + 1}`,
          type: 'tracked',
          shape: 'rect',
          enabled: true,
          mosaicType: 'pixel',
          strength: 14,
          startTime: currentTime,
          endTime: currentTime + 5,
          keyframes: [
            {
              time: currentTime,
              x: minX,
              y: minY,
              width,
              height,
            },
          ],
        };
        onAddTrack(newTrack);
        onSelectTrack(newTrack.id);
      }
      setDrawingState(null);
    } else if (editorMode === 'add_lasso') {
      if (drawingState.points.length > 2) {
        const xs = drawingState.points.map((p) => p.x);
        const ys = drawingState.points.map((p) => p.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);

        const newTrack: MosaicTrack = {
          id: `track-${Date.now()}`,
          name: `フリー囲み #${tracks.length + 1}`,
          type: 'tracked',
          shape: 'lasso',
          enabled: true,
          mosaicType: 'pixel',
          strength: 14,
          startTime: currentTime,
          endTime: currentTime + 5,
          keyframes: [
            {
              time: currentTime,
              x: minX,
              y: minY,
              width: maxX - minX,
              height: maxY - minY,
              points: drawingState.points,
            },
          ],
        };
        onAddTrack(newTrack);
        onSelectTrack(newTrack.id);
      }
      setDrawingState(null);
    } else if (editorMode === 'add_brush') {
      if (drawingState.points.length > 2) {
        const xs = drawingState.points.map((p) => p.x);
        const ys = drawingState.points.map((p) => p.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);

        const newTrack: MosaicTrack = {
          id: `track-${Date.now()}`,
          name: `ブラシ #${tracks.length + 1}`,
          type: 'tracked',
          shape: 'brush',
          enabled: true,
          mosaicType: 'pixel',
          strength: 14,
          startTime: currentTime,
          endTime: currentTime + 5,
          keyframes: [
            {
              time: currentTime,
              x: minX,
              y: minY,
              width: maxX - minX,
              height: maxY - minY,
              points: drawingState.points,
            },
          ],
        };
        onAddTrack(newTrack);
        onSelectTrack(newTrack.id);
      }
      setDrawingState(null);
    }
  };

  const finishDrawingPolygon = (points: Point[]) => {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const newTrack: MosaicTrack = {
      id: `track-${Date.now()}`,
      name: `ポリゴン #${tracks.length + 1}`,
      type: 'tracked',
      shape: 'polygon',
      enabled: true,
      mosaicType: 'pixel',
      strength: 14,
      startTime: currentTime,
      endTime: currentTime + 5,
      keyframes: [
        {
          time: currentTime,
          x: minX,
          y: minY,
          width: maxX - minX,
          height: maxY - minY,
          points,
        },
      ],
    };
    onAddTrack(newTrack);
    onSelectTrack(newTrack.id);
    setDrawingState(null);
  };

  return (
    <div
      ref={containerRef}
      className="relative flex-1 bg-slate-950 flex flex-col items-center justify-center p-2 sm:p-4 select-none min-h-[300px] sm:min-h-[420px] w-full"
    >
      <canvas
        ref={canvasRef}
        onMouseDown={handlePointerDown}
        onMouseMove={handlePointerMove}
        onMouseUp={handlePointerUp}
        onTouchStart={handlePointerDown}
        onTouchMove={handlePointerMove}
        onTouchEnd={handlePointerUp}
        className="max-w-full max-h-[55vh] sm:max-h-[70vh] object-contain shadow-2xl rounded border border-slate-800 touch-none cursor-crosshair"
      />
    </div>
  );
};

