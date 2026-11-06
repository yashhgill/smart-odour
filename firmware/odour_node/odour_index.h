// Odour Index logic, kept free of Arduino code so it can be unit-tested on a laptop.
//
// An MQ sensor's resistance (Rs) falls when gas reaches it. So for each sensor:
//   ratio = baseline Rs in clean air / Rs now
// ratio 1.0 means "same as clean air"; ratio 2.0 means "twice the response".
//
// Odour Index = 0..100 on a log scale, where 100 means ratio 4 or more, using the
// geometric mean of the two most responsive sensors, each capped at 4. One sensor
// alone therefore tops out at 50: enough to notice, never enough for "strong", so
// a single faulty sensor cannot cause a strong alert. It is a relative index, not ppm.
#pragma once
#include <math.h>

namespace odour {

const int SENSORS = 4;
const float FULL_SCALE_RATIO = 4.0f;

// Module load resistor is fixed on the board, so Rs is only needed as a relative
// number and RL is treated as 1. Volts are at the sensor output, after undoing the divider.
inline float rsFromVolts(float volts, float supply = 5.0f) {
  if (volts < 0.02f) volts = 0.02f;
  if (volts > supply - 0.02f) volts = supply - 0.02f;
  return (supply - volts) / volts;
}

// Warm, humid air lowers Rs and looks like gas. This is the correction factor
// carried over from the PSM 1 prototype. Values are starting values: the
// evaluation checks whether index still follows humidity after correction.
inline float climateFactor(float tempC, float humidity, bool valid) {
  if (!valid) return 1.0f;
  float f = 1.0f + 0.015f * (tempC - 25.0f) + 0.005f * (humidity - 50.0f);
  if (f < 0.5f) f = 0.5f;
  if (f > 2.0f) f = 2.0f;
  return f;
}

// Baseline follows the cleanest air seen. It climbs 5% of the gap per sample when
// the air is cleaner, so one glitch reading barely moves it, and otherwise sinks very
// slowly so sensor ageing does not stick the index high.
// decayPerSample of 0.99999 at one sample a minute halves in about 48 days.
inline float updateBaseline(float baseline, float rs, float decayPerSample = 0.99999f) {
  if (baseline <= 0.0f) return rs;
  if (rs > baseline) return baseline + 0.05f * (rs - baseline);
  return baseline * decayPerSample;
}

inline float ratioOf(float baseline, float rs) {
  if (rs <= 0.0f || baseline <= 0.0f) return 1.0f;
  float r = baseline / rs;
  return r < 1.0f ? 1.0f : r;
}

inline float indexFromRatios(const float r[SENSORS]) {
  float top1 = 1.0f, top2 = 1.0f;
  for (int i = 0; i < SENSORS; i++) {
    if (r[i] > top1) { top2 = top1; top1 = r[i]; }
    else if (r[i] > top2) { top2 = r[i]; }
  }
  if (top1 > FULL_SCALE_RATIO) top1 = FULL_SCALE_RATIO;
  if (top2 > FULL_SCALE_RATIO) top2 = FULL_SCALE_RATIO;
  float v = 100.0f * log(sqrtf(top1 * top2)) / log(FULL_SCALE_RATIO);
  if (v < 0.0f) v = 0.0f;
  if (v > 100.0f) v = 100.0f;
  return roundf(v * 10.0f) / 10.0f;
}

inline const char* levelName(float idx, float noticeable, float strong) {
  if (idx >= strong) return "STRONG";
  if (idx >= noticeable) return "NOTICEABLE";
  return "NORMAL";
}

// First-in first-out store for readings waiting to reach the cloud.
// When full the oldest is dropped, and the drop is counted so tests can see it.
template <typename T, int N>
class Fifo {
 public:
  bool push(const T& v) {
    bool dropped = false;
    if (count_ == N) { head_ = (head_ + 1) % N; count_--; drops_++; dropped = true; }
    items_[(head_ + count_) % N] = v;
    count_++;
    return !dropped;
  }
  const T& peek(int i = 0) const { return items_[(head_ + i) % N]; }
  void pop(int n) {
    if (n > count_) n = count_;
    head_ = (head_ + n) % N;
    count_ -= n;
  }
  int count() const { return count_; }
  unsigned long drops() const { return drops_; }
 private:
  T items_[N];
  int head_ = 0, count_ = 0;
  unsigned long drops_ = 0;
};

}  // namespace odour
