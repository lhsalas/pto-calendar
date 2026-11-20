import type { SecretInputSource } from '@pto-calendar/agent-auth';

const MAX_CONFIRMATION_BYTES = 5; // yes plus CRLF
const CONFIRMATION_TIMEOUT_MS = 120_000;
const LABEL = 'Type yes and press Enter to confirm: ';

function available(input: SecretInputSource, signal: AbortSignal): boolean {
  return (
    input.isTTY === true &&
    !input.destroyed &&
    !input.readableEnded &&
    input.listenerCount('data') === 0 &&
    input.listenerCount('readable') === 0 &&
    !signal.aborted
  );
}

/** Read one exact, short affirmative response on the existing terminal. */
function readDecision(input: SecretInputSource, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let bytes = '';
    function finish(approved: boolean): void {
      input.pause();
      input.off('data', data);
      input.off('end', refuse);
      input.off('close', refuse);
      input.off('error', refuse);
      signal.removeEventListener('abort', refuse);
      resolve(approved && !signal.aborted);
    }
    function refuse(): void {
      finish(false);
    }
    function data(chunk: Buffer | string): void {
      if (chunk.length + bytes.length > MAX_CONFIRMATION_BYTES) return refuse();
      bytes += typeof chunk === 'string' ? chunk : chunk.toString('latin1');
      if (bytes.endsWith('\n')) return finish(bytes === 'yes\n' || bytes === 'yes\r\n');
      if (!'yes\r\n'.startsWith(bytes)) return refuse();
    }
    input.on('data', data);
    input.once('end', refuse);
    input.once('close', refuse);
    input.once('error', refuse);
    signal.addEventListener('abort', refuse, { once: true });
  });
}

/** Never accept a pipe or show the question without successfully presenting the preview. */
export async function confirmWrite(
  input: SecretInputSource,
  stderrIsTerminal: boolean,
  signal: AbortSignal,
  present: (preview: string) => Promise<void>,
  preview: string,
): Promise<boolean> {
  if (!stderrIsTerminal || !available(input, signal)) return false;
  await present(`${preview}\n${LABEL}`);
  if (!available(input, signal)) return false;
  return readDecision(
    input,
    AbortSignal.any([signal, AbortSignal.timeout(CONFIRMATION_TIMEOUT_MS)]),
  );
}
