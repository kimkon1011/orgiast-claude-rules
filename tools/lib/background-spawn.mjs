// Windows では detached が CREATE_NO_WINDOW を無効化するため使わない。
// 隠しコンソールを根で保持すると、その配下の子・孫も可視コンソールを作らない。
export function backgroundSpawnOptions(platform = process.platform) {
  return platform === 'win32' ? { windowsHide: true } : { detached: true };
}
