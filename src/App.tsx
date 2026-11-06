import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Header } from './components/Header';
import { Toolbar } from './components/Toolbar';
import { VideoCanvas } from './components/VideoCanvas';
import { Timeline } from './components/Timeline';
import { PersonListPanel } from './components/PersonListPanel';
import { ExportModal } from './components/ExportModal';
import { EditorMode, MosaicTrack, MosaicType, Point, Keyframe } from './types';
import { Film, ListFilter, Clock, Play, Pause, RotateCcw, Trash2, Crosshair, Sparkles } from 'lucide-react';
import { initFaceDetector, updatePersonTracks, expandBoxWithMargin, isValidFaceDetection, FaceFilterOptions } from './utils/aiDetector';
import { exportMosaicVideo, ExportProgress, saveOrShareBlob } from './utils/videoExporter';
import { generateDemoVideoBlob } from './utils/sampleGenerator';
import { renderTrackMosaic, renderInverseMosaic, ProtectedRegion } from './utils/mosaicRenderer';
import { extractFeaturePoints, toGrayscale, trackBox } from './utils/tracking';

export const App: React.FC = () => {
  // メディア状態
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [isImage, setIsImage] = useState<boolean>(false);
  const [duration, setDuration] = useState<number>(0);
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
  const [aiSensitivity, setAiSensitivity] = useState<'strict' | 'standard' | 'high'>('strict');
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
      setDuration(videoRef.current.duration || 1);
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

    // ユーザー指定追跡トラックの場合、直後に自動追従解析を実行
    if (!isImage && newTrack.type === 'tracked') {
      setTimeout(() => {
        runTrackingForTrack(newTrack.id, newTrack);
      }, 50);
    }
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

    const pos = track.keyframes[0];
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
    box: { x: number; y: number; width: number; height: number; points?: Point[] }
  ) => {
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== trackId) return t;

        const existingIdx = t.keyframes.findIndex(
          (k) => Math.abs(k.time - currentTime) < 0.15
        );
        let updatedKeyframes = [...t.keyframes];

        if (existingIdx !== -1) {
          updatedKeyframes[existingIdx] = {
            ...updatedKeyframes[existingIdx],
            ...box,
          };
        } else {
          updatedKeyframes.push({
            time: currentTime,
            ...box,
          });
          updatedKeyframes.sort((a, b) => a.time - b.time);
        }

        return {
          ...t,
          keyframes: updatedKeyframes,
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
    const video = videoRef.current;
    const origTime = video.currentTime;
    const width = video.videoWidth;
    const height = video.videoHeight;

    const offCanvas = document.createElement('canvas');
    offCanvas.width = width;
    offCanvas.height = height;
    const offCtx = offCanvas.getContext('2d', { willReadFrequently: true })!;

    try {
      const startT = track.startTime;
      const endT = track.endTime;
      const step = 0.08; // 12.5fpsの高密度サンプリング

      // 開始フレームにシーク
      video.currentTime = startT;
      await new Promise<void>((r) => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          r();
        };
        video.addEventListener('seeked', onSeeked);
      });

      offCtx.drawImage(video, 0, 0, width, height);
      let prevGray = toGrayscale(offCtx.getImageData(0, 0, width, height));

      const initialPos = track.keyframes[0];
      let curBox = { x: initialPos.x, y: initialPos.y, width: initialPos.width, height: initialPos.height };
      let featPoints = extractFeaturePoints(prevGray, width, height, curBox, 36);

      const generatedKeyframes: Keyframe[] = [
        {
          time: startT,
          x: curBox.x,
          y: curBox.y,
          width: curBox.width,
          height: curBox.height,
          points: initialPos.points,
        },
      ];

      const totalSteps = Math.floor((endT - startT) / step);
      for (let s = 1; s <= totalSteps; s++) {
        const curT = Math.min(endT, startT + s * step);
        video.currentTime = curT;

        await new Promise<void>((r) => {
          const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked);
            r();
          };
          video.addEventListener('seeked', onSeeked);
        });

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
        });
      }

      setTracks((prev) =>
        prev.map((t) => (t.id === targetTrackId ? { ...t, keyframes: generatedKeyframes } : t))
      );
    } catch (err) {
      console.error('Auto tracking failed', err);
    } finally {
      video.currentTime = origTime;
      setIsTrackingProcessing(false);
    }
  };

  // MediaPipe による高密度・AI人物顔自動検出＆追跡（手や物体の誤検出防止フィルタ付き）
  const handleRunAIFaceDetection = async () => {
    if (!videoRef.current && !imageRef.current) return;
    setIsAIDetecting(true);

    // 感度設定に応じたフィルタパラメータ
    const filterOptions: FaceFilterOptions = {
      minScore: aiSensitivity === 'strict' ? 0.58 : aiSensitivity === 'standard' ? 0.48 : 0.35,
      minAspect: aiSensitivity === 'strict' ? 0.60 : 0.50,
      maxAspect: aiSensitivity === 'strict' ? 1.50 : 1.70,
      verifyFaceKeypoints: aiSensitivity !== 'high',
    };
    const minPersistenceFrames = aiSensitivity === 'strict' ? 4 : aiSensitivity === 'standard' ? 3 : 2;

    try {
      const detector = await initFaceDetector(filterOptions.minScore! * 0.9);

      if (isImage && imageRef.current) {
        // 静止画の場合
        const result = detector.detect(imageRef.current);
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
          // 35%の安全マージン拡張
          const padded = expandBoxWithMargin(rawBox, 0.35);

          return {
            id: `ai-face-${Date.now()}-${idx}`,
            name: `AI顔 #${idx + 1}`,
            type: 'ai',
            shape: 'rect',
            enabled: true,
            mosaicType: 'pixel',
            strength: 14,
            startTime: 0,
            endTime: 1,
            keyframes: [{ time: 0, ...padded }],
          };
        });
        setTracks((prev) => [...prev, ...newAITracks]);
      } else if (videoRef.current) {
        // 動画の場合: 0.08秒間隔（約12.5fps）の超高密度スキャン
        const video = videoRef.current;
        const origTime = video.currentTime;
        const totalDuration = video.duration || 5;
        const step = 0.08;
        const totalSteps = Math.floor(totalDuration / step);

        let currentDetectedPersons: any[] = [];
        const personKeyframesMap = new Map<number, any[]>();
        const personScoresMap = new Map<number, number[]>();

        for (let i = 0; i <= totalSteps; i++) {
          const sampleTime = Math.min(totalDuration, i * step);
          video.currentTime = sampleTime;

          await new Promise<void>((res) => {
            const onSeeked = () => {
              video.removeEventListener('seeked', onSeeked);
              res();
            };
            video.addEventListener('seeked', onSeeked);
          });

          const result = detector.detect(video);
          // 手や背景などの誤検出を幾何学・スコアで除外
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
            // 35%安全マージンを付加して素顔チラ見えを防止
            const padded = expandBoxWithMargin(rawBox, 0.35);

            return {
              ...padded,
              score: det.categories?.[0]?.score || 0.9,
            };
          });

          // IoUトラッキングと見失い補間
          currentDetectedPersons = updatePersonTracks(
            currentDetectedPersons,
            rawBoxes,
            sampleTime,
            6 // 6フレーム見失いバッファ
          );

          for (const p of currentDetectedPersons) {
            if (!personKeyframesMap.has(p.trackId)) {
              personKeyframesMap.set(p.trackId, []);
              personScoresMap.set(p.trackId, []);
            }
            personKeyframesMap.get(p.trackId)!.push({
              time: sampleTime,
              x: p.box.x,
              y: p.box.y,
              width: p.box.width,
              height: p.box.height,
            });
            personScoresMap.get(p.trackId)!.push(p.score);
          }
        }

        // トラックへ変換（時間的持続性フィルタ：手が前を横切った瞬間の1〜2フレーム誤検出を完全に除外）
        const newTracks: MosaicTrack[] = [];
        const requiredFrames = Math.min(minPersistenceFrames, totalSteps);

        personKeyframesMap.forEach((kfs, personId) => {
          // 最低持続フレーム数以上のトラックのみを採用（手の瞬間誤検知を遮断）
          if (kfs.length >= requiredFrames) {
            const scores = personScoresMap.get(personId) || [];
            const avgScore = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);

            // 平均スコアが基準を満たしているか確認
            if (avgScore >= filterOptions.minScore! * 0.95) {
              newTracks.push({
                id: `ai-track-${personId}-${Date.now()}`,
                name: `AI顔 #${personId}`,
                type: 'ai',
                shape: 'rect',
                enabled: true,
                mosaicType: 'pixel',
                strength: 14,
                startTime: kfs[0].time,
                endTime: kfs[kfs.length - 1].time + 0.3,
                keyframes: kfs,
                aiPersonId: personId,
              });
            }
          }
        });

        video.currentTime = origTime;
        setTracks((prev) => [...prev, ...newTracks]);
      }
    } catch (err) {
      console.error('AI Detection failed', err);
      alert('AI検出の実行に失敗しました: ' + (err as Error).message);
    } finally {
      setIsAIDetecting(false);
    }
  };

  // エクスポート実行
  const handleExport = async () => {
    if (!mediaFile) return;

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
      {/* 隠しメディア要素 */}
      {mediaUrl && (
        <>
          {isImage ? (
            <img
              ref={imageRef}
              src={mediaUrl}
              alt="Source"
              className="hidden"
            />
          ) : (
            <video
              ref={videoRef}
              src={mediaUrl}
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={handleTimeUpdate}
              onEnded={handleEnded}
              playsInline
              crossOrigin="anonymous"
              className="hidden"
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
        onRunAIFaceDetection={handleRunAIFaceDetection}
        isAIDetecting={isAIDetecting}
        aiSensitivity={aiSensitivity}
        onUpdateAiSensitivity={setAiSensitivity}
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
