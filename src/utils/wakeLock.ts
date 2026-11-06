/**
 * 画面スリープ（消灯）防止ユーティリティ (Screen Wake Lock API + 自動再取得)
 * AI顔検出・自動追従解析・動画エンコード中の画面オフや処理中断を防止します
 */

let wakeLockSentinel: any = null;
let activeLockCount = 0;
let visibilityListenerAttached = false;

async function acquireLockInternal(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
    try {
      if (wakeLockSentinel && !wakeLockSentinel.released) {
        return true;
      }
      wakeLockSentinel = await (navigator as any).wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {
        wakeLockSentinel = null;
      });
      return true;
    } catch (err) {
      console.warn('Wake Lock request failed:', err);
      return false;
    }
  }
  return false;
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible' && activeLockCount > 0) {
    acquireLockInternal();
  }
}

export async function requestScreenWakeLock(): Promise<boolean> {
  activeLockCount++;
  if (!visibilityListenerAttached && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    visibilityListenerAttached = true;
  }
  return await acquireLockInternal();
}

export async function releaseScreenWakeLock() {
  activeLockCount = Math.max(0, activeLockCount - 1);
  if (activeLockCount === 0 && wakeLockSentinel) {
    try {
      await wakeLockSentinel.release();
    } catch (e) {
      // ignore
    } finally {
      wakeLockSentinel = null;
    }
  }
}

/**
 * 画面消灯やバックグラウンド遷移が起きてもフリーズしない安全な video シーク関数
 */
export async function seekVideoSafely(
  video: HTMLVideoElement,
  targetTime: number,
  timeoutMs: number = 1500
): Promise<void> {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    await new Promise<void>((resolve) => {
      const onVisible = () => {
        if (document.visibilityState === 'visible') {
          document.removeEventListener('visibilitychange', onVisible);
          resolve();
        }
      };
      document.addEventListener('visibilitychange', onVisible);
      setTimeout(() => {
        document.removeEventListener('visibilitychange', onVisible);
        resolve();
      }, 2500);
    });
  }

  if (Math.abs(video.currentTime - targetTime) < 0.001 && video.readyState >= 2) {
    return;
  }

  // スマホブラウザで初期状態 (currentTime=0, readyState<2) のまま currentTime=0 を代入しても
  // seeked やフレームデコードが発火しないケースを防ぐため、微小オフセット(0.001秒)を与えて確実にデコードさせる
  const effectiveTime =
    Math.abs(video.currentTime - targetTime) < 0.001 && video.readyState < 2
      ? Math.min(video.duration || 0.1, targetTime + 0.001)
      : targetTime;

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', finish);
      video.removeEventListener('loadeddata', finish);
      document.removeEventListener('visibilitychange', onVisChange);
      resolve();
    };

    const onVisChange = () => {
      if (document.visibilityState === 'visible' && !settled) {
        try {
          video.currentTime = effectiveTime;
        } catch (_) {}
      }
    };

    const timer = setTimeout(finish, timeoutMs);
    video.addEventListener('seeked', finish, { once: true });
    video.addEventListener('loadeddata', finish, { once: true });
    document.addEventListener('visibilitychange', onVisChange);

    try {
      video.currentTime = effectiveTime;
    } catch (_) {
      finish();
    }
  });
}

