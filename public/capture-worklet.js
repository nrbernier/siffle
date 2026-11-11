// Forwards mic samples to the main thread in small batches, stamped with the
// context sample index. The main thread analyses each window and discards it;
// no audio is kept.
class SiffleCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 1024;
    this.buf = new Float32Array(this.cap);
    this.n = 0;
    this.start = 0;
  }

  flush() {
    if (this.n > 0) {
      this.port.postMessage({ start: this.start, data: this.buf.slice(0, this.n) });
      this.n = 0;
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      if (this.n + ch.length > this.cap) this.flush();
      if (this.n === 0) this.start = currentFrame;
      this.buf.set(ch, this.n);
      this.n += ch.length;
      if (this.n >= this.cap) this.flush();
    }
    return true;
  }
}

registerProcessor('siffle-capture', SiffleCapture);
