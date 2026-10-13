import { useRef, useState } from "react";

/**
 * Continuous-playback coverage: only seconds actually played in order count (seeking ahead does not),
 * so the "listened in full" box cannot be unlocked by dragging the scrubber.
 */
export function useListenCoverage() {
  const played = useRef<Set<number>>(new Set());
  const lastT = useRef(0);
  const [heardS, setHeardS] = useState(0);
  const onTimeUpdate = (a: HTMLAudioElement | null) => {
    if (!a) return;
    if (!a.paused && a.currentTime - lastT.current < 1.5 && a.currentTime >= lastT.current) {
      played.current.add(Math.floor(a.currentTime));
      setHeardS(played.current.size);
    }
    lastT.current = a.currentTime;
  };
  const markSeek = (t: number) => { lastT.current = t; };
  return { heardS, onTimeUpdate, markSeek };
}
