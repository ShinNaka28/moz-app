import React from 'react';
import { ExportProgress, saveOrShareBlob } from '../utils/videoExporter';
import { Download, Share2, CheckCircle2, Loader2, X } from 'lucide-react';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  progress: ExportProgress | null;
  exportedBlob: Blob | null;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  progress,
  exportedBlob,
}) => {
  if (!isOpen) return null;

  const handleDownload = () => {
    if (!exportedBlob) return;
    saveOrShareBlob(exportedBlob, `privacy_mosaic_${Date.now()}.mp4`);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-white rounded-lg transition"
        >
          <X size={18} />
        </button>

        <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2 mb-4">
          {exportedBlob ? (
            <>
              <CheckCircle2 className="text-emerald-400" size={22} />
              <span>エクスポート完了！</span>
            </>
          ) : (
            <>
              <Loader2 className="text-indigo-400 animate-spin" size={22} />
              <span>動画をローカルエンコード中...</span>
            </>
          )}
        </h3>

        {!exportedBlob && progress && (
          <div className="space-y-4">
            <p className="text-sm text-slate-300 font-medium">{progress.status}</p>

            {/* プログレスバー */}
            <div className="w-full bg-slate-950 rounded-full h-3 p-0.5 border border-slate-800 overflow-hidden">
              <div
                style={{ width: `${progress.percent}%` }}
                className="h-full bg-gradient-to-r from-indigo-500 to-cyan-400 rounded-full transition-all duration-150"
              />
            </div>

            <div className="flex justify-between text-xs text-slate-400 font-mono">
              <span>{progress.percent}%</span>
              <span>
                {progress.currentFrame} / {progress.totalFrames} フレーム
              </span>
            </div>

            <p className="text-[11px] text-slate-500 bg-slate-950 p-2.5 rounded-lg border border-slate-800/80">
              🔒 外部送信は一切行われていません。すべて端末内のプロセッサとメモリで直接処理されています。
            </p>
          </div>
        )}

        {exportedBlob && (
          <div className="space-y-4">
            <p className="text-sm text-slate-300">
              音声トラックを維持したMP4動画が正常に生成されました。端末に直接保存できます。
            </p>

            <div className="flex flex-col gap-2 pt-2">
              <button
                onClick={handleDownload}
                className="w-full py-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold rounded-xl shadow-lg flex items-center justify-center gap-2 transition"
              >
                <Download size={18} />
                <span>端末に保存 / 共有シートを開く</span>
              </button>

              <button
                onClick={onClose}
                className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-xl transition"
              >
                閉じる
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

