let killNext = false;
let failNext = false;

export const chaos = {
  armKill() {
    killNext = true;
  },
  takeKill(): number | null {
    if (!killNext) return null;
    killNext = false;
    return 400; // abort the HTTP call 400 ms after sending: payment may or may not have settled
  },
  armFail() {
    failNext = true;
  },
  takeFail(): boolean {
    const v = failNext;
    failNext = false;
    return v;
  },
};
