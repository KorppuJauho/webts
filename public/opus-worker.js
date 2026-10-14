// Opus for browsers without WebCodecs (Firefox on phones): libopus 1.3.1 in WebAssembly from
// opus-encdec 0.1.1 (MIT, libopus BSD; vendor/opus-encdec-0.1.1/ with LICENSE.md). These builds load their
// WebAssembly synchronously, which only a worker may do, so the work happens here, off the page's main thread.
//
// Page -> worker: { type: 'encode', pcm }            pcm = Float32Array, 960 samples (20 ms at 48 kHz, mono)
//                 { type: 'decode', speaker, packet } packet = ArrayBuffer (one Opus packet)
//                 { type: 'drop', speaker }           that speaker's decoder is no longer needed
// Worker -> page: { type: 'ready' } | { type: 'error', message }
//                 { type: 'encoded', packet }         ArrayBuffer, in the order the frames came
//                 { type: 'decoded', speaker, pcm }   Float32Array at 48 kHz
self.OPUS_SCRIPT_LOCATION = 'vendor/opus-encdec-0.1.1/';
importScripts('vendor/opus-encdec-0.1.1/libopus-encoder.wasm.min.js', 'vendor/opus-encdec-0.1.1/libopus-decoder.wasm.min.js');

const RATE = 48000;
const FRAME = 960;
const MAX_DECODED = 5760; // 120 ms, Opus's longest packet
const OPUS_APPLICATION_VOIP = 2048;
const OPUS_SET_BITRATE = 4002;

const whenReady = (lib) => new Promise((resolve) => {
    if (lib.isReady) resolve(lib);
    else lib.onready = () => resolve(lib);
});

let enc = null; // { lib, state, pcm, out }
const decoders = new Map(); // speaker -> { state, packet, pcm }

function createEncoder(lib) {
    const err = lib._malloc(4);
    const state = lib._opus_encoder_create(RATE, 1, OPUS_APPLICATION_VOIP, err);
    const code = lib.HEAP32[err >> 2];
    lib._free(err);
    if (code !== 0 || !state) throw new Error(`opus_encoder_create failed (${code})`);
    // opus_encoder_ctl is variadic: its argument goes through memory.
    const arg = lib._malloc(4);
    lib.HEAP32[arg >> 2] = 48000;
    lib._opus_encoder_ctl(state, OPUS_SET_BITRATE, arg);
    lib._free(arg);
    return { lib, state, pcm: lib._malloc(FRAME * 4), out: lib._malloc(4000) };
}

function createDecoder(lib) {
    const err = lib._malloc(4);
    const state = lib._opus_decoder_create(RATE, 1, err);
    const code = lib.HEAP32[err >> 2];
    lib._free(err);
    if (code !== 0 || !state) throw new Error(`opus_decoder_create failed (${code})`);
    return { lib, state, packet: lib._malloc(4000), pcm: lib._malloc(MAX_DECODED * 4) };
}

let libs = null;
const ready = Promise.all([whenReady(self.OpusEncoderLib), whenReady(self.OpusDecoderLib)])
    .then(([encoderLib, decoderLib]) => {
        libs = { encoderLib, decoderLib };
        enc = createEncoder(encoderLib);
        self.postMessage({ type: 'ready' });
    })
    .catch((e) => self.postMessage({ type: 'error', message: String(e && e.message || e) }));

self.onmessage = async (event) => {
    await ready;
    if (!libs) return;
    const msg = event.data || {};
    try {
        if (msg.type === 'encode') {
            const { lib } = enc;
            lib.HEAPF32.set(msg.pcm.subarray(0, FRAME), enc.pcm >> 2);
            const len = lib._opus_encode_float(enc.state, enc.pcm, FRAME, enc.out, 4000);
            if (len < 0) throw new Error(`encode error ${len}`);
            const packet = lib.HEAPU8.slice(enc.out, enc.out + len).buffer;
            self.postMessage({ type: 'encoded', packet }, [packet]);
        } else if (msg.type === 'decode') {
            let dec = decoders.get(msg.speaker);
            if (!dec) {
                dec = createDecoder(libs.decoderLib);
                decoders.set(msg.speaker, dec);
            }
            const { lib } = dec;
            const bytes = new Uint8Array(msg.packet);
            if (!bytes.length || bytes.length > 4000) return;
            lib.HEAPU8.set(bytes, dec.packet);
            const n = lib._opus_decode_float(dec.state, dec.packet, bytes.length, dec.pcm, MAX_DECODED, 0);
            if (n < 0) throw new Error(`decode error ${n}`);
            const pcm = lib.HEAPF32.slice(dec.pcm >> 2, (dec.pcm >> 2) + n);
            self.postMessage({ type: 'decoded', speaker: msg.speaker, pcm }, [pcm.buffer]);
        } else if (msg.type === 'drop') {
            const dec = decoders.get(msg.speaker);
            if (dec) {
                dec.lib._opus_decoder_destroy(dec.state);
                dec.lib._free(dec.packet);
                dec.lib._free(dec.pcm);
                decoders.delete(msg.speaker);
            }
        }
    } catch (e) {
        self.postMessage({ type: 'error', message: String(e && e.message || e) });
    }
};
