import { FRAME_METRIC, summary } from './config.js';

export const orbitAngle = (seconds, amplitude = 45, period = 8) =>
  ((amplitude * Math.PI) / 180) * Math.sin((seconds * 2 * Math.PI) / period);

// FPS = frames / sampled time. frameMs.mean (= time / frames) is kept in the raw data only.
export function frameStatistics(frameTimes) {
  const frames = frameTimes.length;
  const elapsedMs = frameTimes.reduce((sum, ms) => sum + ms, 0);
  return {
    frames,
    elapsedMs,
    fps: (1000 * frames) / elapsedMs,
    frameMs: { mean: elapsedMs / frames, ...summary(frameTimes) },
  };
}

// One GPU frame in flight: a new frame is drawn only after the previous frame's GPU work has
// completed. WebGL polls a fence with a zero timeout; WebGPU waits for onSubmittedWorkDone. A draw
// blocked at an animation frame keeps only the latest request and runs as soon as the GPU is free.
// WebGL polls through MessageChannel tasks, which avoid the >=4 ms clamp of nested setTimeout(0).
export function createFrameGate({ gl, device }) {
  let fence = null,
    pending = false,
    waiting,
    polling = false,
    pollId = 0;
  const channel = gl ? new MessageChannel() : null;
  if (channel)
    channel.port1.onmessage = ({ data }) => {
      // Ignore polls cancelled or superseded since they were posted.
      if (!polling || data !== pollId) return;
      polling = false;
      const draw = waiting;
      if (gate.isReady(draw)) draw?.();
    };
  const gate = {
    isReady(onReady) {
      if (gl?.isContextLost()) return false;
      if (fence !== null && gl.clientWaitSync(fence, 0, 0) !== gl.TIMEOUT_EXPIRED) {
        gl.deleteSync(fence);
        fence = null;
      }
      const ready = !pending && fence === null;
      if (ready) {
        polling = false;
        waiting = undefined;
      } else if (onReady) {
        waiting = onReady;
        if (gl && !polling) {
          polling = true;
          channel.port2.postMessage(++pollId);
        }
      }
      return ready;
    },
    submitted() {
      if (gl) {
        fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (!fence) throw Error('Could not create a WebGL fence');
        gl.flush();
        return;
      }
      pending = true;
      device.queue.onSubmittedWorkDone().then(
        () => {
          pending = false;
          const draw = waiting;
          waiting = undefined;
          draw?.();
        },
        error => {
          pending = false;
          waiting = undefined;
          gate.error = error;
        },
      );
    },
    dispose() {
      polling = false;
      waiting = undefined;
      channel?.port1.close();
      channel?.port2.close();
      if (fence !== null) gl.deleteSync(fence);
      fence = null;
    },
  };
  return gate;
}

// Samples are intervals between consecutive frame submissions under the one-in-flight gate, so
// FPS = drawn frames / sampled time and every counted frame completed on the GPU before the next.
export function sampleFrames({ warmup, duration, gpu, draw, check, onSampleStart, progress }) {
  const gate = createFrameGate(gpu);
  return new Promise((resolve, reject) => {
    const rows = [];
    let origin,
      previous,
      sampleStart,
      raf,
      done = false,
      lastProgress = 0,
      warmupFrames = 0;
    function cleanup() {
      done = true;
      cancelAnimationFrame(raf);
      gate.dispose();
      document.removeEventListener('visibilitychange', visibility);
    }
    function fail(error) {
      if (done) return;
      cleanup();
      reject(error);
    }
    function validate() {
      if (document.hidden) throw Error('Tab hidden. Sample discarded.');
      if (gpu.gl?.isContextLost()) throw Error('WebGL context lost. Sample discarded.');
      if (gate.error) throw Error(`GPU frame completion failed: ${gate.error}`);
      check?.();
    }
    function visibility() {
      if (document.hidden) fail(Error('Tab hidden. Sample discarded.'));
    }
    function frame() {
      if (done) return;
      try {
        validate();
        const now = performance.now();
        origin ??= now;
        if (sampleStart !== undefined && previous) {
          rows.push({ ...previous.details, startMs: previous.at - sampleStart, frameMs: now - previous.at });
          if (now - sampleStart >= duration * 1000) {
            cleanup();
            resolve({
              metric: FRAME_METRIC,
              framesInFlight: 1,
              rows,
              ...frameStatistics(rows.map(row => row.frameMs)),
              sampleStartedAt: sampleStart,
              warm: { frames: warmupFrames, ms: sampleStart - origin },
            });
            return;
          }
        }
        if (sampleStart === undefined && now - origin >= warmup * 1000) {
          sampleStart = now;
          onSampleStart?.();
        }
        const details = draw({ seconds: (now - origin) / 1000, dt: previous ? (now - previous.at) / 1000 : 1 / 60 });
        gate.submitted();
        previous = { at: now, details };
        if (sampleStart === undefined) warmupFrames++;
        if (progress && now - lastProgress >= 100) {
          progress({
            phase: sampleStart === undefined ? 'warmup' : 'sampling',
            elapsed: (now - (sampleStart ?? origin)) / 1000,
            duration: sampleStart === undefined ? warmup : duration,
          });
          lastProgress = now;
        }
      } catch (error) {
        fail(error);
      }
    }
    // Camera and async sorting keep running every animation frame; drawing waits for the gate.
    function tick() {
      if (done) return;
      raf = requestAnimationFrame(tick);
      try {
        validate();
      } catch (error) {
        fail(error);
        return;
      }
      if (gate.isReady(frame)) frame();
    }
    document.addEventListener('visibilitychange', visibility);
    raf = requestAnimationFrame(tick);
  });
}

// Used at measurement boundaries and for diagnostics, never between sampled frames.
export function waitForGpu({ gl, device }) {
  if (device) return device.queue.onSubmittedWorkDone();
  const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!fence) throw Error('Could not create a WebGL fence');
  gl.flush();
  const channel = new MessageChannel();
  return new Promise((resolve, reject) => {
    channel.port1.onmessage = () => {
      const status = gl.clientWaitSync(fence, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) {
        channel.port2.postMessage(null);
        return;
      }
      gl.deleteSync(fence);
      channel.port1.close();
      channel.port2.close();
      if (status === gl.WAIT_FAILED) reject(Error('WebGL fence failed'));
      else resolve();
    };
    channel.port2.postMessage(null);
  });
}
