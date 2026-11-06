let killNext = false;
export const chaos = {
  armKill() {
    killNext = true;
  },
  /** Returns 400 (ms) once after arming, else null. */
  takeKill(): number | null {
    if (!killNext) return null;
    killNext = false;
    return 400;
  },
};
