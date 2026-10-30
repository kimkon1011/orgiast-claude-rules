export const STOP_RETRY_INSTRUCTION = '前のメッセージを繰り返さない。指摘された不足分だけを書き、user がすべきことは最後のメッセージの末尾にまとめる。';

export function withStopRetryInstruction(reason) {
  return `${STOP_RETRY_INSTRUCTION}\n\n${reason}`;
}
