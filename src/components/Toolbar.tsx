import React from 'react';
import { EditorMode, MosaicType, MosaicTrack } from '../types';
import {
  MousePointer,
  Square,
  LassoSelect,
  Paintbrush,
  Pentagon,
  UserCheck,
  Sliders,
  Trash2,
  Eye,
  EyeOff,
  Crosshair,
  Sparkles,
  ShieldAlert,
  Play,
  RotateCcw,
} from 'lucide-react';

interface ToolbarProps {
  editorMode: EditorMode;
  onSelectMode: (mode: EditorMode) => void;
  selectedTrack: MosaicTrack | null;
  onUpdateTrackSettings: (updates: Partial<MosaicTrack>) => void;
  onDeleteSelectedTrack: () => void;
  onAddKeyframeAtCurrentTime: () => void;
  hasKeyframeAtCurrentTime: boolean;
  onRunAIFaceDetection: () => void;
  isAIDetecting: boolean;
  aiSensitivity?: 'strict' | 'standard' | 'high';
  onUpdateAiSensitivity?: (s: 'strict' | 'standard' | 'high') => void;
  isPreviewMode: boolean;
  onTogglePreviewMode: () => void;

  // 反転モザイク（選択領域以外にモザイクをかける機能）
  isInverseMosaic: boolean;
  onToggleInverseMosaic: () => void;
  inverseMosaicType: MosaicType;
  onUpdateInverseMosaicType: (t: MosaicType) => void;
  inverseStrength: number;
  onUpdateInverseStrength: (s: number) => void;

  // 追従解析
  onRunTrackingForSelectedTrack?: () => void;
  isTrackingProcessing?: boolean;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  editorMode,
  onSelectMode,
  selectedTrack,
  onUpdateTrackSettings,
  onDeleteSelectedTrack,
  onAddKeyframeAtCurrentTime,
  hasKeyframeAtCurrentTime,
  onRunAIFaceDetection,
  isAIDetecting,
  aiSensitivity = 'strict',
  onUpdateAiSensitivity,
  isPreviewMode,
  onTogglePreviewMode,
  isInverseMosaic,
  onToggleInverseMosaic,
  inverseMosaicType,
  onUpdateInverseMosaicType,
  inverseStrength,
  onUpdateInverseStrength,
  onRunTrackingForSelectedTrack,
  isTrackingProcessing,
}) => {
  return (
    <div className="bg-slate-900 border-b border-slate-800 px-2 sm:px-3 py-1.5 flex flex-col gap-1.5 text-xs">
      {/* ツール選択ボタン群（横スクロール可能でスマホでも縦に膨らまない） */}
      <div className="flex items-center justify-between gap-1 w-full overflow-x-auto no-scrollbar py-0.5">
        <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800 shrink-0">
          <button
            onClick={() => onSelectMode('select')}
            className={`flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-md font-medium transition shrink-0 ${
              editorMode === 'select'
                ? 'bg-indigo-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
            title="選択・移動・調整"
          >
            <MousePointer size={14} />
            <span className="hidden sm:inline">選択・移動</span>
          </button>

          <button
            onClick={() => onSelectMode('add_rect')}
            className={`flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-md font-medium transition shrink-0 ${
              editorMode === 'add_rect'
                ? 'bg-indigo-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
            title="ドラッグして矩形領域を指定し自動追従"
          >
            <Square size={14} />
            <span>矩形</span>
          </button>

          <button
            onClick={() => onSelectMode('add_lasso')}
            className={`flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-md font-medium transition shrink-0 ${
              editorMode === 'add_lasso'
                ? 'bg-indigo-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
            title="指やマウスでぐるっと自由な形で囲んで中身全体を選択"
          >
            <LassoSelect size={14} />
            <span>投げ縄</span>
          </button>

          <button
            onClick={() => onSelectMode('add_brush')}
            className={`flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-md font-medium transition shrink-0 ${
              editorMode === 'add_brush'
                ? 'bg-indigo-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
            title="指やマウスで自由になぞって指定"
          >
            <Paintbrush size={14} />
            <span>ブラシ</span>
          </button>

          <button
            onClick={() => onSelectMode('add_polygon')}
            className={`flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-md font-medium transition shrink-0 ${
              editorMode === 'add_polygon'
                ? 'bg-indigo-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
            title="クリックして多角形領域を指定"
          >
            <Pentagon size={14} />
            <span>多角形</span>
          </button>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {/* AI顔自動検出（誤検出抑制フィルタ・感度切替付き） */}
          <div className="flex items-center bg-emerald-950/80 border border-emerald-500/40 rounded-md p-0.5 shrink-0 gap-1">
            <button
              onClick={onRunAIFaceDetection}
              disabled={isAIDetecting}
              className="flex items-center gap-1 px-2 py-0.5 text-emerald-300 font-semibold hover:bg-emerald-900 rounded transition disabled:opacity-50"
              title="MediaPipeで動画内の顔を高精度自動追跡（手や物体の誤検出防止フィルタ付き）"
            >
              <UserCheck size={14} />
              <span>{isAIDetecting ? 'AI解析中...' : 'AI顔検出'}</span>
            </button>

            {onUpdateAiSensitivity && (
              <select
                value={aiSensitivity}
                onChange={(e) => onUpdateAiSensitivity(e.target.value as any)}
                className="bg-slate-900 text-emerald-300 text-[10px] rounded px-1 py-0.5 border border-emerald-600/40 cursor-pointer focus:outline-none"
                title="AI検出の感度設定: 手などの誤検出を防ぐには「高精度 (手を除外)」をご利用ください"
              >
                <option value="strict">高精度 (手を除外)</option>
                <option value="standard">標準</option>
                <option value="high">高感度 (遠くの顔)</option>
              </select>
            )}
          </div>

          {/* 反転モザイク（選択外モザイク） */}
          <button
            onClick={onToggleInverseMosaic}
            className={`flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-md font-bold transition shrink-0 ${
              isInverseMosaic
                ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-lg ring-1 ring-pink-400'
                : 'bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700'
            }`}
            title="選択した人物やPC画面以外の『背景全体』にモザイクを適用します"
          >
            <ShieldAlert size={14} className={isInverseMosaic ? 'text-pink-200' : 'text-purple-400'} />
            <span>{isInverseMosaic ? '選択外[ON]' : '選択外モザイク'}</span>
          </button>

          {/* 枠非表示プレビュー */}
          <button
            onClick={onTogglePreviewMode}
            className={`flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-md font-semibold transition shrink-0 ${
              isPreviewMode
                ? 'bg-amber-600 text-white shadow'
                : 'bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800'
            }`}
            title="編集ガイド枠や選択枠を隠して、完成時の見た目のまま再生・確認します"
          >
            {isPreviewMode ? <EyeOff size={14} /> : <Eye size={14} />}
            <span>{isPreviewMode ? '枠表示' : '枠非表示'}</span>
          </button>
        </div>
      </div>

      {/* サブバー: 反転モザイク設定 または 選択中トラックの設定（横スクロール可能） */}
      {(isInverseMosaic || selectedTrack) && (
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-0.5">
          {/* 反転モザイク（背景モザイク）設定 */}
          {isInverseMosaic && (
            <div className="flex items-center gap-1.5 bg-purple-950/60 border border-purple-500/50 px-2 py-1 rounded-lg shrink-0">
              <span className="font-bold text-pink-300 text-[11px] shrink-0">背景:</span>
              <div className="flex items-center bg-slate-900 rounded p-0.5 border border-purple-800">
                {(['blur', 'pixel', 'black'] as MosaicType[]).map((mType) => (
                  <button
                    key={mType}
                    onClick={() => onUpdateInverseMosaicType(mType)}
                    className={`px-1.5 py-0.5 rounded text-[11px] font-medium capitalize transition ${
                      inverseMosaicType === mType
                        ? 'bg-purple-600 text-white font-bold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {mType === 'pixel' ? 'モザイク' : mType === 'blur' ? 'すりガラス' : '黒塗り'}
                  </button>
                ))}
              </div>
              {inverseMosaicType !== 'black' && (
                <div className="flex items-center gap-1 text-[11px] text-slate-300 shrink-0">
                  <span className="text-[10px]">強:</span>
                  <input
                    type="range"
                    min="4"
                    max="50"
                    value={inverseStrength}
                    onChange={(e) => onUpdateInverseStrength(Number(e.target.value))}
                    className="w-14 sm:w-20 accent-pink-500 h-1.5 bg-slate-800 rounded cursor-pointer"
                  />
                  <span className="font-mono text-pink-200 text-[10px]">{inverseStrength}</span>
                </div>
              )}
            </div>
          )}

          {/* 選択中トラックの設定コントロール */}
          {selectedTrack && (
            <div className="flex items-center gap-1.5 bg-slate-950 px-2 py-1 rounded-lg border border-slate-800 shrink-0">
              <span className="text-cyan-400 font-semibold text-[11px] truncate max-w-[90px]">
                {selectedTrack.name}
              </span>

              {/* 自動追従一括解析ボタン */}
              {selectedTrack.type === 'tracked' && onRunTrackingForSelectedTrack && (
                <button
                  onClick={onRunTrackingForSelectedTrack}
                  disabled={isTrackingProcessing}
                  className="flex items-center gap-1 px-2 py-0.5 rounded bg-indigo-900/80 hover:bg-indigo-800 border border-indigo-500 text-indigo-200 font-bold transition disabled:opacity-50 text-[10px] shrink-0"
                  title="大域探索＋Lucas-Kanadeで動画区間を先読み解析し、追従精度を極限まで高めます"
                >
                  <Play size={10} className="text-indigo-400 fill-indigo-400" />
                  <span>{isTrackingProcessing ? '解析中...' : '自動追従'}</span>
                </button>
              )}

              {/* 個別モザイク種類（通常モザイクモード時） */}
              {!isInverseMosaic && (
                <>
                  <div className="flex items-center bg-slate-900 rounded p-0.5 border border-slate-800">
                    {(['pixel', 'blur', 'black'] as MosaicType[]).map((mType) => (
                      <button
                        key={mType}
                        onClick={() => onUpdateTrackSettings({ mosaicType: mType })}
                        className={`px-1.5 py-0.5 rounded text-[10px] font-medium capitalize transition ${
                          selectedTrack.mosaicType === mType
                            ? 'bg-indigo-600 text-white font-bold'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {mType === 'pixel' ? 'モザイク' : mType === 'blur' ? 'すりガラス' : '黒塗り'}
                      </button>
                    ))}
                  </div>

                  {selectedTrack.mosaicType !== 'black' && (
                    <div className="flex items-center gap-1 text-[10px] text-slate-400 shrink-0">
                      <span>強:</span>
                      <input
                        type="range"
                        min="4"
                        max="40"
                        value={selectedTrack.strength}
                        onChange={(e) => onUpdateTrackSettings({ strength: Number(e.target.value) })}
                        className="w-12 sm:w-16 accent-indigo-500 h-1.5 bg-slate-800 rounded cursor-pointer"
                      />
                      <span className="font-mono text-slate-200 text-[10px]">{selectedTrack.strength}</span>
                    </div>
                  )}
                </>
              )}

              {/* 手動キーフレーム補正ボタン（ズレ修正） */}
              <button
                onClick={onAddKeyframeAtCurrentTime}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium transition shrink-0 ${
                  hasKeyframeAtCurrentTime
                    ? 'bg-amber-950/70 border-amber-500 text-amber-300'
                    : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                }`}
                title="現在の再生位置に位置を記録（前後のズレを線形補間）"
              >
                <Crosshair size={11} />
                <span>{hasKeyframeAtCurrentTime ? '位置更新済' : '位置補正'}</span>
              </button>

              {/* ON/OFF 切り替え */}
              <button
                onClick={() => onUpdateTrackSettings({ enabled: !selectedTrack.enabled })}
                className={`p-1 rounded transition shrink-0 ${
                  selectedTrack.enabled
                    ? 'text-emerald-400 hover:bg-emerald-950/50'
                    : 'text-slate-500 hover:bg-slate-800'
                }`}
                title={selectedTrack.enabled ? '無効にする' : '有効にする'}
              >
                {selectedTrack.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>

              {/* 削除ボタン */}
              <button
                onClick={onDeleteSelectedTrack}
                className="flex items-center gap-0.5 px-1.5 py-0.5 bg-rose-950/80 hover:bg-rose-900 border border-rose-600/70 text-rose-200 font-bold rounded transition text-[10px] shrink-0"
                title="選択中の枠を削除します"
              >
                <Trash2 size={11} className="text-rose-400" />
                <span>削除</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
