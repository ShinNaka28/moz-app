/**
 * 画面スリープ（消灯）防止ユーティリティ (Screen Wake Lock API)
 * エンコード中のスリープによる処理中断を完全に防止します
 */

let wakeLockSentinel: any = null;

export async function requestScreenWakeLock(): Promise<boolean> {
  if ('wakeLock' in navigator) {
    try {
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

export async function releaseScreenWakeLock() {
  if (wakeLockSentinel) {
    try {
      await wakeLockSentinel.release();
    } catch (e) {
      // ignore
    } finally {
      wakeLockSentinel = null;
    }
  }
}
