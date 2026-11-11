# Siffle

Whistle a tune, see it as notes, fix it, export MIDI. A mobile-first web app that runs entirely in the browser.

Sound is analysed on the device and never stored or sent: only pitch and timing numbers leave the audio thread.

## Use it

1. Pick **Whistle** or **Hum**, set the tempo and length.
2. Tap the red button, wait for the four count-in clicks, then whistle along with the click.
3. The notes appear in the piano roll, snapped to the rhythm grid. Fix them by hand:
   - tap empty space to add a note, tap a note to select it
   - drag a note to move it, drag its right edge to resize it
   - **Octave** buttons move everything up or down (whistling sits two octaves above where it is shown)
4. **Export MIDI** opens the share sheet on a phone, or downloads the file on a computer.

The song is saved in the browser automatically.

## Develop

```sh
npm install
npm run dev     # local server, also reachable from a phone on the same network
npm test        # transcription, quantization and MIDI tests on synthetic audio
npm run build
```

Microphone access needs HTTPS or `localhost`. To try it on a phone during development, use the deployed GitHub Pages build or a tunnel.

## Status

Milestone 1 of the [implementation plan](https://claude.ai/artifact/NS6wA5nScJ5Gc6qzwQpnYE): whistle to a click, notes, piano roll editing, playback, MIDI export.

Next: key and mode detection, scale display, chord suggestions with explanations, sections and overdubs, staff notation.
