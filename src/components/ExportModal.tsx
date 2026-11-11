import React, { useEffect, useState } from 'react';
import { ExportProgress, saveOrShareBlob } from '../utils/videoExporter';
import { Download, Share2, CheckCircle2, Loader2, X, ArrowLeft, Play, Eye, Sun, AlertTriangle } from 'lucide-react';
import { APP_VERSION } from '../version';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  progress: ExportProgress | null;
  exportedBlob: Blob | null;
  isImage: boolean;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  progress,
  exportedBlob,
  isImage,
}) => {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (exportedBlob) {
      const url = URL.createObjectURL(exportedBlob);
      setPreviewUrl(url);
      return () => {
        URL.revokeObjectURL(url);
      };
    } else {
      setPreviewUrl(null);
    }
  }, [exportedBlob]);

  if (!isOpen) return null;

  const handleDownload = () => {
    if (!exportedBlob) return;
    const extension = isImage ? 'png' : 'mp4';
    const fileName = `privacy_mosaic_${Date.now()}.${extension}`;

    // 通常のファイルダウンロード
    const url = URL.createObjectURL(exportedBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const handleShare = async () => {
    if (!exportedBlob) return;
    const extension = isImage ? 'png' : 'mp4';
    const fileName = `privacy_mosaic_${Date.now()}.${extension}`;
    await saveOrShareBlob(exportedBlob, fileName);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-xl w-full p-4 sm:p-6 shadow-2xl relative my-auto">
        {/* 処理完了時のみ右上の閉じるボタンを表示（処理中の誤タップ遮断） */}
        {exportedBlob && (
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-white rounded-lg transition"
            title="閉じる"
          >
            <X size={20} />
          </button>
        )}

        {/* ヘッダータイトル */}
        <h3 className="text-base sm:text-lg font-bold text-slate-100 flex items-center gap-2 mb-3">
          {exportedBlob ? (
            <>
              <CheckCircle2 className="text-emerald-400" size={22} />
              <span>完成プレビュー（ダウンロード前確認）</span>
            </>
          ) : (
            <>
              <Loader2 className="text-indigo-400 animate-spin" size={22} />
              <span className="text-amber-300 font-bold">
                処理中... 画面を閉じたり、別のアプリを開かないでください
              </span>
            </>
          )}
        </h3>

        {/* 処理中ステータス */}
        {!exportedBlob && (
          <div className="space-y-4 py-3">
            {/* バックグラウンド移行防止警告バナー */}
            <div className="p-3.5 bg-amber-950/80 border-2 border-amber-500/80 rounded-xl flex items-start gap-3 text-amber-200 text-xs sm:text-sm font-semibold shadow-lg">
              <AlertTriangle size={22} className="text-amber-400 shrink-0 mt-0.5 animate-pulse" />
              <div>
                <p className="text-amber-200 font-bold text-sm">
                  処理中... 画面を閉じたり、別のアプリを開かないでください
                </p>
                <p className="text-amber-300/80 text-[11px] font-normal mt-1 leading-relaxed">
                  別のアプリへ切り替えたりタブをバックグラウンドに移動すると、ブラウザの省電力機能によりエンコード処理が中断・失敗する恐れがあります。この画面のまま完了をお待ちください。
                </p>
              </div>
            </div>

            <p className="text-sm text-slate-300 font-medium">
              {progress?.status || (isImage ? '画像を処理中...' : '動画エンコードを準備中...')}
            </p>

            {/* プログレスバー */}
            <div className="w-full bg-slate-950 rounded-full h-3 p-0.5 border border-slate-800 overflow-hidden">
              <div
                style={{ width: `${progress?.percent || 0}%` }}
                className="h-full bg-gradient-to-r from-indigo-500 via-cyan-400 to-emerald-400 rounded-full transition-all duration-150"
              />
            </div>

            <div className="flex justify-between text-xs text-slate-400 font-mono">
              <span>{progress?.percent || 0}%</span>
              <span>
                {progress?.currentFrame || 0} / {progress?.totalFrames || 0} フレーム
              </span>
            </div>

            {/* 画面消灯防止バッジ */}
            <div className="flex items-center gap-2 p-2.5 bg-indigo-950/70 border border-indigo-700/60 rounded-xl text-indigo-200 text-[11px] leading-relaxed">
              <Sun size={16} className="text-amber-400 shrink-0 animate-pulse" />
              <span>
                <strong className="text-amber-300">画面スリープ防止が作動中:</strong> 処理完了まで画面は自動消灯しません。そのままお待ちください。
              </span>
            </div>

            <p className="text-[11px] text-slate-500 bg-slate-950 p-2.5 rounded-lg border border-slate-800/80">
              🔒 外部送信は一切行われていません。すべて端末内のプロセッサとメモリで直接処理されています。
            </p>
          </div>
        )}

        {/* 完成プレビュー表示 */}
        {exportedBlob && previewUrl && (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="flex items-center gap-1 text-emerald-400 font-medium">
                <Eye size={14} />
                <span>再生してモザイクの追従と音声をご確認ください</span>
              </span>
              <span className="font-mono bg-slate-950 px-2 py-0.5 rounded border border-slate-800 text-slate-300">
                {formatFileSize(exportedBlob.size)}
              </span>
            </div>

            {/* プレビューメディアプレーヤー */}
            <div className="relative rounded-xl overflow-hidden bg-black border border-slate-800 shadow-inner flex items-center justify-center max-h-[50vh]">
              {isImage ? (
                <img
                  src={previewUrl}
                  alt="Mosaic Result"
                  className="max-h-[50vh] max-w-full object-contain"
                />
              ) : (
                <video
                  src={previewUrl}
                  crossOrigin="anonymous"
                  controls
                  playsInline
                  className="max-h-[50vh] max-w-full object-contain"
                />
              )}
            </div>

            {/* 操作ボタングループ */}
            <div className="flex flex-col gap-2 pt-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  onClick={handleDownload}
                  className="w-full py-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold rounded-xl shadow-lg flex items-center justify-center gap-2 transition text-sm"
                >
                  <Download size={18} />
                  <span>ファイルをダウンロード</span>
                </button>

                <button
                  onClick={handleShare}
                  className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl shadow-lg flex items-center justify-center gap-2 transition text-sm"
                  title="スマホの写真アプリや共有メニューで保存"
                >
                  <Share2 size={18} />
                  <span>端末に保存 / 共有シート</span>
                </button>
              </div>

              <button
                onClick={onClose}
                className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-xl transition flex items-center justify-center gap-1.5"
              >
                <ArrowLeft size={14} />
                <span>編集画面に戻って微調整する</span>
              </button>
            </div>
          </div>
        )}

        {/* バージョンフッター */}
        <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-[10px] text-slate-500 font-mono">
          <span>ローカルAIモザイクエディター</span>
          <span className="text-cyan-500/80 font-bold">Ver {APP_VERSION}</span>
        </div>
      </div>
    </div>
  );
};
