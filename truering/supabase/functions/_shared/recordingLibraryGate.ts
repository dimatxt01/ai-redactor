// Which training-library-admin actions need the recording_library flag ON (tr cos 2:14 PM, under Dmitry's 1:41 PM go).
// Every action that creates work, spends money or changes the library is gated. cancel, delete and sweep stay
// ungated on purpose: they only stop, clean up or remove, and must keep working with the flag OFF (rollback, cleanup).
// withdraw also stays ungated: it only takes a published call out of the library, which must stay possible when OFF.
export const FLAG_GATED_ACTIONS: ReadonlySet<string> = new Set([
  'submit', 'retry', 'pick', 'link', 'review', 'publish', 'edit',
]);
export const FLAG_UNGATED_ACTIONS: ReadonlySet<string> = new Set(['cancel', 'delete', 'sweep', 'withdraw']);

export const needsRecordingLibraryFlag = (action: string): boolean => FLAG_GATED_ACTIONS.has(action);

// Unknown actions are not gated here; the switch answers them 400 BAD_ACTION as before.
export async function recordingLibraryGate(
  action: string,
  isOn: () => Promise<boolean>,
): Promise<{ error: string; error_code: 'FLAG_OFF' } | null> {
  if (!needsRecordingLibraryFlag(action)) return null;
  if (await isOn()) return null;
  return { error: 'the Recording Library is switched off (flag recording_library)', error_code: 'FLAG_OFF' };
}

// Bridge poll (critic C1 b): with the flag OFF the worker is handed no new jobs. stop / cleanup / lost still run,
// so a cancel, a stale run or a vendor cleanup can still finish while the flag is OFF.
export const pollClaimCapacity = (capacity: number, flagOn: boolean): number => (flagOn ? capacity : 0);

// Critic #350 N1: recording_library is a kill switch for spend, so a feature_flags read error must not keep a stale ON
// alive. Past this bound the read fails safe to OFF (featureFlags.loadFlags maxErrorStaleMs).
export const RL_FLAG_MAX_ERROR_STALE_MS = 30_000;
