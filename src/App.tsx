import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Header } from './components/Header';
import { Toolbar } from './components/Toolbar';
import { VideoCanvas } from './components/VideoCanvas';
import { Timeline } from './components/Timeline';
import { PersonListPanel } from './components/PersonListPanel';
import { ExportModal } from './components/ExportModal';
import { EditorMode, MosaicTrack, MosaicType, Point, Keyframe, NormalizedPoint } from './types';
import { Film, ListFilter, Clock, Play, Pause, RotateCcw, Trash2, Crosshair, Sparkles, AlertTriangle, X } from 'lucide-react';
import { initFaceDetector, initPersonSegmenter, detectFacesSafely, segmentPersonSafely, resampleClosedPolygon, BODY_CONTOUR_POINTS, updatePersonTracks, expandBoxWithMargin, estimateBodyBoxFromFace, createBodySilhouettePolygon, isValidFaceDetection, FaceFilterOptions, GatekeeperContext, resetAnalysisState } from './utils/aiDetector';
import { exportMosaicVideo, ExportProgress, saveOrShareBlob } from './utils/videoExporter';
import { generateDemoVideoBlob } from './utils/sampleGenerator';
import { renderTrackMosaic, renderInverseMosaic, ProtectedRegion } from './utils/mosaicRenderer';
import { extractFeaturePoints, toGrayscale, trackBox, interpolateKeyframes } from './utils/tracking';
import { requestScreenWakeLock, releaseScreenWakeLock, seekVideoSafely } from './utils/wakeLock';
import { getClampedDimensions, absoluteToNormalizedPoints, NORMALIZED_POINT_COUNT, createDefaultNormalizedPoints, normalizedToAbsolutePoints, isBoxTouchingBorder } from './utils/geometry';

export const App: React.FC = () => {
  // メディア状態
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [isImage, setIsImage] = useState<boolean>(false);
  const [duration, setDuration] = useState<number>(0);
  const [durationWarning, setDurationWarning] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  // トラック・編集状態
  const [tracks, setTracks] = useState<MosaicTrack[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>('select');
  const [isPreviewMode, setIsPreviewMode] = useState<boolean>(false);
  const [mobileTab, setMobileTab] = useState<'canvas' | 'list' | 'timeline'>('canvas');

  // 反転モザイク（選択した人物やPC画面以外の『背景全体』にモザイクをかける機能）
  const [isInverseMosaic, setIsInverseMosaic] = useState<boolean>(false);
  const [inverseMosaicType, setInverseMosaicType] = useState<MosaicType>('blur');
  const [inverseStrength, setInverseStrength] = useState<number>(18);

  // AIおよびエクスポート進行状態
  const [isAIDetecting, setIsAIDetecting] = useState<boolean>(false);
  const [aiDetectProgress, setAiDetectProgress] = useState<number>(0);
  const [aiSensitivity, setAiSensitivity] = useState<'strict' | 'standard' | 'high'>('strict');
  const [aiTarget, setAiTarget] = useState<'face' | 'body'>('body');
  const [isTrackingProcessing, setIsTrackingProcessing] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportedBlob, setExportedBlob] = useState<Blob | null>(null);
  const [isExportModalOpen, setIsExportModalOpen] = useState<boolean>(false);

  // 要素参照
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  // ファイルオープンハンドラ
  const handleOpenFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (mediaUrl) URL.revokeObjectURL(mediaUrl);

    const url = URL.createObjectURL(file);
    const isImg = file.type.startsWith('image/');

    setMediaFile(file);
    setMediaUrl(url);
    setIsImage(isImg);
    setTracks([]);
    setSelectedTrackId(null);
    setCurrentTime(0);
    setIsPlaying(false);
    setDurationWarning(false);

    if (isImg) {
      setDuration(1);
    }
  };

  // デモ動画の即座生成
  const handleLoadDemo = async () => {
    try {
      const demoFile = await generateDemoVideoBlob();
      if (mediaUrl) URL.revokeObjectURL(mediaUrl);
      const url = URL.createObjectURL(demoFile);

      setMediaFile(demoFile);
      setMediaUrl(url);
      setIsImage(false);
      setTracks([]);
      setSelectedTrackId(null);
      setCurrentTime(0);
      setIsPlaying(false);
      setDurationWarning(false);
    } catch (e) {
      console.error('Demo video generation failed:', e);
      alert('デモ動画の生成に失敗しました');
    }
  };

  // 再生制御
  const togglePlay = () => {
    if (!videoRef.current || isImage) return;
    if (isPlaying) {
      videoRef.current.pause();
      setIsPlaying(false);
    } else {
      videoRef.current.play().catch(console.error);
      setIsPlaying(true);
    }
  };

  const handleSeek = (time: number) => {
    if (!videoRef.current || isImage) return;
    const clamped = Math.max(0, Math.min(duration, time));
    videoRef.current.currentTime = clamped;
    setCurrentTime(clamped);
  };

  // ビデオのメタデータ読み込み
  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      const videoDur = videoRef.current.duration || 1;
      setDuration(videoDur);

      // 5分（300秒）を超える長尺動画に対する安全装置（OOMクラッシュ防止警告）
      if (videoDur > 300) {
        setDurationWarning(true);
        alert(
          'ブラウザのメモリ制限のため、5分以上の動画は処理中に強制終了する可能性があります。短い動画にカットしてご利用ください'
        );
      } else {
        setDurationWarning(false);
      }

      // スマホブラウザで初期フレームが未デコード(readyState < 2)のままになるのを防ぐため微小シークで先頭フレームをデコード
      if (videoRef.current.readyState < 2 && videoRef.current.currentTime === 0) {
        try {
          videoRef.current.currentTime = 0.001;
        } catch (_) {}
      }
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  const handleEnded = () => {
    setIsPlaying(false);
  };

  // トラック追加
  const handleAddTrack = (newTrack: MosaicTrack) => {
    setTracks((prev) => [...prev, newTrack]);
    setSelectedTrackId(newTrack.id);
    // ※囲んだ直後にユーザーが枠をタップ＆ドラッグして微調整できるよう、
    //   シークを伴う重い自動解析(runTrackingForTrack)はここでは自動発火させず、
    //   再生中のリアルタイム追従または「自動追従を解析」ボタン押下時に実行する。
  };

  // トラック削除
  const handleDeleteTrack = (id: string) => {
    setTracks((prev) => prev.filter((t) => t.id !== id));
    if (selectedTrackId === id) setSelectedTrackId(null);
  };

  // ユーザー指定領域（フリー囲み等）を一括全削除
  const handleDeleteAllUserTracks = () => {
    setTracks((prev) => prev.filter((t) => t.type === 'ai'));
    setSelectedTrackId(null);
  };

  // キーボードショートカット（Delete / Backspace で選択枠を即削除）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedTrackId) {
        if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;
        e.preventDefault();
        handleDeleteTrack(selectedTrackId);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedTrackId]);

  // トラック設定更新
  const handleUpdateTrackSettings = (updates: Partial<MosaicTrack>) => {
    if (!selectedTrackId) return;
    setTracks((prev) =>
      prev.map((t) => (t.id === selectedTrackId ? { ...t, ...updates } : t))
    );
  };

  const handleUpdateTrackTime = (id: string, startTime: number, endTime: number) => {
    setTracks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, startTime, endTime } : t))
    );
  };

  const handleToggleTrackEnabled = (id: string) => {
    setTracks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t))
    );
  };

  const handleToggleAllAITracks = (enable: boolean) => {
    setTracks((prev) =>
      prev.map((t) => (t.type === 'ai' ? { ...t, enabled: enable } : t))
    );
  };

  // 現在位置をIn点・Out点に設定
  const handleSetInPoint = () => {
    if (!selectedTrackId) return;
    setTracks((prev) =>
      prev.map((t) =>
        t.id === selectedTrackId
          ? { ...t, startTime: Math.min(currentTime, t.endTime - 0.1) }
          : t
      )
    );
  };

  const handleSetOutPoint = () => {
    if (!selectedTrackId) return;
    setTracks((prev) =>
      prev.map((t) =>
        t.id === selectedTrackId
          ? { ...t, endTime: Math.max(currentTime, t.startTime + 0.1) }
          : t
      )
    );
  };

  // キーフレーム追加・位置補正
  const handleAddKeyframeAtCurrentTime = () => {
    if (!selectedTrackId) return;
    const track = tracks.find((t) => t.id === selectedTrackId);
    if (!track) return;

    const pos = interpolateKeyframes(track.keyframes, currentTime) || track.keyframes[0];
    if (!pos) return;

    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== selectedTrackId) return t;
        const filtered = t.keyframes.filter((k) => Math.abs(k.time - currentTime) > 0.05);
        return {
          ...t,
          keyframes: [
            ...filtered,
            {
              time: currentTime,
              x: pos.x,
              y: pos.y,
              width: pos.width,
              height: pos.height,
              points: pos.points,
            },
          ].sort((a, b) => a.time - b.time),
        };
      })
    );
  };

  const handleUpdateTrackKeyframe = (
    trackId: string,
    box: { x: number; y: number; width: number; height: number; points?: Point[]; normalizedPoints?: NormalizedPoint[] },
    isPlaybackTracking: boolean = false
  ) => {
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== trackId) return t;

        const norm = box.normalizedPoints || (box.points && box.points.length >= 3 ? absoluteToNormalizedPoints(box, box.points, NORMALIZED_POINT_COUNT) : undefined);
        const points = norm ? normalizedToAbsolutePoints(box, norm) : box.points;

        // 1. キーフレームが1個以下のトラック（手動囲み直後や静止画）は、そのキーフレームを直接更新
        if (t.keyframes.length <= 1) {
          const orig = t.keyframes[0];
          return {
            ...t,
            trackingData: t.trackingData
              ? { ...t.trackingData, isOutOfFrame: false, featurePoints: undefined }
              : undefined,
            keyframes: [
              {
                time: orig ? orig.time : currentTime,
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
                points,
                normalizedPoints: norm,
              },
            ],
          };
        }

        // 2. 再生中の自動追従による更新の場合（現在時刻の近傍キーフレームを更新）
        if (isPlaybackTracking) {
          const filtered = t.keyframes.filter((k) => Math.abs(k.time - currentTime) >= 0.05);
          return {
            ...t,
            keyframes: [
              ...filtered,
              {
                time: currentTime,
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
                points,
                normalizedPoints: norm,
              },
            ].sort((a, b) => a.time - b.time),
          };
        }

        // 3. ユーザーが手動で外枠操作・32頂点ドラッグ変形した場合：
        // 現在時刻 currentTime に「キーフレーム」として記録する。
        // 近傍（0.08秒以内）の既存キーフレームがあれば更新し、なければ新規追加。
        // 2つのキーフレーム間（例: 10F目と40F目）は interpolateKeyframes の Lerp で自動変形し、
        // 後続にキーフレームがない場合は直前のキーフレームの状態を維持（ホールド）します。
        const filtered = t.keyframes.filter((k) => Math.abs(k.time - currentTime) >= 0.08);
        const newKeyframes = [
          ...filtered,
          {
            time: currentTime,
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            points,
            normalizedPoints: norm,
          },
        ].sort((a, b) => a.time - b.time);

        return {
          ...t,
          trackingData: t.trackingData
            ? { ...t.trackingData, isOutOfFrame: false, featurePoints: undefined }
            : undefined,
          keyframes: newKeyframes,
        };
      })
    );
  };

  // 矩形枠(rect)を固定32頂点の正規化ポリゴン枠に変換し、身体のラインに沿うよう手動で頂点編集できるようにする
  const handleConvertTrackToPolygon = (trackId: string) => {
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== trackId) return t;
        const convertedKeyframes = t.keyframes.map((k) => {
          const box = { x: k.x, y: k.y, width: k.width, height: k.height };
          let normPoints = k.normalizedPoints;
          let points = k.points;

          if (!normPoints || normPoints.length !== NORMALIZED_POINT_COUNT) {
            if (points && points.length >= 3) {
              normPoints = absoluteToNormalizedPoints(box, points, NORMALIZED_POINT_COUNT);
            } else {
              normPoints = createDefaultNormalizedPoints(NORMALIZED_POINT_COUNT);
            }
          }
          points = normalizedToAbsolutePoints(box, normPoints);

          return {
            ...k,
            points,
            normalizedPoints: normPoints,
          };
        });
        return {
          ...t,
          shape: 'polygon',
          keyframes: convertedKeyframes,
        };
      })
    );
  };

  const handleUpdateTrackFrameOut = (trackId: string, isOutOfFrame: boolean) => {
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== trackId) return t;
        return {
          ...t,
          trackingData: {
            ...t.trackingData,
            templateWidth: t.trackingData?.templateWidth || 50,
            templateHeight: t.trackingData?.templateHeight || 50,
            isOutOfFrame,
          },
        };
      })
    );
  };

  // 高精度・自動追従区間解析（大域探索SAD + Lucas-Kanade + Median Flow）
  const runTrackingForTrack = async (targetTrackId: string, currentTrackData?: MosaicTrack) => {
    if (!videoRef.current || isImage) return;
    const track = currentTrackData || tracks.find((t) => t.id === targetTrackId);
    if (!track || track.keyframes.length === 0) return;

    setIsTrackingProcessing(true);
    await requestScreenWakeLock();

    const video = videoRef.current;
    const origTime = video.currentTime;
    const rawW = video.videoWidth || 640;
    const rawH = video.videoHeight || 480;
    const { width, height } = getClampedDimensions(rawW, rawH, 1280);

    const offCanvas = document.createElement('canvas');
    offCanvas.width = width;
    offCanvas.height = height;
    const offCtx = offCanvas.getContext('2d', { willReadFrequently: true })!;

    try {
      const startT = track.startTime;
      const endT = track.endTime;
      const step = 0.08; // 12.5fpsの高密度サンプリング

      // 開始フレームに安全にシーク
      await seekVideoSafely(video, startT);

      offCtx.drawImage(video, 0, 0, width, height);
      let prevGray = toGrayscale(offCtx.getImageData(0, 0, width, height));

      const initialPos = interpolateKeyframes(track.keyframes, startT) || track.keyframes[0];
      let curBox = { x: initialPos.x, y: initialPos.y, width: initialPos.width, height: initialPos.height };
      let featPoints = extractFeaturePoints(prevGray, width, height, curBox, 36);

      const initialNorm = initialPos.normalizedPoints || (initialPos.points ? absoluteToNormalizedPoints(curBox, initialPos.points, NORMALIZED_POINT_COUNT) : undefined);

      const generatedKeyframes: Keyframe[] = [
        {
          time: startT,
          x: curBox.x,
          y: curBox.y,
          width: curBox.width,
          height: curBox.height,
          points: initialPos.points,
          normalizedPoints: initialNorm,
        },
      ];

      const totalSteps = Math.floor((endT - startT) / step);
      for (let s = 1; s <= totalSteps; s++) {
        const curT = Math.min(endT, startT + s * step);
        await seekVideoSafely(video, curT);

        offCtx.drawImage(video, 0, 0, width, height);
        const currGray = toGrayscale(offCtx.getImageData(0, 0, width, height));

        const res = trackBox(curBox, featPoints, prevGray, currGray, width, height);
        if (res.isOutOfFrame) {
          break;
        }

        curBox = res.newBox;
        featPoints = res.newPoints;
        prevGray = currGray;

        generatedKeyframes.push({
          time: curT,
          x: curBox.x,
          y: curBox.y,
          width: curBox.width,
          height: curBox.height,
          points: initialPos.points?.map((p) => ({
            x: p.x + (curBox.x - initialPos.x),
            y: p.y + (curBox.y - initialPos.y),
          })),
          normalizedPoints: initialNorm,
        });
      }

      setTracks((prev) =>
        prev.map((t) =>
          t.id === targetTrackId
            ? {
                ...t,
                keyframes: generatedKeyframes,
                trackingData: t.trackingData ? { ...t.trackingData, isOutOfFrame: false } : undefined,
              }
            : t
        )
      );
    } catch (err) {
      console.error('Auto tracking failed', err);
    } finally {
      await seekVideoSafely(video, origTime);
      await releaseScreenWakeLock();
      setIsTrackingProcessing(false);
    }
  };

  // MediaPipe による高密度・AI人物自動検出＆追跡（セグメンテーションによる体ライン輪郭＋顔検出併用）
  const handleRunAIFaceDetection = async (overrideTarget?: 'face' | 'body', autoEnableInverse?: boolean) => {
    if (!videoRef.current && !imageRef.current) return;
    const targetMode = overrideTarget || aiTarget;
    setIsAIDetecting(true);
    setAiDetectProgress(0);
    await requestScreenWakeLock();

    try {
      if (targetMode === 'body') {
        // 【体のラインに沿った人物輪郭セグメンテーション】
        // 顔が映っていない、後ろ向き、横向きでも全身・上半身の境界をダイレクトに抽出
        let segmenter = await initPersonSegmenter();

        if (isImage && imageRef.current) {
          const img = imageRef.current;
          const rawW = img.naturalWidth || 640;
          const rawH = img.naturalHeight || 480;
          const { width: workW, height: workH } = getClampedDimensions(rawW, rawH, 1280);
          const scaleX = workW / rawW;
          const scaleY = workH / rawH;

          const gateContext: GatekeeperContext = {
            existingTracks: tracks.map((t) => ({
              id: t.id,
              box: t.keyframes[0] || { x: 0, y: 0, width: 0, height: 0 },
              hasManualKeyframe: t.keyframes.length > 1,
            })),
            origWidth: workW,
            origHeight: workH,
          };

          const res = await segmentPersonSafely(img, segmenter, gateContext);
          segmenter = res.activeSegmenter;

          if (res.contour && res.contour.points.length >= 3) {
            const scaledBox = {
              x: Math.round(res.contour.bounds.x * scaleX),
              y: Math.round(res.contour.bounds.y * scaleY),
              width: Math.round(res.contour.bounds.width * scaleX),
              height: Math.round(res.contour.bounds.height * scaleY),
            };
            const scaledPoints = res.contour.points.map((p) => ({
              x: p.x * scaleX,
              y: p.y * scaleY,
            }));
            const normPoints = res.contour.normalizedPoints || absoluteToNormalizedPoints(scaledBox, scaledPoints, NORMALIZED_POINT_COUNT);

            const newTrack: MosaicTrack = {
              id: `ai-body-${Date.now()}`,
              name: 'AI人物 (輪郭)',
              type: 'ai',
              shape: 'polygon',
              enabled: true,
              mosaicType: 'pixel',
              strength: 14,
              startTime: 0,
              endTime: 1,
              keyframes: [
                {
                  time: 0,
                  ...scaledBox,
                  points: scaledPoints,
                  normalizedPoints: normPoints,
                },
              ],
              aiTarget: 'body',
            };
            setTracks((prev) => [...prev, newTrack]);
            setSelectedTrackId(newTrack.id);
            if (autoEnableInverse) {
              setIsInverseMosaic(true);
            }
          } else {
            // セグメンテーションで見つからなかった場合は顔検出にフォールバック
            await runFaceDetectionFallback(targetMode, autoEnableInverse);
          }
          setAiDetectProgress(100);
        } else if (videoRef.current) {
          const video = videoRef.current;
          const origTime = video.currentTime;
          const totalDuration = video.duration || 5;
          const rawW = video.videoWidth || 640;
          const rawH = video.videoHeight || 480;
          const { width: workW, height: workH } = getClampedDimensions(rawW, rawH, 1280);
          const scaleX = workW / rawW;
          const scaleY = workH / rawH;

          // キーフレーム補間(Lerp)が滑らかに繋ぐため、スマホでも超高速かつ低負荷な 0.35秒サンプリング
          const step = 0.35;
          const totalSteps = Math.max(1, Math.floor(totalDuration / step));

          resetAnalysisState();
          const createdTracks: MosaicTrack[] = [];
          let currentKeyframes: Keyframe[] = [];
          let lastValidBox: { x: number; y: number; width: number; height: number } | undefined = undefined;
          let prevBox: { x: number; y: number; width: number; height: number } | undefined = undefined;
          let pendingKeyframes: Keyframe[] = [];
          let consecutiveHits = 0;
          let missedDuration = 0; // 見失った継続時間（秒）

          for (let i = 0; i <= totalSteps; i++) {
            const sampleTime = Math.min(totalDuration, i * step);
            await seekVideoSafely(video, sampleTime);
            setAiDetectProgress(Math.round((i / totalSteps) * 100));

            const gateContext: GatekeeperContext = {
              prevBox,
              existingTracks: tracks.map((t) => ({
                id: t.id,
                box: t.keyframes[0] || { x: 0, y: 0, width: 0, height: 0 },
                hasManualKeyframe: t.keyframes.length > 1,
              })),
              origWidth: workW,
              origHeight: workH,
            };

            const res = await segmentPersonSafely(video, segmenter, gateContext);
            segmenter = res.activeSegmenter;

            if (res.contour && res.contour.points.length >= 3) {
              const scaledBox = {
                x: Math.round(res.contour.bounds.x * scaleX),
                y: Math.round(res.contour.bounds.y * scaleY),
                width: Math.round(res.contour.bounds.width * scaleX),
                height: Math.round(res.contour.bounds.height * scaleY),
              };
              const scaledPoints = res.contour.points.map((p) => ({
                x: p.x * scaleX,
                y: p.y * scaleY,
              }));
              const normPoints = res.contour.normalizedPoints || absoluteToNormalizedPoints(scaledBox, scaledPoints, NORMALIZED_POINT_COUNT);

              // 座標のスムージング（EMA補間 + 円周位相アライメント）
              // 頂点インデックスの位相ズレによるシルエットの潰れ・楕円化を完全に防ぎつつ、ジッターのみを自然に抑制
              const prevKf = currentKeyframes.length > 0
                ? currentKeyframes[currentKeyframes.length - 1]
                : pendingKeyframes.length > 0
                ? pendingKeyframes[pendingKeyframes.length - 1]
                : null;

              let finalBox = scaledBox;
              let finalPoints = scaledPoints;
              let finalNormPoints = normPoints;

              if (prevKf) {
                // 外枠の適度なスムージング (ジッター防止)
                const bPrevW = 0.35;
                const bCurrW = 0.65;
                finalBox = {
                  x: Math.round(prevKf.x * bPrevW + scaledBox.x * bCurrW),
                  y: Math.round(prevKf.y * bPrevW + scaledBox.y * bCurrW),
                  width: Math.round(prevKf.width * bPrevW + scaledBox.width * bCurrW),
                  height: Math.round(prevKf.height * bPrevW + scaledBox.height * bCurrW),
                };

                // 頂点の最適な円周位相（位相ズレ最小化）
                if (prevKf.normalizedPoints && prevKf.normalizedPoints.length === normPoints.length) {
                  const N = normPoints.length;
                  let bestShift = 0;
                  let bestDist = Infinity;

                  for (let shift = -3; shift <= 3; shift++) {
                    let dSum = 0;
                    for (let j = 0; j < N; j++) {
                      const curNp = normPoints[(j + shift + N) % N];
                      const prevNp = prevKf.normalizedPoints[j];
                      const du = curNp.u - prevNp.u;
                      const dv = curNp.v - prevNp.v;
                      dSum += du * du + dv * dv;
                    }
                    if (dSum < bestDist) {
                      bestDist = dSum;
                      bestShift = shift;
                    }
                  }

                  // 最適位相に回転
                  const alignedNorm = normPoints.map((_, idx) => normPoints[(idx + bestShift + N) % N]);

                  // 身体の凹凸（くびれ・首・腕）を100%保ちつつジッターのみ抑制 (prev 0.3, curr 0.7)
                  const pPrevW = 0.30;
                  const pCurrW = 0.70;
                  finalNormPoints = alignedNorm.map((np, idx) => ({
                    u: Number((prevKf.normalizedPoints![idx].u * pPrevW + np.u * pCurrW).toFixed(4)),
                    v: Number((prevKf.normalizedPoints![idx].v * pPrevW + np.v * pCurrW).toFixed(4)),
                  }));

                  finalPoints = normalizedToAbsolutePoints(finalBox, finalNormPoints);
                }
              }

              const kf: Keyframe = {
                time: sampleTime,
                ...finalBox,
                points: finalPoints,
                normalizedPoints: finalNormPoints,
              };

              consecutiveHits++;
              prevBox = finalBox;
              lastValidBox = finalBox;
              missedDuration = 0;

              if (currentKeyframes.length > 0) {
                // すでに確定済みのトラックがある場合は即座に追加（継続パス）
                currentKeyframes.push(kf);
              } else {
                // 新規検出時は単発ノイズを防ぐため一時バッファに保持
                pendingKeyframes.push(kf);
                if (consecutiveHits >= 3) {
                  // 3フレーム連続でゲートキーパーを通過した時点で正式採用！
                  currentKeyframes.push(...pendingKeyframes);
                  pendingKeyframes = [];
                }
              }
            } else {
              consecutiveHits = 0;
              pendingKeyframes = []; // 3フレーム未満で途切れた単発ノイズは破棄

              if (currentKeyframes.length > 0) {
                missedDuration += step;

                // 3. 手動キーフレームの「絶対保護」（タイムアウト・退場の例外）
                // 現在時刻より未来に手動キーフレームが存在する場合は、何フレーム見失おうが絶対に破棄せず補間を継続
                const hasFutureManualKeyframe = tracks.some((t) =>
                  t.keyframes.some((k) => k.time > sampleTime)
                );

                if (!hasFutureManualKeyframe) {
                  // 1. 画面境界からの「退場」判定（即時破棄）
                  // 直前フレームの枠が画面端（20px以内）に接していた場合は「画面外への退場」と確定
                  const isBorder = lastValidBox
                    ? isBoxTouchingBorder(lastValidBox, workW, workH, 20)
                    : false;

                  if (isBorder) {
                    // ホールド処理を即座に打ち切り、トラックを確定終了してゴースト枠を完全排除
                    const lastKf = currentKeyframes[currentKeyframes.length - 1];
                    createdTracks.push({
                      id: `ai-body-${Date.now()}-${createdTracks.length}`,
                      name: `AI人物 (体ライン) #${createdTracks.length + 1}`,
                      type: 'ai',
                      shape: 'polygon',
                      enabled: true,
                      mosaicType: 'pixel',
                      strength: 14,
                      startTime: currentKeyframes[0].time,
                      endTime: lastKf.time + 0.05,
                      keyframes: [...currentKeyframes],
                      aiTarget: 'body',
                    });

                    // 状態をリセットし、次の人物登場時に新規枠として作成
                    currentKeyframes = [];
                    lastValidBox = undefined;
                    prevBox = undefined;
                    missedDuration = 0;
                  } else if (missedDuration >= 1.0) {
                    // 2. 画面中央での「完全見失い」タイムアウト（連続約1秒 / 30フレームで遅延破棄）
                    const lastKf = currentKeyframes[currentKeyframes.length - 1];
                    createdTracks.push({
                      id: `ai-body-${Date.now()}-${createdTracks.length}`,
                      name: `AI人物 (体ライン) #${createdTracks.length + 1}`,
                      type: 'ai',
                      shape: 'polygon',
                      enabled: true,
                      mosaicType: 'pixel',
                      strength: 14,
                      startTime: currentKeyframes[0].time,
                      endTime: Math.min(totalDuration, lastKf.time + 1.0),
                      keyframes: [...currentKeyframes],
                      aiTarget: 'body',
                    });

                    currentKeyframes = [];
                    lastValidBox = undefined;
                    prevBox = undefined;
                    missedDuration = 0;
                  }
                }
              }
            }
          }

          await seekVideoSafely(video, origTime);

          // ループ終了時にアクティブなトラックが残っていれば確定
          if (currentKeyframes.length >= 1) {
            const lastKf = currentKeyframes[currentKeyframes.length - 1];
            const isBorder = lastValidBox ? isBoxTouchingBorder(lastValidBox, workW, workH, 20) : false;
            const trackEndTime = isBorder ? lastKf.time + 0.05 : Math.min(totalDuration, lastKf.time + 1.0);
            createdTracks.push({
              id: `ai-body-${Date.now()}-${createdTracks.length}`,
              name: `AI人物 (体ライン) #${createdTracks.length + 1}`,
              type: 'ai',
              shape: 'polygon',
              enabled: true,
              mosaicType: 'pixel',
              strength: 14,
              startTime: currentKeyframes[0].time,
              endTime: trackEndTime,
              keyframes: [...currentKeyframes],
              aiTarget: 'body',
            });
          }

          if (createdTracks.length >= 1) {
            setTracks((prev) => [...prev, ...createdTracks]);
            setSelectedTrackId(createdTracks[0].id);
            if (autoEnableInverse) {
              setIsInverseMosaic(true);
            }
          } else {
            // セグメンテーションでフレームが不足した場合は顔検出にフォールバック
            await runFaceDetectionFallback(targetMode, autoEnableInverse);
          }
        }
      } else {
        // 顔中心検出モード
        await runFaceDetectionFallback('face', autoEnableInverse);
      }
    } catch (err) {
      console.error('AI Detection failed', err);
      // エラー発生時は安全に顔検出へフォールバック
      try {
        await runFaceDetectionFallback(targetMode, autoEnableInverse);
      } catch (fbErr) {
        alert('AI検出の実行に失敗しました: ' + (err as Error).message);
      }
    } finally {
      await releaseScreenWakeLock();
      setIsAIDetecting(false);
      setAiDetectProgress(0);
    }
  };

  // 顔検出フォールバック関数
  const runFaceDetectionFallback = async (targetMode: 'face' | 'body', autoEnableInverse?: boolean) => {
    if (!videoRef.current && !imageRef.current) return;
    const filterOptions: FaceFilterOptions = {
      minScore: aiSensitivity === 'strict' ? 0.58 : aiSensitivity === 'standard' ? 0.48 : 0.35,
      minAspect: aiSensitivity === 'strict' ? 0.60 : 0.50,
      maxAspect: aiSensitivity === 'strict' ? 1.50 : 1.70,
      verifyFaceKeypoints: aiSensitivity !== 'high',
    };
    const minPersistenceFrames = aiSensitivity === 'strict' ? 4 : aiSensitivity === 'standard' ? 3 : 2;

    const confidence = filterOptions.minScore! * 0.9;
    let detector = await initFaceDetector(confidence);

    if (isImage && imageRef.current) {
      const img = imageRef.current;
      const rawW = img.naturalWidth || 640;
      const rawH = img.naturalHeight || 480;
      const { width: workW, height: workH } = getClampedDimensions(rawW, rawH, 1280);
      const scaleX = workW / rawW;
      const scaleY = workH / rawH;

      const result = await detectFacesSafely(img, detector, confidence);
      detector = result.activeDetector;
      const validDetections = (result.detections || []).filter((det) =>
        isValidFaceDetection(det, filterOptions)
      );

      const newAITracks: MosaicTrack[] = validDetections.map((det, idx) => {
        const bb = det.boundingBox;
        const rawBox = {
          x: bb ? bb.originX : 0,
          y: bb ? bb.originY : 0,
          width: bb ? bb.width : 50,
          height: bb ? bb.height : 50,
        };
        const finalBox = targetMode === 'body'
          ? estimateBodyBoxFromFace(rawBox, rawW, rawH)
          : expandBoxWithMargin(rawBox, 0.35, rawW, rawH);
        const bodyPoints = targetMode === 'body'
          ? createBodySilhouettePolygon(finalBox, rawW, rawH)
          : undefined;

        const scaledBox = {
          x: Math.round(finalBox.x * scaleX),
          y: Math.round(finalBox.y * scaleY),
          width: Math.round(finalBox.width * scaleX),
          height: Math.round(finalBox.height * scaleY),
        };
        const scaledPoints = bodyPoints ? bodyPoints.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY })) : undefined;
        const normPoints = scaledPoints ? absoluteToNormalizedPoints(scaledBox, scaledPoints, NORMALIZED_POINT_COUNT) : undefined;

        return {
          id: `ai-person-${Date.now()}-${idx}`,
          name: targetMode === 'body' ? `AI人物 (体ライン) #${idx + 1}` : `AI顔 #${idx + 1}`,
          type: 'ai',
          shape: targetMode === 'body' ? 'polygon' : 'rect',
          enabled: true,
          mosaicType: 'pixel',
          strength: 14,
          startTime: 0,
          endTime: 1,
          keyframes: [{ time: 0, ...scaledBox, points: scaledPoints, normalizedPoints: normPoints }],
          aiTarget: targetMode,
        };
      });
      setTracks((prev) => [...prev, ...newAITracks]);
      if (newAITracks.length > 0) {
        setSelectedTrackId(newAITracks[0].id);
      }
      if (autoEnableInverse && newAITracks.length > 0) {
        setIsInverseMosaic(true);
      }
    } else if (videoRef.current) {
      const video = videoRef.current;
      const origTime = video.currentTime;
      const totalDuration = video.duration || 5;
      const rawW = video.videoWidth || 640;
      const rawH = video.videoHeight || 480;
      const { width: workW, height: workH } = getClampedDimensions(rawW, rawH, 1280);
      const scaleX = workW / rawW;
      const scaleY = workH / rawH;
      const step = 0.35;
      const totalSteps = Math.max(1, Math.floor(totalDuration / step));

      let currentDetectedPersons: any[] = [];
      const personKeyframesMap = new Map<number, any[]>();
      const personScoresMap = new Map<number, number[]>();

      for (let i = 0; i <= totalSteps; i++) {
        const sampleTime = Math.min(totalDuration, i * step);
        await seekVideoSafely(video, sampleTime);
        setAiDetectProgress(Math.round((i / totalSteps) * 100));

        const result = await detectFacesSafely(video, detector, confidence);
        detector = result.activeDetector;
        const validDetections = (result.detections || []).filter((det) =>
          isValidFaceDetection(det, filterOptions)
        );

        const rawBoxes = validDetections.map((det) => {
          const bb = det.boundingBox!;
          const rawBox = {
            x: bb.originX,
            y: bb.originY,
            width: bb.width,
            height: bb.height,
          };
          const padded = expandBoxWithMargin(rawBox, 0.35, rawW, rawH);
          return {
            ...padded,
            rawFaceBox: rawBox,
            score: det.categories?.[0]?.score || 0.9,
          };
        });

        currentDetectedPersons = updatePersonTracks(
          currentDetectedPersons,
          rawBoxes,
          sampleTime,
          6
        );

        for (const p of currentDetectedPersons) {
          if (!personKeyframesMap.has(p.trackId)) {
            personKeyframesMap.set(p.trackId, []);
            personScoresMap.set(p.trackId, []);
          }
          const boxToStore = targetMode === 'body'
            ? estimateBodyBoxFromFace(p.box, rawW, rawH)
            : p.box;
          const bodyPoints = targetMode === 'body'
            ? createBodySilhouettePolygon(boxToStore, rawW, rawH)
            : undefined;

          const scaledBox = {
            x: Math.round(boxToStore.x * scaleX),
            y: Math.round(boxToStore.y * scaleY),
            width: Math.round(boxToStore.width * scaleX),
            height: Math.round(boxToStore.height * scaleY),
          };
          const scaledPoints = bodyPoints ? bodyPoints.map((pt) => ({ x: pt.x * scaleX, y: pt.y * scaleY })) : undefined;
          const normPoints = scaledPoints ? absoluteToNormalizedPoints(scaledBox, scaledPoints, NORMALIZED_POINT_COUNT) : undefined;

          personKeyframesMap.get(p.trackId)!.push({
            time: sampleTime,
            ...scaledBox,
            points: scaledPoints,
            normalizedPoints: normPoints,
          });
          personScoresMap.get(p.trackId)!.push(p.score);
        }
      }

      const newTracks: MosaicTrack[] = [];
      const requiredFrames = Math.min(minPersistenceFrames, totalSteps);

      personKeyframesMap.forEach((kfs, personId) => {
        if (kfs.length >= requiredFrames) {
          const scores = personScoresMap.get(personId) || [];
          const avgScore = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
          if (avgScore >= filterOptions.minScore! * 0.95) {
            newTracks.push({
              id: `ai-track-${personId}-${Date.now()}`,
              name: targetMode === 'body' ? `AI人物 (体ライン) #${personId}` : `AI顔 #${personId}`,
              type: 'ai',
              shape: targetMode === 'body' ? 'polygon' : 'rect',
              enabled: true,
              mosaicType: 'pixel',
              strength: 14,
              startTime: kfs[0].time,
              endTime: kfs[kfs.length - 1].time + 0.3,
              keyframes: kfs,
              aiPersonId: personId,
              aiTarget: targetMode,
            });
          }
        }
      });

      await seekVideoSafely(video, origTime);
      setTracks((prev) => [...prev, ...newTracks]);
      if (newTracks.length > 0) {
        setSelectedTrackId(newTracks[0].id);
      }
      if (autoEnableInverse && newTracks.length > 0) {
        setIsInverseMosaic(true);
      }
    }
  };

  // 「人物囲み+背景モザイク」ワンタップアクション
  const handleDetectAndBlurBackground = async () => {
    // 全身ターゲットでAI人物を検出し、自動で背景モザイク（反転モザイク）をON
    setAiTarget('body');
    await handleRunAIFaceDetection('body', true);
  };

  // エクスポート実行
  const handleExport = async () => {
    if (!mediaFile) return;

    if (!isImage && videoRef.current && videoRef.current.duration > 300) {
      const proceed = window.confirm(
        'ブラウザのメモリ制限のため、5分以上の動画は処理中に強制終了する可能性があります。短い動画にカットしてご利用ください。\n\nこのままエクスポートを続行しますか？'
      );
      if (!proceed) return;
    }

    setIsExportModalOpen(true);
    setExportedBlob(null);

    if (isImage && imageRef.current) {
      // 画像の場合: Canvas から PNG Blob を生成
      const canvas = document.createElement('canvas');
      canvas.width = imageRef.current.naturalWidth;
      canvas.height = imageRef.current.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(imageRef.current, 0, 0);

      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = canvas.width;
      sourceCanvas.height = canvas.height;
      sourceCanvas.getContext('2d')!.drawImage(imageRef.current, 0, 0);

      if (isInverseMosaic) {
        // 反転モザイク適用
        const protectedRegions: ProtectedRegion[] = [];
        tracks.forEach((track) => {
          if (track.enabled && track.keyframes[0]) {
            const k = track.keyframes[0];
            protectedRegions.push({
              shape: track.shape,
              x: k.x,
              y: k.y,
              width: k.width,
              height: k.height,
              points: k.points,
            });
          }
        });
        renderInverseMosaic(ctx, protectedRegions, canvas.width, canvas.height, inverseMosaicType, inverseStrength, sourceCanvas);
      } else {
        // 通常モザイク適用
        tracks.forEach((track) => {
          if (track.enabled && track.keyframes[0]) {
            const k = track.keyframes[0];
            renderTrackMosaic(ctx, track, k, sourceCanvas);
          }
        });
      }

      canvas.toBlob((blob) => {
        if (blob) {
          setExportedBlob(blob);
          setExportProgress({ currentFrame: 1, totalFrames: 1, percent: 100, status: '完了！' });
        }
      }, 'image/png');
      return;
    }

    if (videoRef.current) {
      try {
        const blob = await exportMosaicVideo(
          mediaFile,
          videoRef.current,
          tracks,
          {
            isInverseMosaic,
            inverseMosaicType,
            inverseStrength,
          },
          (prog) => setExportProgress(prog)
        );
        setExportedBlob(blob);
      } catch (err) {
        console.error('Export failed', err);
        alert('エクスポートに失敗しました: ' + (err as Error).message);
        setIsExportModalOpen(false);
      }
    }
  };

  const selectedTrack = tracks.find((t) => t.id === selectedTrackId) || null;
  const hasKeyframeAtCurrentTime = Boolean(
    selectedTrack?.keyframes.some((k) => Math.abs(k.time - currentTime) < 0.1)
  );

  const formatTimeStr = (sec: number) => {
    const s = Math.max(0, sec);
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 10);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;
  };

  return (
    <div className="flex flex-col min-h-screen md:h-screen w-screen overflow-x-hidden overflow-y-auto md:overflow-hidden bg-slate-950 text-slate-100">
      {/* 隠しメディア要素（display:none だとスマホのハードウェアデコーダがフレーム描画を省略することがあるため画面外1px配置） */}
      {mediaUrl && (
        <>
          {isImage ? (
            <img
              ref={imageRef}
              src={mediaUrl}
              alt="Source"
              className="fixed -left-[9999px] -top-[9999px] w-px h-px opacity-0 pointer-events-none"
            />
          ) : (
            <video
              ref={videoRef}
              src={mediaUrl}
              preload="auto"
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={handleTimeUpdate}
              onEnded={handleEnded}
              playsInline
              className="fixed -left-[9999px] -top-[9999px] w-px h-px opacity-0 pointer-events-none"
            />
          )}
        </>
      )}

      {/* ヘッダー */}
      <Header
        onOpenFile={handleOpenFile}
        onLoadDemo={handleLoadDemo}
        onExport={handleExport}
        hasMedia={Boolean(mediaFile)}
        isProcessing={isAIDetecting || isTrackingProcessing}
      />

      {/* ツールバー */}
      <Toolbar
        editorMode={editorMode}
        onSelectMode={setEditorMode}
        selectedTrack={selectedTrack}
        onUpdateTrackSettings={handleUpdateTrackSettings}
        onDeleteSelectedTrack={() => selectedTrackId && handleDeleteTrack(selectedTrackId)}
        onAddKeyframeAtCurrentTime={handleAddKeyframeAtCurrentTime}
        hasKeyframeAtCurrentTime={hasKeyframeAtCurrentTime}
        onRunAIFaceDetection={() => handleRunAIFaceDetection(aiTarget)}
        isAIDetecting={isAIDetecting}
        aiSensitivity={aiSensitivity}
        onUpdateAiSensitivity={setAiSensitivity}
        aiTarget={aiTarget}
        onUpdateAiTarget={setAiTarget}
        onDetectAndBlurBackground={handleDetectAndBlurBackground}
        isPreviewMode={isPreviewMode}
        onTogglePreviewMode={() => setIsPreviewMode((prev) => !prev)}
        isInverseMosaic={isInverseMosaic}
        onToggleInverseMosaic={() => setIsInverseMosaic((prev) => !prev)}
        inverseMosaicType={inverseMosaicType}
        onUpdateInverseMosaicType={setInverseMosaicType}
        inverseStrength={inverseStrength}
        onUpdateInverseStrength={setInverseStrength}
        onRunTrackingForSelectedTrack={() => selectedTrackId && runTrackingForTrack(selectedTrackId)}
        isTrackingProcessing={isTrackingProcessing}
      />

      {/* 長時間動画（5分以上）のメモリ警告バナー */}
      {durationWarning && (
        <div className="bg-amber-950/90 border-b border-amber-500/60 px-3 py-2 flex items-center justify-between gap-3 text-xs text-amber-200 z-30 shadow-md">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-amber-400 shrink-0" />
            <span>
              <strong className="text-amber-300">メモリ制限警告:</strong> 動画が5分（{Math.floor(duration / 60)}分{Math.floor(duration % 60)}秒）を超えています。ブラウザのメモリ制限のため、5分以上の動画は処理中に強制終了する可能性があります。短い動画にカットしてご利用ください。
            </span>
          </div>
          <button
            onClick={() => setDurationWarning(false)}
            className="text-amber-400 hover:text-white p-1 rounded shrink-0 transition"
            title="警告を閉じる"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* AI顔検出・自動追従解析中のスリープ防止＆進捗ステータスバー */}
      {(isAIDetecting || isTrackingProcessing) && (
        <div className="bg-emerald-950/90 border-b border-emerald-500/40 px-3 py-1.5 flex items-center justify-between gap-3 text-xs text-emerald-200 z-30">
          <div className="flex items-center gap-2 font-semibold">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            <span>
              {isAIDetecting
                ? `AI${aiTarget === 'body' ? '人物' : '顔'}自動検出を実行中... (${aiDetectProgress}%)`
                : '自動追従区間を解析中...'}
            </span>
          </div>
          <span className="text-[11px] bg-emerald-900/80 border border-emerald-600/50 text-emerald-300 px-2 py-0.5 rounded-full font-medium shrink-0">
            ⚡ 画面オフ（スリープ）防止作動中
          </span>
        </div>
      )}

      {/* スマホ専用ビュー切り替えタブ（PCでは非表示） */}
      {mediaUrl && (
        <div className="md:hidden flex items-center justify-around bg-slate-900/90 backdrop-blur border-b border-slate-800 p-1 text-xs font-semibold sticky top-0 z-20">
          <button
            onClick={() => setMobileTab('canvas')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md transition ${
              mobileTab === 'canvas'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Film size={14} />
            <span>映像・囲み</span>
          </button>

          <button
            onClick={() => setMobileTab('list')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md transition relative ${
              mobileTab === 'list'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <ListFilter size={14} />
            <span>枠・人物</span>
            {tracks.length > 0 && (
              <span className="bg-indigo-400 text-slate-950 text-[10px] font-black px-1.5 py-0.2 rounded-full">
                {tracks.length}
              </span>
            )}
          </button>

          {!isImage && (
            <button
              onClick={() => setMobileTab('timeline')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md transition ${
                mobileTab === 'timeline'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Clock size={14} />
              <span>タイムライン</span>
            </button>
          )}
        </div>
      )}

      {/* メインプレビュー＆サイドパネルエリア */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        {!mediaUrl ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-slate-400 gap-4 min-h-[350px]">
            <div className="w-16 h-16 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-3xl shadow-inner">
              🔒
            </div>
            <div className="max-w-md space-y-2">
              <h2 className="text-lg font-bold text-slate-200">
                動画・静止画モザイクエディターへようこそ
              </h2>
              <p className="text-xs text-slate-400 leading-relaxed">
                外部サーバーへの通信はブラウザのCSP（セキュリティポリシー）により遮断されています。動画や画像は端末のメモリ内でのみ処理されます。
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <label className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl cursor-pointer shadow-lg transition">
                <span>動画/画像を選択</span>
                <input
                  type="file"
                  accept="video/*,image/*"
                  onChange={handleOpenFile}
                  className="hidden"
                />
              </label>
              <button
                onClick={handleLoadDemo}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-indigo-700/60 text-xs font-bold rounded-xl shadow transition"
              >
                デモ動画で試す
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* キャンバスエリア（スマホではmobileTab === 'canvas'の時またはPCで表示） */}
            <div
              className={`flex-1 flex flex-col ${
                mobileTab === 'canvas' ? 'flex' : 'hidden md:flex'
              }`}
            >
              <VideoCanvas
                videoRef={videoRef}
                imageRef={imageRef}
                isImage={isImage}
                tracks={tracks}
                selectedTrackId={selectedTrackId}
                editorMode={editorMode}
                currentTime={currentTime}
                isPlaying={isPlaying}
                isPreviewMode={isPreviewMode}
                isInverseMosaic={isInverseMosaic}
                inverseMosaicType={inverseMosaicType}
                inverseStrength={inverseStrength}
                onSelectTrack={setSelectedTrackId}
                onAddTrack={handleAddTrack}
                onUpdateTrackKeyframe={handleUpdateTrackKeyframe}
                onToggleTrackEnabled={handleToggleTrackEnabled}
                onUpdateTrackFrameOut={handleUpdateTrackFrameOut}
                onDeleteTrack={handleDeleteTrack}
                onConvertTrackToPolygon={handleConvertTrackToPolygon}
              />

              {/* スマホ専用の直感クイック操作バー（動画を見ながらワンタップで再生・シーク・確認・追従解析可能） */}
              {!isImage && (
                <div className="md:hidden bg-slate-900 border-t border-slate-800 p-2 flex flex-col gap-1.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      onClick={togglePlay}
                      className="p-1.5 bg-indigo-600 text-white rounded-lg shadow font-bold flex items-center justify-center shrink-0 w-8 h-8"
                      title={isPlaying ? '一時停止' : '再生'}
                    >
                      {isPlaying ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
                    </button>

                    <div className="flex-1 flex items-center gap-2">
                      <input
                        type="range"
                        min="0"
                        max={duration || 1}
                        step="0.05"
                        value={currentTime}
                        onChange={(e) => handleSeek(Number(e.target.value))}
                        className="w-full accent-indigo-500 h-2 bg-slate-800 rounded-lg cursor-pointer"
                      />
                      <span className="font-mono text-[11px] text-slate-300 shrink-0">
                        {formatTimeStr(currentTime)} / {formatTimeStr(duration)}
                      </span>
                    </div>
                  </div>

                  {/* 選択枠の操作クイックボタン */}
                  {selectedTrack && (
                    <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-800/80">
                      <span className="text-[11px] text-cyan-400 font-semibold truncate max-w-[140px]">
                        {selectedTrack.name}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {selectedTrack.type === 'tracked' && (
                          <button
                            onClick={() => runTrackingForTrack(selectedTrack.id)}
                            disabled={isTrackingProcessing}
                            className="px-2 py-0.5 bg-indigo-900/80 hover:bg-indigo-800 border border-indigo-500 text-indigo-200 text-[10px] font-bold rounded flex items-center gap-1"
                          >
                            <Play size={10} className="fill-indigo-300" />
                            <span>{isTrackingProcessing ? '解析中...' : '自動追従'}</span>
                          </button>
                        )}
                        <button
                          onClick={() => handleDeleteTrack(selectedTrack.id)}
                          className="px-2 py-0.5 bg-rose-950/80 hover:bg-rose-900 border border-rose-600/70 text-rose-200 text-[10px] font-bold rounded flex items-center gap-0.5"
                        >
                          <Trash2 size={10} />
                          <span>削除</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 人物・指定領域リスト サイドパネル（スマホではmobileTab === 'list'の時またはPCで表示） */}
            <div
              className={`w-full md:w-64 ${
                mobileTab === 'list' ? 'flex flex-1' : 'hidden md:flex'
              }`}
            >
              <PersonListPanel
                tracks={tracks}
                selectedTrackId={selectedTrackId}
                onSelectTrack={setSelectedTrackId}
                onToggleTrackEnabled={handleToggleTrackEnabled}
                onToggleAllAITracks={handleToggleAllAITracks}
                onDeleteTrack={handleDeleteTrack}
                onDeleteAllUserTracks={handleDeleteAllUserTracks}
              />
            </div>

            {/* スマホ専用のタイムライン画面（mobileTab === 'timeline'の時のみ表示） */}
            {mediaUrl && !isImage && (
              <div
                className={`w-full ${
                  mobileTab === 'timeline' ? 'block flex-1' : 'hidden'
                }`}
              >
                <Timeline
                  duration={duration}
                  currentTime={currentTime}
                  isPlaying={isPlaying}
                  tracks={tracks}
                  selectedTrackId={selectedTrackId}
                  onSeek={handleSeek}
                  onTogglePlay={togglePlay}
                  onSelectTrack={setSelectedTrackId}
                  onUpdateTrackTime={handleUpdateTrackTime}
                  onToggleTrackEnabled={handleToggleTrackEnabled}
                  onDeleteTrack={handleDeleteTrack}
                  onSetInPoint={handleSetInPoint}
                  onSetOutPoint={handleSetOutPoint}
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* PC専用のタイムライン（PC表示時 md:block で下部に常時表示） */}
      {mediaUrl && !isImage && (
        <div className="hidden md:block">
          <Timeline
            duration={duration}
            currentTime={currentTime}
            isPlaying={isPlaying}
            tracks={tracks}
            selectedTrackId={selectedTrackId}
            onSeek={handleSeek}
            onTogglePlay={togglePlay}
            onSelectTrack={setSelectedTrackId}
            onUpdateTrackTime={handleUpdateTrackTime}
            onToggleTrackEnabled={handleToggleTrackEnabled}
            onDeleteTrack={handleDeleteTrack}
            onSetInPoint={handleSetInPoint}
            onSetOutPoint={handleSetOutPoint}
          />
        </div>
      )}

      {/* エクスポート進行＆完成プレビューモーダル */}
      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        progress={exportProgress}
        exportedBlob={exportedBlob}
        isImage={isImage}
      />
    </div>
  );
};
