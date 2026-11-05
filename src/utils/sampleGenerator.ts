/**
 * デモ＆テスト用の合成動画生成ユーティリティ
 * 動く人物（顔）やカメラのパンによるPC画面/文字の移動を再現した動画Blobを即座に生成
 */
export async function generateDemoVideoBlob(): Promise<File> {
  const width = 640;
  const height = 360;
  const fps = 30;
  const durationSec = 6;
  const totalFrames = fps * durationSec;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const stream = canvas.captureStream(fps);

  // 音声トラック（ダミーBGM/トーン生成）
  const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  const osc = audioCtx.createOscillator();
  const dest = audioCtx.createMediaStreamDestination();
  osc.frequency.setValueAtTime(440, audioCtx.currentTime);
  osc.connect(dest);
  osc.start();
  if (dest.stream.getAudioTracks().length > 0) {
    stream.addTrack(dest.stream.getAudioTracks()[0]);
  }

  const mimeType = MediaRecorder.isTypeSupported('video/mp4')
    ? 'video/mp4'
    : 'video/webm';

  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const donePromise = new Promise<Blob>((resolve) => {
    recorder.onstop = () => {
      osc.stop();
      audioCtx.close();
      resolve(new Blob(chunks, { type: mimeType }));
    };
  });

  recorder.start();

  let frame = 0;
  const interval = setInterval(() => {
    const t = frame / fps;

    // 背景（オフィス風グラデーション）
    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, '#1e293b');
    grad.addColorStop(1, '#0f172a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // カメラのパン（左右揺れ）を模擬
    const panX = Math.sin(t * 1.5) * 60;
    const panY = Math.cos(t * 1.2) * 20;

    // 1. 動くPCモニター（個人情報・機密テキスト）
    const monitorX = 80 + panX;
    const monitorY = 120 + panY;
    const monitorW = 180;
    const monitorH = 110;

    // モニター枠
    ctx.fillStyle = '#334155';
    ctx.fillRect(monitorX - 4, monitorY - 4, monitorW + 8, monitorH + 8);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(monitorX, monitorY, monitorW, monitorH);

    // モニター内個人情報テキスト
    ctx.fillStyle = '#dc2626';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText('【極秘社内資料】', monitorX + 10, monitorY + 22);
    ctx.fillStyle = '#0f172a';
    ctx.font = '10px monospace';
    ctx.fillText('氏名: 山田 太郎 (ID: 9841)', monitorX + 10, monitorY + 42);
    ctx.fillText('TEL: 090-1234-5678', monitorX + 10, monitorY + 60);
    ctx.fillText('売上高: ¥150,000,000', monitorX + 10, monitorY + 78);
    ctx.fillText('パスワード: secret@2026', monitorX + 10, monitorY + 96);

    // 2. 動く人物（顔と体）
    const personX = 420 - Math.sin(t * 2) * 80;
    const personY = 90 + Math.cos(t * 1.5) * 25;

    // 体・肩
    ctx.fillStyle = '#3b82f6';
    ctx.beginPath();
    ctx.arc(personX, personY + 110, 65, Math.PI, 0, false);
    ctx.fill();

    // 顔（肌色）
    ctx.fillStyle = '#fed7aa';
    ctx.beginPath();
    ctx.arc(personX, personY + 35, 45, 0, Math.PI * 2);
    ctx.fill();

    // 髪の毛
    ctx.fillStyle = '#1e1b4b';
    ctx.beginPath();
    ctx.arc(personX, personY + 20, 46, Math.PI * 0.8, Math.PI * 2.2);
    ctx.fill();

    // 目
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.arc(personX - 16, personY + 32, 5, 0, Math.PI * 2);
    ctx.arc(personX + 16, personY + 32, 5, 0, Math.PI * 2);
    ctx.fill();

    // 口
    ctx.strokeStyle = '#b91c1c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(personX, personY + 52, 14, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.stroke();

    // 3. タイムコードと案内オーバーレイ
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(10, 10, 260, 24);
    ctx.fillStyle = '#38bdf8';
    ctx.font = '12px monospace';
    ctx.fillText(`TEST DEMO CLIP: ${t.toFixed(2)}s / ${durationSec}s`, 18, 26);

    frame++;
    if (frame >= totalFrames) {
      clearInterval(interval);
      recorder.stop();
    }
  }, 1000 / fps);

  const rawBlob = await donePromise;
  return new File([rawBlob], 'demo_sample_video.mp4', { type: rawBlob.type });
}

