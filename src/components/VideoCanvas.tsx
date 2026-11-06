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
  onUpdateTrackKeyframe: (
    trackId: string,
    box: { x: number; y: number; width: number; height: number; points?: Point[] },
    isPlaybackTracking?: boolean
  ) => void;
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

  // ドラッグ変形・位置移動の高速リアルタイムRef（毎フレーム遅延なく描画に反映）
  const transformRef = useRef<{
    type: 'move' | 'nw' | 'ne' | 'se' | 'sw';
    trackId: string;
    startMouse: Point;
    currentMouse: Point;
    initialBox: { x: number; y: number; width: number; height: number; points?: Point[] };
  } | null>(null);

  // マウスカーソル状態
  const [cursorStyle, setCursorStyle] = useState<string>('cursor-crosshair');

  // キャンバス座標系への変換（マウス・タッチ・ポインター完全対応）
  const getCanvasCoords = (e: React.PointerEvent | React.MouseEvent | React.TouchEvent): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    let clientX = 0;
    let clientY = 0;

    if ('touches' in e && e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else if ('clientX' in e) {
      clientX = e.clientX;
      clientY = e.clientY;
    }

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
            // 追従結果をキーフレームとして滑らかに更新（再生中フラグ true）
            onUpdateTrackKeyframe(
              track.id,
              {
                ...trackRes.newBox,
                points: curPos.points?.map((p) => ({
                  x: p.x + (trackRes.newBox.x - curPos.x),
                  y: p.y + (trackRes.newBox.y - curPos.y),
                })),
              },
              true
            );
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

    // 現在の表示位置を計算（ドラッグ変形・移動中はリアルタイムに反映）
    const getEffectivePos = (track: MosaicTrack) => {
      const pos = interpolateKeyframes(track.keyframes, currentTime);
      if (!pos) return null;

      if (transformRef.current && transformRef.current.trackId === track.id) {
        const { type, startMouse, currentMouse, initialBox } = transformRef.current;
        const dx = currentMouse.x - startMouse.x;
        const dy = currentMouse.y - startMouse.y;
        let newBox = { ...initialBox };

        if (type === 'move') {
          newBox.x = initialBox.x + dx;
          newBox.y = initialBox.y + dy;
          if (initialBox.points) {
            newBox.points = initialBox.points.map((p) => ({
              x: p.x + dx,
              y: p.y + dy,
            }));
          }
        } else {
          if (type === 'se') {
            newBox.width = Math.max(15, initialBox.width + dx);
            newBox.height = Math.max(15, initialBox.height + dy);
          } else if (type === 'sw') {
            newBox.x = initialBox.x + dx;
            newBox.width = Math.max(15, initialBox.width - dx);
            newBox.height = Math.max(15, initialBox.height + dy);
          } else if (type === 'ne') {
            newBox.y = initialBox.y + dy;
            newBox.width = Math.max(15, initialBox.width + dx);
            newBox.height = Math.max(15, initialBox.height - dy);
          } else if (type === 'nw') {
            newBox.x = initialBox.x + dx;
            newBox.y = initialBox.y + dy;
            newBox.width = Math.max(15, initialBox.width - dx);
            newBox.height = Math.max(15, initialBox.height - dy);
          }

          if (initialBox.points && initialBox.width > 0 && initialBox.height > 0) {
            const scaleX = newBox.width / initialBox.width;
            const scaleY = newBox.height / initialBox.height;
            newBox.points = initialBox.points.map((p) => ({
              x: newBox.x + (p.x - initialBox.x) * scaleX,
              y: newBox.y + (p.y - initialBox.y) * scaleY,
            }));
          }
        }
        return newBox;
      }

      return pos;
    };

    // モザイクを描画（反転モザイク または 通常モザイク）
    if (isInverseMosaic) {
      const protectedRegions: ProtectedRegion[] = [];
      for (const track of tracks) {
        if (!track.enabled) continue;
        if (currentTime < track.startTime || currentTime > track.endTime) continue;

        const pos = getEffectivePos(track);
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

        const pos = getEffectivePos(track);
        if (pos) {
          renderTrackMosaic(ctx, track, pos, sourceCanvasRef.current);
        }
      }
    }

    // 各トラックのオーバーレイ（選択枠・ラベル・ハンドル）を描画（プレビューモード時は非表示）
    if (!isPreviewMode) {
      for (const track of tracks) {
        if (currentTime < track.startTime || currentTime > track.endTime) continue;

        const pos = getEffectivePos(track);
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

  // ポインター押下イベント（マウス・タッチ共通、Pointer Capture でキャンバス外も完全に追従）
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pt = getCanvasCoords(e);
    if (!pt) return;

    // 画面上の表示サイズとキャンバス内部解像度の比率（スマホでの4K/1080p動画でもタッチ判定を実寸px基準にする）
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    const uiScale = canvas && rect && rect.width > 0 ? Math.max(1, canvas.width / rect.width) : 1;
    const touchPad = 14 * uiScale;

    // 1. 選択中のトラックがある場合、そのハンドル・枠内移動を最優先判定（モード問わず）
    // ※キャンバス上の誤タップによる枠消失を防ぐため、キャンバス内での直接削除判定は行わず、移動・リサイズのみに特化
    if (selectedTrackId) {
      const selectedTrack = tracks.find((t) => t.id === selectedTrackId);
      if (selectedTrack && currentTime >= selectedTrack.startTime && currentTime <= selectedTrack.endTime) {
        const pos = interpolateKeyframes(selectedTrack.keyframes, currentTime);
        if (pos) {
          // 枠の中央付近（内側の移動優先エリア）または上部ラベルバッジを触った場合は、小さい枠でも確実に「移動」を優先
          const centerX = pos.x + pos.width / 2;
          const centerY = pos.y + pos.height / 2;
          const inInnerCenter =
            Math.abs(pt.x - centerX) <= Math.max(10 * uiScale, pos.width * 0.28) &&
            Math.abs(pt.y - centerY) <= Math.max(10 * uiScale, pos.height * 0.28);

          const badgeH = 26 * uiScale;
          const inBadge =
            pt.x >= pos.x - touchPad &&
            pt.x <= pos.x + Math.max(pos.width, 140 * uiScale) + touchPad &&
            pt.y >= Math.max(0, pos.y - badgeH - 6 * uiScale) &&
            pt.y <= pos.y;

          if (!inInnerCenter && !inBadge) {
            // 四隅の変形ハンドル判定
            const handleSize = Math.min(20 * uiScale, Math.max(14, Math.min(pos.width, pos.height) * 0.38));
            const corners: Array<{ type: 'nw' | 'ne' | 'se' | 'sw'; cx: number; cy: number }> = [
              { type: 'nw', cx: pos.x, cy: pos.y },
              { type: 'ne', cx: pos.x + pos.width, cy: pos.y },
              { type: 'se', cx: pos.x + pos.width, cy: pos.y + pos.height },
              { type: 'sw', cx: pos.x, cy: pos.y + pos.height },
            ];
            for (const c of corners) {
              if (Math.hypot(pt.x - c.cx, pt.y - c.cy) <= handleSize) {
                try {
                  (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
                } catch (_) {}
                e.preventDefault();

                transformRef.current = {
                  type: c.type,
                  trackId: selectedTrack.id,
                  startMouse: pt,
                  currentMouse: pt,
                  initialBox: { ...pos, points: pos.points ? [...pos.points] : undefined },
                };
                return;
              }
            }
          }

          // 枠内（またはバッジエリア）クリック判定 -> 即座にドラッグ移動開始！
          const inBox =
            pt.x >= pos.x - touchPad &&
            pt.x <= pos.x + pos.width + touchPad &&
            pt.y >= pos.y - touchPad &&
            pt.y <= pos.y + pos.height + touchPad;

          if (inBadge || inBox || inInnerCenter) {
            try {
              (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
            } catch (_) {}
            e.preventDefault();

            transformRef.current = {
              type: 'move',
              trackId: selectedTrack.id,
              startMouse: pt,
              currentMouse: pt,
              initialBox: { ...pos, points: pos.points ? [...pos.points] : undefined },
            };
            return;
          }
        }
      }
    }

    // 2. 他の既存トラックをクリックしたか判定（枠の上を触ればいつでもその枠を選択して移動開始）
    for (let i = tracks.length - 1; i >= 0; i--) {
      const track = tracks[i];
      if (currentTime < track.startTime || currentTime > track.endTime) continue;
      const pos = interpolateKeyframes(track.keyframes, currentTime);
      if (!pos) continue;

      if (
        pt.x >= pos.x - touchPad &&
        pt.x <= pos.x + pos.width + touchPad &&
        pt.y >= pos.y - touchPad &&
        pt.y <= pos.y + pos.height + touchPad
      ) {
        onSelectTrack(track.id);
        try {
          (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
        } catch (_) {}
        e.preventDefault();

        transformRef.current = {
          type: 'move',
          trackId: track.id,
          startMouse: pt,
          currentMouse: pt,
          initialBox: { ...pos, points: pos.points ? [...pos.points] : undefined },
        };
        return;
      }
    }

    // 3. 枠外をクリックした場合の処理
    // ※スマホ等で枠をドラッグしようとして数ミリ外れた際に選択枠（水色の枠・四隅ハンドル）が消えてしまわないよう、
    //   select モード時は枠外タップでも現在の選択を維持する（枠を非表示にしたい場合は「枠非表示」ボタンを使用）
    if (editorMode === 'select') {
      return;
    } else if (editorMode === 'add_rect' || editorMode === 'add_brush' || editorMode === 'add_lasso') {
      try {
        (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      } catch (_) {}
      e.preventDefault();

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

  // ポインター移動イベント
  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pt = getCanvasCoords(e);
    if (!pt) return;

    // ドラッグ変形・位置移動中（Refの更新により60fpsで即座にリアルタイム追従）
    if (transformRef.current) {
      e.preventDefault();
      transformRef.current.currentMouse = pt;
      return;
    }

    // ホバー時のカーソルスタイル更新（マウス操作時）
    if (e.pointerType === 'mouse') {
      if (selectedTrackId) {
        const selectedTrack = tracks.find((t) => t.id === selectedTrackId);
        if (selectedTrack) {
          const pos = interpolateKeyframes(selectedTrack.keyframes, currentTime);
          if (pos) {
            const handleSize = 16;
            const corners = [
              { type: 'nw', cx: pos.x, cy: pos.y },
              { type: 'ne', cx: pos.x + pos.width, cy: pos.y },
              { type: 'se', cx: pos.x + pos.width, cy: pos.y + pos.height },
              { type: 'sw', cx: pos.x, cy: pos.y + pos.height },
            ];
            const hitCorner = corners.find((c) => Math.hypot(pt.x - c.cx, pt.y - c.cy) <= handleSize);
            if (hitCorner) {
              if (hitCorner.type === 'nw' || hitCorner.type === 'se') {
                setCursorStyle('cursor-nwse-resize');
              } else {
                setCursorStyle('cursor-nesw-resize');
              }
              return;
            }

            if (pt.x >= pos.x && pt.x <= pos.x + pos.width && pt.y >= pos.y && pt.y <= pos.y + pos.height) {
              setCursorStyle('cursor-move');
              return;
            }
          }
        }
      }

      setCursorStyle(editorMode === 'select' ? 'cursor-default' : 'cursor-crosshair');
    }

    // 新規囲みの描画中
    if (drawingState && drawingState.isDrawing) {
      e.preventDefault();
      setDrawingState({
        ...drawingState,
        currentPoint: pt,
        points: [...drawingState.points, pt],
      });
    }
  };

  // ポインター解放イベント（ドラッグ終了時にキーフレームを確定保存）
  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
    } catch (_) {}

    if (transformRef.current) {
      const { type, startMouse, currentMouse, initialBox, trackId } = transformRef.current;
      const dx = currentMouse.x - startMouse.x;
      const dy = currentMouse.y - startMouse.y;

      // 単なるタップ（移動量1px未満）の場合はキーフレームを更新せず選択状態を維持
      if (Math.hypot(dx, dy) < 1) {
        transformRef.current = null;
        return;
      }

      let newBox = { ...initialBox };

      if (type === 'move') {
        newBox.x = initialBox.x + dx;
        newBox.y = initialBox.y + dy;
        if (initialBox.points) {
          newBox.points = initialBox.points.map((p) => ({
            x: p.x + dx,
            y: p.y + dy,
          }));
        }
      } else {
        if (type === 'se') {
          newBox.width = Math.max(15, initialBox.width + dx);
          newBox.height = Math.max(15, initialBox.height + dy);
        } else if (type === 'sw') {
          newBox.x = initialBox.x + dx;
          newBox.width = Math.max(15, initialBox.width - dx);
          newBox.height = Math.max(15, initialBox.height + dy);
        } else if (type === 'ne') {
          newBox.y = initialBox.y + dy;
          newBox.width = Math.max(15, initialBox.width + dx);
          newBox.height = Math.max(15, initialBox.height - dy);
        } else if (type === 'nw') {
          newBox.x = initialBox.x + dx;
          newBox.y = initialBox.y + dy;
          newBox.width = Math.max(15, initialBox.width - dx);
          newBox.height = Math.max(15, initialBox.height - dy);
        }

        if (initialBox.points && initialBox.width > 0 && initialBox.height > 0) {
          const scaleX = newBox.width / initialBox.width;
          const scaleY = newBox.height / initialBox.height;
          newBox.points = initialBox.points.map((p) => ({
            x: newBox.x + (p.x - initialBox.x) * scaleX,
            y: newBox.y + (p.y - initialBox.y) * scaleY,
          }));
        }
      }

      onUpdateTrackKeyframe(trackId, newBox);
      transformRef.current = null;
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
        const width = Math.max(24, maxX - minX);
        const height = Math.max(24, maxY - minY);

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
              width,
              height,
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
        const pad = 14;
        const minX = Math.max(0, Math.min(...xs) - pad);
        const maxX = Math.max(...xs) + pad;
        const minY = Math.max(0, Math.min(...ys) - pad);
        const maxY = Math.max(...ys) + pad;

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
              width: Math.max(28, maxX - minX),
              height: Math.max(28, maxY - minY),
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
          width: Math.max(24, maxX - minX),
          height: Math.max(24, maxY - minY),
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
      className="relative flex-1 bg-slate-950 flex flex-col items-center justify-center p-2 sm:p-4 select-none min-h-[300px] sm:min-h-[420px] w-full relative"
    >
      {/* 選択中の操作ガイドヒント */}
      {selectedTrackId && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-slate-900/90 border border-cyan-500/60 shadow-xl px-3 py-1 rounded-full flex items-center gap-2 text-[11px] font-bold text-cyan-300 pointer-events-none backdrop-blur z-10 animate-fade-in">
          <span>✥ 枠の内側をドラッグして移動</span>
          <span className="text-slate-500">•</span>
          <span className="text-slate-300 font-normal">四隅の白■でサイズ変更</span>
        </div>
      )}

      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className={`max-w-full max-h-[55vh] sm:max-h-[70vh] object-contain shadow-2xl rounded border border-slate-800 touch-none select-none ${cursorStyle}`}
      />
    </div>
  );
};

