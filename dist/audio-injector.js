/**
 * audio-injector.ts — Inject TTS audio into Google Meet via virtual MediaStream
 *
 * Strategy:
 * 1. Before the page loads, monkey-patch navigator.mediaDevices.getUserMedia
 *    via context.addInitScript() so that audio requests return a virtual
 *    MediaStreamDestination stream instead of a real microphone.
 * 2. When TTS audio needs to play, decode it in the browser's AudioContext
 *    and route it through the same MediaStreamDestination.
 * 3. Google Meet sees the virtual stream as the microphone input.
 */
/**
 * The init script that patches getUserMedia before Google Meet requests it.
 * Must be added via context.addInitScript() BEFORE navigating to Meet.
 */
const VIRTUAL_AUDIO_INIT_SCRIPT = `
(function() {
  var origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  var virtualAudioStream = null;
  var audioCtx = null;
  var dest = null;

  navigator.mediaDevices.getUserMedia = async function(constraints) {
    if (constraints && constraints.audio) {
      if (!audioCtx) {
        audioCtx = new AudioContext({ sampleRate: 48000 });
        dest = audioCtx.createMediaStreamDestination();

        // Create a silent oscillator to keep the stream alive
        // (empty streams get garbage collected or marked inactive)
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(dest);
        osc.start();

        virtualAudioStream = dest.stream;

        // Expose for audio injection from Node.js
        window.__openutter_audio = {
          ctx: audioCtx,
          dest: dest,
          playing: false
        };

        console.log("[OpenUtter] Virtual audio stream initialized");
      }

      if (constraints.video) {
        // Both audio+video requested: get real video, substitute audio
        var realStream = await origGetUserMedia({ video: constraints.video });
        var combined = new MediaStream([
          ...virtualAudioStream.getAudioTracks(),
          ...realStream.getVideoTracks()
        ]);
        return combined;
      }

      // Audio-only request
      return virtualAudioStream;
    }

    // Non-audio request (e.g. screen share) — pass through
    return origGetUserMedia(constraints);
  };

  // Also patch enumerateDevices to show a virtual microphone
  var origEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  navigator.mediaDevices.enumerateDevices = async function() {
    var devices = await origEnumerate();
    // Ensure at least one audioinput device exists
    var hasAudioInput = devices.some(function(d) { return d.kind === "audioinput"; });
    if (!hasAudioInput) {
      devices.push({
        deviceId: "openutter-virtual-mic",
        kind: "audioinput",
        label: "OpenUtter Virtual Microphone",
        groupId: "openutter",
        toJSON: function() { return {}; }
      });
    }
    return devices;
  };

  console.log("[OpenUtter] getUserMedia patched for virtual audio");
})();
`;
/**
 * Set up the virtual audio infrastructure. Must be called BEFORE
 * navigating to Google Meet so the getUserMedia patch is in place.
 */
export async function setupVirtualAudio(context) {
    await context.addInitScript(VIRTUAL_AUDIO_INIT_SCRIPT);
}
/**
 * Inject audio into the virtual MediaStream so Google Meet participants hear it.
 *
 * @param page - The Playwright page with the Google Meet session
 * @param audioBuffer - MP3 audio data as a Buffer
 */
export async function injectAudio(page, audioBuffer) {
    const base64Audio = audioBuffer.toString("base64");
    const success = await page.evaluate(async (b64) => {
        const audioState = window.__openutter_audio;
        if (!audioState || !audioState.ctx || !audioState.dest) {
            console.error("[OpenUtter] Virtual audio not initialized");
            return false;
        }
        const { ctx, dest } = audioState;
        // Resume AudioContext if suspended (browsers suspend until user gesture)
        if (ctx.state === "suspended") {
            await ctx.resume();
        }
        // Decode base64 to ArrayBuffer
        const binaryString = atob(b64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        // Decode the MP3 audio data
        const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
        // Play through the virtual audio destination
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(dest);
        audioState.playing = true;
        source.start();
        // Wait for playback to complete
        await new Promise((resolve) => {
            source.onended = () => {
                audioState.playing = false;
                resolve();
            };
        });
        return true;
    }, base64Audio);
    if (!success) {
        throw new Error("Audio injection failed — virtual audio not initialized");
    }
}
/**
 * Check if audio is currently being played through the virtual stream.
 */
export async function isPlaying(page) {
    return page.evaluate(() => {
        const audioState = window.__openutter_audio;
        return audioState?.playing === true;
    });
}
//# sourceMappingURL=audio-injector.js.map