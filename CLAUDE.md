# Notes for coding agents

- The implementation plan is a Claude doc: https://claude.ai/artifact/NS6wA5nScJ5Gc6qzwQpnYE. Section numbers in code comments refer to it.
- `src/core/` is pure TypeScript (no DOM, no audio). All thresholds live in `src/core/config.ts`. Tune them against tests in `tests/`, using the synthetic signals in `tests/synth.ts`, never by ear only.
- `src/audio/engine.ts` owns the AudioContext: metronome, synth, scheduler, mic capture. The worklet in `public/capture-worklet.js` only forwards samples; analysis runs on the main thread through `StreamingAnalyzer`, which keeps one window and discards the rest. Never keep or upload audio.
- `src/ui/pianoroll.ts` is a canvas editor; `src/main.ts` holds app state. Every user action goes through `commit()` so it is one undo step.
- Notes keep their unquantized timing in `raw` (in beats) until edited by hand, so the grid can be changed later.
- Run `npm test` and `npm run build` before committing.
- Git identity for commits: author `nrbernier`, email `nathan.bernier@epfl.ch`.
