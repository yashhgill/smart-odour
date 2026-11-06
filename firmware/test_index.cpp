// Run with: c++ -std=c++17 -I odour_node test_index.cpp -o /tmp/t && /tmp/t
#include <cassert>
#include <cstdio>
#include <cmath>
#include <string>
#include "odour_index.h"
using namespace odour;
static bool near(float a, float b, float e = 0.11f) { return fabs(a - b) < e; }
int main() {
  float clean[4] = {1, 1, 1, 1};
  assert(near(indexFromRatios(clean), 0));
  float two[4] = {2, 2, 1, 1};
  assert(near(indexFromRatios(two), 50));
  float four[4] = {4, 4, 4, 4};
  assert(near(indexFromRatios(four), 100));
  float huge[4] = {50, 50, 50, 50};
  assert(near(indexFromRatios(huge), 100));
  // one faulty sensor alone stays below the 60 "strong" threshold
  float oneBad[4] = {50, 1, 1, 1};
  float i = indexFromRatios(oneBad);
  printf("one faulty sensor gives index %.1f\n", i);
  assert(near(i, 50));
  // Rs falls as output voltage rises
  assert(rsFromVolts(2.0f) < rsFromVolts(1.0f));
  assert(rsFromVolts(0.0f) > 0 && std::isfinite(rsFromVolts(5.0f)));
  // baseline: first value, rises at once, sinks slowly
  assert(updateBaseline(0, 3) == 3);
  assert(near(updateBaseline(3, 4), 3.05f, 0.001f));   // one glitch barely moves it
  float up = 1; for (int k = 0; k < 200; k++) up = updateBaseline(up, 2);
  assert(near(up, 2, 0.01f));                            // sustained clean air does
  float b = updateBaseline(3, 1);
  assert(b < 3 && b > 2.99f);
  // half life check: 48 days of minutes
  float h = 1; for (int k = 0; k < 48 * 1440; k++) h = updateBaseline(h, 0.1f);
  printf("baseline after 48 days of dirty air: %.2f\n", h);
  assert(h > 0.4f && h < 0.6f);
  assert(ratioOf(2, 4) == 1.0f);   // cleaner than baseline never goes below 1
  assert(ratioOf(4, 2) == 2.0f);
  assert(climateFactor(25, 50, true) == 1.0f);
  assert(climateFactor(99, 99, false) == 1.0f);
  assert(climateFactor(60, 100, true) == 1.0f + 0.015f * 35 + 0.005f * 50);
  assert(std::string(levelName(10, 30, 60)) == "NORMAL");
  assert(std::string(levelName(30, 30, 60)) == "NOTICEABLE");
  assert(std::string(levelName(60, 30, 60)) == "STRONG");
  // queue keeps order, pops only what was confirmed, counts drops when full
  Fifo<int, 3> q;
  q.push(1); q.push(2); q.push(3);
  assert(q.count() == 3 && q.peek(0) == 1 && q.peek(2) == 3);
  assert(!q.push(4));
  assert(q.drops() == 1 && q.peek(0) == 2 && q.peek(2) == 4);
  q.pop(2);
  assert(q.count() == 1 && q.peek() == 4);
  q.pop(5);
  assert(q.count() == 0);
  puts("all firmware logic tests passed");
}
