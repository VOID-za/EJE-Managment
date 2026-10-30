import { downloadBytes } from '@/lib/download';

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled';

/**
 * EXPORT: HAND THE FILE TO ANOTHER APP. PAY-01 (30 October 2026).
 *
 * "Download PDF" saves the file. "Export PDF" gives it to the device's share
 * sheet — on the Android tablets that is email, WhatsApp, Drive or a printer
 * app — with the file name the rules gave it. A browser that cannot share a
 * file (most desktops) gets the same file as a download instead, and the
 * caller says so: Export never silently does nothing.
 *
 * A share the person cancels is not a failure and does not fall back to a
 * download they did not ask for.
 */
export const shareOrDownload = async (
  bytes: Uint8Array,
  fileName: string,
  contentType: string,
  nav: Pick<Navigator, 'share' | 'canShare'> | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): Promise<ShareOutcome> => {
  const file = new File([new Uint8Array(bytes)], fileName, { type: contentType });
  const canShare = nav !== undefined && typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] });
  if (canShare) {
    try {
      await nav.share({ files: [file], title: fileName });
      return 'shared';
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return 'cancelled';
      // A share sheet that failed for any other reason still owes the person the file.
    }
  }
  downloadBytes(bytes, fileName, contentType);
  return 'downloaded';
};
