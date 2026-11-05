import React, { useRef, useState, useCallback, useEffect } from 'react';
import { MosaicTrack } from '../types';
import { Play, Pause, SkipBack, SkipForward, ChevronLeft, ChevronRight, Clock, Trash2, Eye, EyeOff } from 'lucide-react';

interface TimelineProps {
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  tracks: MosaicTrack[];
  selectedTrackId: string | null;
  onSeek: (time: number) => void;
  onTogglePlay: () => void;
  onSelectTrack: (id: string | null) => void;
  onUpdateTrackTime: (id: string, startTime: number, endTime: number) => void;
  onToggleTrackEnabled: (id: string) => void;
  onDeleteTrack: (id: string) => void;
  onSetInPoint: () => void;
  onSetOutPoint: () => void;
}

export const Timeline: React.FC<TimelineProps> = ({
  duration,
  currentTime,
  isPlaying,
  tracks,
  selectedTrackId,
  onSeek,
  onTogglePlay,
  onSelectTrack,
  onUpdateTrackTime,
  onToggleTrackEnabled,
  onDeleteTrack,
  onSetInPoint,
  onSetOutPoint,
}) => {
  const rulerRef = useRef<HTMLDivElement>(null);
  const [draggingHandle, setDraggingHandle] = useState<{
    trackId: string;
    type: 'start' | 'end' | 'move';
    initialMouseX: number;
    initialStart: number;
    initialEnd: number;
  } | null>(null);

  // 時間フォーマット
  const formatTime = (sec: number) => {
    const s = Math.max(0, sec);
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 10);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;
  };

  // ルーラー上のクリック/ドラッグでシーク
  const handleRulerMouseDown = (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
    if (!rulerRef.current || duration <= 0) return;
    const rect = rulerRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onSeek(ratio * duration);
  };

  // トラックバーのドラッグ（In点・Out点・全体の移動）
  const handleStartDrag = (
    e: React.MouseEvent | React.TouchEvent,
    track: MosaicTrack,
    type: 'start' | 'end' | 'move'
  ) => {
    e.stopPropagation();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    setDraggingHandle({
      trackId: track.id,
      type,
      initialMouseX: clientX,
      initialStart: track.startTime,
      initialEnd: track.endTime,
    });
    onSelectTrack(track.id);
  };

  useEffect(() => {
    if (!draggingHandle) return;

    const handleMouseMove = (e: MouseEvent | TouchEvent) => {
      if (!rulerRef.current || duration <= 0) return;
      const rect = rulerRef.current.getBoundingClientRect();
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const deltaRatio = (clientX - draggingHandle.initialMouseX) / rect.width;
      const deltaTime = deltaRatio * duration;

      if (draggingHandle.type === 'start') {
        const newStart = Math.max(0, Math.min(draggingHandle.initialEnd - 0.1, draggingHandle.initialStart + deltaTime));
        onUpdateTrackTime(draggingHandle.trackId, newStart, draggingHandle.initialEnd);
      } else if (draggingHandle.type === 'end') {
        const newEnd = Math.min(duration, Math.max(draggingHandle.initialStart + 0.1, draggingHandle.initialEnd + deltaTime));
        onUpdateTrackTime(draggingHandle.trackId, draggingHandle.initialStart, newEnd);
      } else if (draggingHandle.type === 'move') {
        const trackLen = draggingHandle.initialEnd - draggingHandle.initialStart;
        let newStart = draggingHandle.initialStart + deltaTime;
        let newEnd = draggingHandle.initialEnd + deltaTime;
        if (newStart < 0) {
          newStart = 0;
          newEnd = trackLen;
        }
        if (newEnd > duration) {
          newEnd = duration;
          newStart = duration - trackLen;
        }
        onUpdateTrackTime(draggingHandle.trackId, newStart, newEnd);
      }
    };

    const handleMouseUp = () => {
      setDraggingHandle(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('touchmove', handleMouseMove);
    window.addEventListener('touchend', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('touchmove', handleMouseMove);
      window.removeEventListener('touchend', handleMouseUp);
    };
  }, [draggingHandle, duration, onUpdateTrackTime]);

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="bg-slate-900 border-t border-slate-800 p-2 sm:p-3 select-none flex flex-col gap-2">
      {/* タイムライン操作バー */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
        {/* 再生制御 */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => onSeek(Math.max(0, currentTime - 1 / 30))}
            className="p-1.5 hover:bg-slate-800 rounded text-slate-300 hover:text-white"
            title="1フレーム戻る"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={onTogglePlay}
            className="p-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-full transition shadow"
            title={isPlaying ? '一時停止' : '再生'}
          >
            {isPlaying ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
          </button>
          <button
            onClick={() => onSeek(Math.min(duration, currentTime + 1 / 30))}
            className="p-1.5 hover:bg-slate-800 rounded text-slate-300 hover:text-white"
            title="1フレーム進む"
          >
            <ChevronRight size={16} />
          </button>

          {/* 時間表示 */}
          <div className="ml-2 font-mono bg-slate-950 px-2 py-1 rounded border border-slate-800 text-cyan-400 font-semibold">
            {formatTime(currentTime)} <span className="text-slate-500">/ {formatTime(duration)}</span>
          </div>
        </div>

        {/* In点・Out点クイック指定ボタン */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onSetInPoint}
            disabled={!selectedTrackId}
            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium rounded border border-slate-700 text-slate-200 transition"
            title="選択中のモザイクの開始時間を現在の再生位置に設定"
          >
            [ In点指定
          </button>
          <button
            onClick={onSetOutPoint}
            disabled={!selectedTrackId}
            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium rounded border border-slate-700 text-slate-200 transition"
            title="選択中のモザイクの終了時間を現在の再生位置に設定"
          >
            Out点指定 ]
          </button>
        </div>
      </div>

      {/* タイムルーラー＆トラックレーン */}
      <div
        ref={rulerRef}
        onMouseDown={handleRulerMouseDown}
        onTouchStart={handleRulerMouseDown}
        className="relative bg-slate-950 border border-slate-800 rounded h-28 overflow-hidden cursor-pointer"
      >
        {/* 目盛りライン */}
        <div className="absolute inset-0 flex justify-between pointer-events-none opacity-20">
          {[...Array(11)].map((_, i) => (
            <div key={i} className="h-full border-r border-slate-400" />
          ))}
        </div>

        {/* 各トラックのレーン */}
        <div className="absolute inset-0 py-1 flex flex-col gap-1 overflow-y-auto">
          {tracks.map((track) => {
            const isSelected = track.id === selectedTrackId;
            const leftPercent = duration > 0 ? (track.startTime / duration) * 100 : 0;
            const widthPercent = duration > 0 ? ((track.endTime - track.startTime) / duration) * 100 : 100;

            const barColor = !track.enabled
              ? 'bg-slate-700 border-slate-600'
              : track.type === 'ai'
              ? isSelected
                ? 'bg-emerald-600 border-emerald-400'
                : 'bg-emerald-700/80 border-emerald-600'
              : isSelected
              ? 'bg-indigo-600 border-indigo-400'
              : 'bg-indigo-700/80 border-indigo-600';

            return (
              <div
                key={track.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectTrack(track.id);
                }}
                className={`relative h-6 text-xs flex items-center transition ${
                  isSelected ? 'bg-slate-900/50' : ''
                }`}
              >
                {/* トラック名ラベル */}
                <div className="absolute left-1 z-10 flex items-center gap-1 text-[10px] font-semibold text-slate-300 drop-shadow pointer-events-none truncate max-w-[120px]">
                  <span>{track.name}</span>
                </div>

                {/* タイムバー本体 */}
                <div
                  style={{
                    left: `${leftPercent}%`,
                    width: `${Math.max(1, widthPercent)}%`,
                  }}
                  onMouseDown={(e) => handleStartDrag(e, track, 'move')}
                  onTouchStart={(e) => handleStartDrag(e, track, 'move')}
                  className={`absolute h-full rounded border cursor-grab active:cursor-grabbing flex items-center justify-between px-1 shadow-sm ${barColor}`}
                >
                  {/* 左端ハンドル（In点伸縮） */}
                  <div
                    onMouseDown={(e) => handleStartDrag(e, track, 'start')}
                    onTouchStart={(e) => handleStartDrag(e, track, 'start')}
                    className="w-2.5 h-full -ml-1 cursor-ew-resize bg-white/40 hover:bg-white/80 rounded-l"
                    title="ドラッグで開始時間を調整"
                  />

                  {/* キーフレーム目印 */}
                  <div className="flex gap-1 overflow-hidden pointer-events-none">
                    {track.keyframes.map((k, kidx) => {
                      const kPercent = track.endTime > track.startTime
                        ? ((k.time - track.startTime) / (track.endTime - track.startTime)) * 100
                        : 0;
                      return (
                        <div
                          key={kidx}
                          style={{ left: `${kPercent}%` }}
                          className="w-1.5 h-1.5 bg-yellow-300 rotate-45 rounded-[1px]"
                        />
                      );
                    })}
                  </div>

                  {/* 右端ハンドル（Out点伸縮） */}
                  <div
                    onMouseDown={(e) => handleStartDrag(e, track, 'end')}
                    onTouchStart={(e) => handleStartDrag(e, track, 'end')}
                    className="w-2.5 h-full -mr-1 cursor-ew-resize bg-white/40 hover:bg-white/80 rounded-r"
                    title="ドラッグで終了時間を調整"
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* 再生ヘッド（現在の再生位置インジケーター） */}
        <div
          style={{ left: `${progressPercent}%` }}
          className="absolute top-0 bottom-0 w-0.5 bg-rose-500 pointer-events-none z-20"
        >
          <div className="w-2.5 h-2.5 -ml-1 -mt-0.5 bg-rose-500 rotate-45 rounded-[1px] shadow" />
        </div>
      </div>
    </div>
  );
};

