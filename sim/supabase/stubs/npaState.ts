// SIMULATION ONLY: TrueRing's _shared/npaState.ts maps an area code to a US state. The test calls'
// numbers are fictional, so the simulation answers from a two-entry table.
const NPA: Record<string, string> = { "512": "TX", "305": "FL" };
export function stateFromNumber(callerNumber: string): string | null {
  const d = String(callerNumber).replace(/\D/g, "").replace(/^1/, "");
  return NPA[d.slice(0, 3)] ?? null;
}
