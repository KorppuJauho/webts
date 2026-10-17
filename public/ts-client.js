// --- SHARED MEMORY & STATE ---
let latestState = null;
let activeChannelId = null;
let selfClid = 0;
let messages = [];
// This device's own id (tells a PC and a phone apart), made once
let deviceId = localStorage.getItem('ts_device_id');
if (!deviceId) {
    deviceId = 'dev_' + Math.random().toString(36).substring(2, 15);
    localStorage.setItem('ts_device_id', deviceId);
}

// --- HARDWARE CONTROLS (UI) ---
// Mute survives a reload: the page starts as you left it, and TeamSpeak is told (syncMuteToTeamSpeak).
let isMicMuted = false;
let isAudioMuted = false;
try {
    isMicMuted = localStorage.getItem('ts_mic_muted') === '1';
    isAudioMuted = localStorage.getItem('ts_audio_muted') === '1';
} catch (e) {}
function storeMuteState() {
    try {
        localStorage.setItem('ts_mic_muted', isMicMuted ? '1' : '0');
        localStorage.setItem('ts_audio_muted', isAudioMuted ? '1' : '0');
    } catch (e) {}
}

// --- ASETUKSET ---
// Per device: kept in this browser and in the bridge's settings.json (per person and device).
const DEFAULT_SETTINGS = {
    nick: '',
    inVolume: 1.0,          // voice volume, linear gain (the slider shows dB)
    outVolume: 1.0,         // microphone volume, linear gain
    vadThreshold: 0.01,     // voice activation level, 0.0 - 0.1 (RMS)
    vadTailMs: 600,         // delay before deactivation
    activation: 'vad',      // 'vad' | 'ptt' | 'continuous'
    pttKey: 'Space',        // KeyboardEvent.code
    inputDeviceId: '',      // '' = system default
    outputDeviceId: '',
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: false,
    clientVolumes: {},      // per person (TeamSpeak identity) -> their volume for you, 0 - 2
    soundsEnabled: true,    // TeamSpeak's UI sounds
    soundVolume: 0.3,       // 0 - 1 (30 % by default: TeamSpeak's files are loud)
    shareResolution: '1080', // screen sharing: the last choices
    shareFps: 30,
    shareSource: 'screen',  // 'screen' | 'camera' (camera streaming)
    cameraFacing: 'environment', // 'environment' (back) | 'user' (front)
    cameraQuality: '720',   // '480' (data saver) | '720'
    cameraSound: false,     // the camera stream carries what the microphone hears, all the time
    shareAudio: false,
    videoConnection: 'auto' // 'auto' | 'relay': streams always through the relay (when the bridge has one)
};
const SHARE_RESOLUTIONS = ['720', '1080', '1440', '2160', 'source'];
const ACTIVATIONS = ['vad', 'ptt', 'continuous'];

// Only known settings with the right type are taken (from this browser or from the bridge).
function pickSettings(src) {
    const out = {};
    if (!src || typeof src !== 'object') return out;
    for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
        const v = src[key];
        if (typeof v !== typeof def || (typeof v === 'number' && !isFinite(v))) continue;
        out[key] = v;
    }
    if (out.activation && !ACTIVATIONS.includes(out.activation)) delete out.activation;
    if (out.shareResolution && !SHARE_RESOLUTIONS.includes(out.shareResolution)) delete out.shareResolution;
    if (out.shareFps && ![30, 60].includes(out.shareFps)) delete out.shareFps;
    if (out.shareSource && !['screen', 'camera'].includes(out.shareSource)) delete out.shareSource;
    if (out.cameraFacing && !['environment', 'user'].includes(out.cameraFacing)) delete out.cameraFacing;
    if (out.cameraQuality && !['480', '720'].includes(out.cameraQuality)) delete out.cameraQuality;
    if (out.videoConnection && !['auto', 'relay'].includes(out.videoConnection)) delete out.videoConnection;
    if ('clientVolumes' in out) {
        const clean = {};
        if (out.clientVolumes && !Array.isArray(out.clientVolumes)) {
            for (const [uid, vol] of Object.entries(out.clientVolumes).slice(0, 500)) {
                if (uid.length <= 64 && typeof vol === 'number' && isFinite(vol) && vol >= 0 && vol <= 2) clean[uid] = vol;
            }
        }
        out.clientVolumes = clean;
    }
    return out;
}

function loadLocalSettings() {
    const s = { ...DEFAULT_SETTINGS, clientVolumes: {} };
    try {
        const saved = JSON.parse(localStorage.getItem('ts_settings') || 'null');
        if (saved) {
            Object.assign(s, pickSettings(saved));
        } else {
            // Older versions kept each value under its own key.
            s.nick = localStorage.getItem('ts_nick') || '';
            for (const [key, name] of [['ts_in_vol', 'inVolume'], ['ts_out_vol', 'outVolume'], ['ts_vad', 'vadThreshold']]) {
                const v = parseFloat(localStorage.getItem(key));
                if (isFinite(v)) s[name] = v;
            }
        }
    } catch (e) {}
    return s;
}

let appSettings = loadLocalSettings();

function storeSettings() {
    try { localStorage.setItem('ts_settings', JSON.stringify(appSettings)); } catch (e) {}
    if (socket && socket.connected) socket.emit('save-settings', { deviceId, settings: appSettings });
}

const dbToGain = (db) => Math.pow(10, db / 20);
const gainToDb = (gain) => (gain > 0 ? Math.max(-20, Math.min(12, Math.round(20 * Math.log10(gain)))) : -20);

// ============================================
// VOICE ENGINE (NATIVE WEBCODECS API)
// ============================================
let audioCtx = null;
let micStream = null;
let audioEncoder = null;

const decoders = new Map();
const nextPlayTimes = new Map();
const decoderClids = new Map(); // producerId -> the speaker's clid
const speakerGains = new Map(); // clid -> GainNode: the person's volume for you
let masterInGain = null; // The incoming voices' main gain: every voice goes through it (the voice volume)
let isSpeakingVAD = false; // true while our voice is being sent
const talkTimers = new Map(); // Other speakers' glow timers
let lastSpeechTime = 0;       // The last moment the voice crossed the threshold
let pttKeyHeld = false;
let pttButtonHeld = false;
let isMicTesting = false;     // "Start test": the meter runs and you hear yourself, nothing is sent
let micTestMonitor = null;
let captureCleanup = null;    // stops the running capture loop
let captureCtx = null;        // Firefox: an audio engine at the microphone's own rate, when it isn't 48 kHz
let captureGeneration = 0;    // a capture that finishes starting after a stop is thrown away
let captureTask = Promise.resolve();

// The browser can send the voice to a chosen output device (Chrome and Edge on a PC).
const canPickOutput = !!(window.AudioContext && typeof AudioContext.prototype.setSinkId === 'function');

function setOutputDevice(id) {
    if (!canPickOutput) return;
    [audioCtx, soundCtx].filter(Boolean).forEach((ctx) => {
        ctx.setSinkId(id || '').catch((e) => console.warn('[Voice] Output device not available:', e.message));
    });
}

// ============================================
// UI SOUNDS: TeamSpeak's own sound pack, served by the bridge to signed-in users (/sounds/)
// ============================================
// A separate audio engine, so a sound still plays while the voice engine closes (e.g. "connection lost").
let soundCtx = null;
const soundBuffers = new Map(); // name -> Promise<AudioBuffer | null>

function ensureSoundCtx() {
    if (!soundCtx) {
        soundCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (canPickOutput && appSettings.outputDeviceId) soundCtx.setSinkId(appSettings.outputDeviceId).catch(() => {});
    }
    if (soundCtx.state === 'suspended') soundCtx.resume().catch(() => {});
    return soundCtx;
}

function loadSound(name) {
    if (!soundBuffers.has(name)) {
        soundBuffers.set(name, fetch(`/sounds/${name}.wav`, { credentials: 'same-origin' })
            .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`HTTP ${res.status}`))))
            .then((data) => ensureSoundCtx().decodeAudioData(data))
            .catch((e) => {
                console.warn(`[Sounds] ${name} not available:`, e.message);
                soundBuffers.delete(name);
                return null;
            }));
    }
    return soundBuffers.get(name);
}

// Plays a sound at the sound volume (or at the given gain, for the test sound). With the speakers muted only
// the "sound muted" cue itself plays. Resolves false if the sound isn't available.
async function playUiSound(name, gain) {
    if (gain === undefined) {
        if (!appSettings.soundsEnabled) return false;
        if (isAudioMuted && name !== 'sound_muted') return false;
    }
    const buffer = await loadSound(name);
    if (!buffer) return false;
    const ctx = ensureSoundCtx();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const out = ctx.createGain();
    out.gain.value = gain === undefined ? appSettings.soundVolume : gain;
    source.connect(out);
    out.connect(ctx.destination);
    source.onended = () => out.disconnect();
    source.start();
    return true;
}

// The playback side: the audio engine and the voice volume. Works without a microphone too.
function ensurePlayback() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    if (!masterInGain) {
        masterInGain = audioCtx.createGain();
        masterInGain.connect(audioCtx.destination);
        if (appSettings.outputDeviceId) setOutputDevice(appSettings.outputDeviceId);
    }
    masterInGain.gain.value = isAudioMuted ? 0 : appSettings.inVolume;
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
}

// The level of PCM audio (for the activation threshold) and the output volume
function processAudioFrame(f32Array) {
    let sumSquares = 0;

    // 1. The raw RMS (the threshold check comes before the volume)
    for (let i = 0; i < f32Array.length; i++) {
        sumSquares += f32Array[i] * f32Array[i];
    }
    const rawRms = Math.sqrt(sumSquares / f32Array.length);

    // 2. The output volume only after that
    const gain = isMicTesting ? Number(inputOutVol.value) : appSettings.outVolume;
    for (let i = 0; i < f32Array.length; i++) {
        f32Array[i] *= gain;
    }

    return { modifiedData: f32Array, rms: rawRms };
}

// Shows talking in the tree at once
function setTalkingState(clid, isTalking) {
    const userDiv = document.getElementById(`ts-user-${clid}`);
    if (!userDiv) return;

    if (isTalking) {
        userDiv.classList.add('is-talking');
    } else {
        userDiv.classList.remove('is-talking');
    }
}

// Is the microphone "on" for this frame, by the activation mode? While the settings are open, the
// threshold and the delay being tried there count, so the meter shows what they would do.
function isVoiceActive(rms) {
    const testing = settingsModal.classList.contains('active');
    const activation = testing ? selectedActivation() : appSettings.activation;
    if (activation === 'continuous') return true;
    if (activation === 'ptt') return pttKeyHeld || pttButtonHeld;
    const threshold = testing ? Number(inputVad.value) : appSettings.vadThreshold;
    const tail = testing ? Number(inputTail.value) * 1000 : appSettings.vadTailMs;
    const now = Date.now();
    if (rms >= threshold) lastSpeechTime = now;
    return rms >= threshold || now - lastSpeechTime < tail;
}

function stopSending() {
    if (!isSpeakingVAD) return;
    wasmPending = new Float32Array(0);
    if (socket && socket.connected) socket.emit('voice-stop'); // Katkaistaan puhe TS-palvelimelta
    isSpeakingVAD = false;
    setTalkingState(selfClid, false);
    updateCameraSound();
}

// A camera stream's sound pauses while you talk to the channel (otherwise viewers hear your voice twice, a
// moment apart) and while your microphone is muted. A paused track sends silence; the stream stays up.
function updateCameraSound() {
    if (!share || !share.soundTrack) return;
    share.soundTrack.enabled = !isMicMuted && !isSpeakingVAD;
}

// One frame from the microphone: level meter, then sent if the microphone is "on" (and not a test).
// The encoder takes 48 kHz (TeamSpeak's Opus); a microphone at another rate (phones: often 44.1 or 16 kHz)
// is converted here. Linear interpolation, continued across frames so there are no clicks at the joins.
const resampler = { from: 0, pos: 0, last: 0 };
function to48k(input, rate) {
    if (rate === 48000 || !rate) return input;
    if (resampler.from !== rate) { resampler.from = rate; resampler.pos = 0; resampler.last = input[0] || 0; }
    const step = rate / 48000;                 // input samples per output sample
    const joined = new Float32Array(input.length + 1);
    joined[0] = resampler.last;                // the previous frame's last sample
    joined.set(input, 1);
    const out = new Float32Array(Math.ceil((joined.length - 1 - resampler.pos) / step) + 1);
    let n = 0;
    let pos = resampler.pos;
    while (pos < joined.length - 1) {
        const i = Math.floor(pos);
        const f = pos - i;
        out[n++] = joined[i] * (1 - f) + joined[i + 1] * f;
        pos += step;
    }
    resampler.pos = pos - (joined.length - 1);
    resampler.last = joined[joined.length - 1];
    return out.subarray(0, n);
}

// --- OPUS IN WEBASSEMBLY ---
// Firefox on Android has no WebCodecs, so it had no Opus to send or play voice with. There the page uses libopus
// in WebAssembly instead (opus-worker.js: opus-encdec 0.1.1, libopus 1.3.1, MIT/BSD, in a worker), for the same
// work: 20 ms Opus packets out, packets in to sound. The bridge sees no difference. Chrome, Edge and desktop
// Firefox keep WebCodecs. localStorage "ts_wasm_opus" = "1" forces it in any browser, for testing.
const forceWasmOpus = (() => { try { return localStorage.getItem('ts_wasm_opus') === '1'; } catch (e) { return false; } })();
const needsWasmEncoder = () => forceWasmOpus || typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined';
const needsWasmDecoder = () => forceWasmOpus || typeof AudioDecoder === 'undefined' || typeof EncodedAudioChunk === 'undefined';
let opusWorker = null;      // the worker once it says it is ready
let opusWorkerStart = null; // promise of the ready worker
function loadWasmOpus() {
    if (!opusWorkerStart) {
        opusWorkerStart = new Promise((resolve, reject) => {
            let worker;
            try { worker = new Worker('opus-worker.js'); } catch (e) { reject(e); return; }
            worker.onmessage = (event) => {
                const msg = event.data || {};
                if (msg.type === 'ready') { opusWorker = worker; resolve(worker); }
                else if (msg.type === 'encoded') onWasmEncoded(msg.packet);
                else if (msg.type === 'decoded') onWasmDecoded(msg.speaker, msg.pcm);
                else if (msg.type === 'error') {
                    streamDiagnostics('voice-error', `opus worker: ${msg.message}`);
                    if (!opusWorker) reject(new Error(msg.message));
                }
            };
            worker.onerror = (e) => {
                e.preventDefault();
                streamDiagnostics('voice-error', `opus worker failed: ${e.message || 'unknown'}`);
                if (!opusWorker) reject(new Error(e.message || "the Opus add-on didn't load"));
            };
        });
        opusWorkerStart.catch(() => { opusWorkerStart = null; }); // a later try may start it
    }
    return opusWorkerStart;
}

// Talking: the worker encodes 20 ms frames; each packet goes to the bridge like a WebCodecs one.
let wasmEncoder = null;                 // { state } while this browser uses the worker for its microphone
let wasmPending = new Float32Array(0);  // 48 kHz samples waiting for a full 20 ms frame
function wasmEncodeFloat(data) {
    const joined = new Float32Array(wasmPending.length + data.length);
    joined.set(wasmPending);
    joined.set(data, wasmPending.length);
    let pos = 0;
    while (joined.length - pos >= 960) {
        const pcm = joined.slice(pos, pos + 960);
        pos += 960;
        opusWorker.postMessage({ type: 'encode', pcm }, [pcm.buffer]);
    }
    wasmPending = joined.slice(pos);
}
function onWasmEncoded(packet) {
    // isSpeakingVAD: a packet still in the worker when the talking stopped isn't sent after the stop.
    if (wasmEncoder && isSpeakingVAD && socket && socket.connected && !isMicMuted) socket.emit('voice-out', packet);
}

// Listening: one decoder per speaker in the worker, then the same scheduling as the WebCodecs path.
function wasmDecoderFor(producerId) {
    return {
        state: 'configured',
        close() {
            this.state = 'closed';
            if (opusWorker) opusWorker.postMessage({ type: 'drop', speaker: producerId });
        }
    };
}
function playWasmVoice(packet) {
    if (!opusWorker) { loadWasmOpus().catch(() => {}); return; } // the first packets go while it starts
    const producerId = packet.producerId;
    decoderClids.set(producerId, packet.clid);
    if (!decoders.has(producerId)) decoders.set(producerId, wasmDecoderFor(producerId));
    const data = packet.data instanceof ArrayBuffer ? packet.data.slice(0) : new Uint8Array(packet.data).buffer;
    opusWorker.postMessage({ type: 'decode', speaker: producerId, packet: data }, [data]);
}
function onWasmDecoded(producerId, pcm) {
    const decoder = decoders.get(producerId);
    if (!decoder || decoder.state !== 'configured' || !audioCtx || !pcm || !pcm.length) return;
    const buffer = audioCtx.createBuffer(1, pcm.length, 48000);
    buffer.getChannelData(0).set(pcm);
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(speakerOutput(decoderClids.get(producerId))); // their volume, then the voice volume
    let pt = nextPlayTimes.get(producerId) || audioCtx.currentTime;
    if (pt < audioCtx.currentTime) pt = audioCtx.currentTime + 0.05;
    source.start(pt);
    nextPlayTimes.set(producerId, pt + buffer.duration);
}

function handleMicFrame(f32Array, sampleRate, timestamp) {
    const { modifiedData, rms } = processAudioFrame(f32Array);
    const active = isVoiceActive(rms);
    updateMeterUI(rms, active);

    // Sent (and glowing) only where we can be heard: in a channel that needs more talk power (AFK) the voice
    // would be dropped by TeamSpeak anyway.
    const encoderReady = wasmEncoder ? wasmEncoder.state === 'configured' : (audioEncoder && audioEncoder.state === 'configured');
    if (active && !isMicTesting && selfCanTalk() && encoderReady) {
        const data = to48k(modifiedData, sampleRate);
        if (wasmEncoder) {
            wasmEncodeFloat(data);
        } else {
            const audioData = new AudioData({
                format: 'f32',
                sampleRate: 48000,
                numberOfFrames: data.length,
                numberOfChannels: 1,
                timestamp,
                data
            });
            audioEncoder.encode(audioData);
            audioData.close();
        }
        if (!isSpeakingVAD) {
            isSpeakingVAD = true;
            setTalkingState(selfClid, true);
            updateCameraSound();
        }
    } else {
        stopSending();
    }
}

function micConstraints(useDefaultDevice) {
    const audio = {
        channelCount: 1,
        sampleRate: 48000,
        echoCancellation: appSettings.echoCancellation,
        noiseSuppression: appSettings.noiseSuppression,
        autoGainControl: appSettings.autoGainControl
    };
    if (appSettings.inputDeviceId && !useDefaultDevice) audio.deviceId = { exact: appSettings.inputDeviceId };
    return { audio };
}

async function startCapture() {
    const generation = captureGeneration;
    let stream;
    try {
        try {
            stream = await navigator.mediaDevices.getUserMedia(micConstraints(false));
        } catch (e) {
            if (!appSettings.inputDeviceId) throw e;
            // The chosen microphone is unplugged or gone: the default one is used instead.
            console.warn('[Voice] Chosen microphone not available, using the default:', e.message);
            stream = await navigator.mediaDevices.getUserMedia(micConstraints(true));
        }
    } catch (e) {
        console.warn('[Voice] Mic init failed:', e.message);
        return;
    }
    if (generation !== captureGeneration) {
        stream.getTracks().forEach((t) => t.stop());
        return;
    }
    micStream = stream;
    micStream.getAudioTracks().forEach((track) => { track.enabled = !isMicMuted; });

    // How the microphone starts, into the bridge's log ([Stream browser] voice-...), so a phone needs no
    // developer tools to tell what happened.
    const trackRate = (micStream.getAudioTracks()[0].getSettings() || {}).sampleRate || 0;
    streamDiagnostics('voice-start', `encoder=${typeof AudioEncoder} processor=${typeof MediaStreamTrackProcessor} mic=${trackRate || '?'}Hz ua=${navigator.userAgent.replace(/[^\w./ ();,-]/g, '').slice(0, 160)}`);

    // The browser's own Opus encoder (WebCodecs) when it has one; otherwise libopus in WebAssembly (Firefox on phones).
    let canEncode = !needsWasmEncoder();
    if (canEncode && AudioEncoder.isConfigSupported) {
        try {
            canEncode = (await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 48000 })).supported;
        } catch (e) { canEncode = false; }
    }
    if (!canEncode) {
        try {
            await loadWasmOpus();
            wasmEncoder = { state: 'configured', close() { this.state = 'closed'; } };
            streamDiagnostics('voice-wasm', `Opus from WebAssembly (WebCodecs encoder: ${typeof AudioEncoder !== 'undefined' ? 'yes' : 'no'}, decoder: ${typeof AudioDecoder !== 'undefined' ? 'yes' : 'no'})`);
        } catch (e) {
            streamDiagnostics('voice-error', `no Opus encoder in this browser, and the add-on failed: ${e && e.message}`);
            showBanner("This browser can't send voice (the voice add-on didn't load). Reload the page, or use Chrome.", 'error');
            micStream.getTracks().forEach((t) => t.stop());
            micStream = null;
            return;
        }
    }

    try {
        ensurePlayback();

        // --- OUTGOING AUDIO ENCODER --- (the WebAssembly one is already set up when used)
        if (!wasmEncoder) audioEncoder = new AudioEncoder({
            output: (chunk) => {
                if (socket && socket.connected && !isMicMuted) {
                    const buffer = new ArrayBuffer(chunk.byteLength);
                    chunk.copyTo(buffer);
                    socket.emit('voice-out', buffer);
                }
            },
            error: (e) => {
                console.error("[Voice] Encoder error:", e);
                streamDiagnostics('voice-error', `encoder: ${e && e.message}`);
            }
        });

        if (audioEncoder) audioEncoder.configure({
            codec: 'opus',
            sampleRate: 48000,
            numberOfChannels: 1,
            bitrate: 48000,
            opus: { frameDuration: 20000 }
        });

        if (typeof MediaStreamTrackProcessor !== 'undefined') {
            const processor = new MediaStreamTrackProcessor({ track: micStream.getAudioTracks()[0] });
            const reader = processor.readable.getReader();
            captureCleanup = () => reader.cancel().catch(() => {});

            const readMic = () => reader.read().then(({ done, value }) => {
                if (done) return;
                if (!isMicMuted) {
                    const f32Array = new Float32Array(value.numberOfFrames);
                    value.copyTo(f32Array, { planeIndex: 0 });
                    handleMicFrame(f32Array, value.sampleRate, value.timestamp);
                }
                value.close();
                readMic();
            }).catch(() => {});
            readMic();
        } else {
            // Fallback (Firefox). Firefox won't connect a microphone at another rate than the audio
            // engine's (48 kHz here): then the microphone gets an engine of its own rate, and to48k converts.
            let ctx = audioCtx;
            let source;
            try {
                source = ctx.createMediaStreamSource(micStream);
            } catch (e) {
                streamDiagnostics('voice-rate', `mic ${trackRate || '?'}Hz vs ${ctx.sampleRate}Hz: ${e.message}; using the mic's own rate`);
                captureCtx = new (window.AudioContext || window.webkitAudioContext)(trackRate ? { sampleRate: trackRate } : {});
                ctx = captureCtx;
                if (ctx.state === 'suspended') ctx.resume().catch(() => {});
                source = ctx.createMediaStreamSource(micStream);
            }
            const scriptNode = ctx.createScriptProcessor(4096, 1, 1);
            const silentGain = ctx.createGain();
            silentGain.gain.value = 0;

            source.connect(scriptNode);
            scriptNode.connect(silentGain);
            silentGain.connect(ctx.destination);

            scriptNode.onaudioprocess = (e) => {
                if (isMicMuted) return;
                const pcmData = e.inputBuffer.getChannelData(0);
                handleMicFrame(new Float32Array(pcmData), e.inputBuffer.sampleRate, performance.now() * 1000);
            };
            captureCleanup = () => {
                scriptNode.onaudioprocess = null;
                try { source.disconnect(); scriptNode.disconnect(); silentGain.disconnect(); } catch (e) {}
                if (captureCtx) { captureCtx.close().catch(() => {}); captureCtx = null; }
            };
        }

        console.log('[Voice] Native WebCodecs Audio Pipeline + VAD Initialized!');
        streamDiagnostics('voice-ready', `${typeof MediaStreamTrackProcessor !== 'undefined' ? 'track processor' : 'script processor'} at ${(captureCtx || audioCtx).sampleRate}Hz`);
        // Device names are only given after the microphone permission.
        if (settingsModal.classList.contains('active')) fillDeviceLists();
    } catch (e) {
        console.warn('[Voice] Mic init failed:', e.message);
        streamDiagnostics('voice-error', `start: ${e.message}`);
    }
}

function stopCapture() {
    captureGeneration++;
    stopMicTest();
    stopSending();
    if (captureCleanup) { captureCleanup(); captureCleanup = null; }
    if (audioEncoder) { try { audioEncoder.close(); } catch (e) {} audioEncoder = null; }
    if (wasmEncoder) { wasmEncoder.close(); wasmEncoder = null; }
    wasmPending = new Float32Array(0);
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
}

// (Re)opens the microphone with the current settings; one at a time.
function restartCapture() {
    captureTask = captureTask.then(() => { stopCapture(); return startCapture(); });
    return captureTask;
}

async function initMic() {
    ensurePlayback();
    await restartCapture();
}

function stopMic() {
    stopCapture();
    // Close every active decoder
    for (const decoder of decoders.values()) {
        try { decoder.close(); } catch (e) {}
    }
    decoders.clear();
    nextPlayTimes.clear();
    speakerGains.clear();

    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    masterInGain = null;
}

// Per-person volume: each speaker's voice goes through their own gain, then the voice volume.
function clientByClid(clid) {
    return latestState ? (latestState.clients || []).find((c) => c.clid === clid) : undefined;
}
// The bridge says whether we can be heard in our channel; until it does (or with an older bridge), yes.
function selfCanTalk() {
    const me = clientByClid(selfClid);
    return !me || me.canTalk !== false;
}
function personVolume(uid) {
    const v = uid ? appSettings.clientVolumes[uid] : undefined;
    return typeof v === 'number' ? v : 1;
}
function speakerOutput(clid) {
    if (!masterInGain) return audioCtx.destination;
    let node = speakerGains.get(clid);
    if (!node || node.context !== audioCtx) {
        node = audioCtx.createGain();
        node.connect(masterInGain);
        speakerGains.set(clid, node);
    }
    const person = clientByClid(clid);
    node.gain.value = personVolume(person && person.uid);
    return node;
}

// ============================================
// PUSH-TO-TALK
// ============================================
// The key works while this page is the active window (a browser can't hear keys in other programs).
// The "Hold to talk" button is for phones and the mouse.
function isTypingTarget(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}
function keyLabel(code) {
    return (code || '').replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ') || '?';
}
const pttBtn = document.getElementById('ptt-btn');
// A touch-only device (a phone): no hover and a coarse pointer, so no keyboard to speak of.
const touchOnly = !!(window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
function showPttState() {
    pttBtn.classList.toggle('hidden', appSettings.activation !== 'ptt');
    pttBtn.classList.toggle('held', pttKeyHeld || pttButtonHeld);
    pttBtn.title = `Hold to talk (or hold ${keyLabel(appSettings.pttKey)} while this page is active)`;
}
let capturingPttKey = false;
document.addEventListener('keydown', (e) => {
    if (capturingPttKey) return; // the settings window is picking a key
    if (appSettings.activation !== 'ptt' || e.code !== appSettings.pttKey || isTypingTarget(e.target)) return;
    e.preventDefault();
    if (!pttKeyHeld) { pttKeyHeld = true; showPttState(); }
});
document.addEventListener('keyup', (e) => {
    if (e.code !== appSettings.pttKey || !pttKeyHeld) return;
    pttKeyHeld = false;
    showPttState();
});
// Switching to another window doesn't deliver the key's release: let go there.
window.addEventListener('blur', () => {
    if (!pttKeyHeld && !pttButtonHeld) return;
    pttKeyHeld = false;
    pttButtonHeld = false;
    showPttState();
});
pttBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { pttBtn.setPointerCapture(e.pointerId); } catch (err) {}
    pttButtonHeld = true;
    showPttState();
});
['pointerup', 'pointercancel', 'lostpointercapture'].forEach((type) => pttBtn.addEventListener(type, () => {
    if (!pttButtonHeld) return;
    pttButtonHeld = false;
    showPttState();
}));
pttBtn.addEventListener('contextmenu', (e) => e.preventDefault());

// ============================================
// UI EVENT LISTENERS
// ============================================
document.getElementById('toggle-mic').classList.toggle('muted', isMicMuted);
document.getElementById('toggle-audio').classList.toggle('muted', isAudioMuted);

document.getElementById('toggle-mic').addEventListener('click', function() {
    isMicMuted = !isMicMuted;
    this.classList.toggle('muted', isMicMuted);
    storeMuteState();

    // --- Muting the physical microphone ---
    // This stops the device itself, and the system's "microphone in use" light.
    // From here on the browser hands the code nothing but silence.
    if (micStream) {
        micStream.getAudioTracks().forEach(track => {
            track.enabled = !isMicMuted;
        });
    }

    playUiSound(isMicMuted ? 'mic_muted' : 'mic_activated');
    updateCameraSound();

    // Tell the TeamSpeak server about the mute
    socket.emit('client-update', { inputMuted: isMicMuted });

    if (isMicMuted) {
        stopSending();
        socket.emit('voice-stop');
    }
});

document.getElementById('toggle-audio').addEventListener('click', function() {
    isAudioMuted = !isAudioMuted;
    this.classList.toggle('muted', isAudioMuted);
    storeMuteState();

    playUiSound(isAudioMuted ? 'sound_muted' : 'sound_resumed');

    // Tell the TeamSpeak server about the sound mute
    socket.emit('client-update', { outputMuted: isAudioMuted });

    if (masterInGain) {
        masterInGain.gain.value = isAudioMuted ? 0 : appSettings.inVolume;
    }
});

// ============================================
// Logout
// ============================================
// Valikon avaaminen/sulkeminen
const userMenuBtn = document.getElementById('user-menu-btn');
const userDropdown = document.getElementById('user-dropdown');

userMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    userDropdown.classList.toggle('hidden');
});

// A click elsewhere closes the menu
document.addEventListener('click', () => {
    if (!userDropdown.classList.contains('hidden')) {
        userDropdown.classList.add('hidden');
    }
});

// Sign out: only when the bridge names a sign-out address (LOGOUT_URL; with Cloudflare Access, Access's own).
let logoutUrl = '';

// Several servers (servers.json): the one picked on this device (or in the address, ?server=), else the list first.
// Picking another one loads the page again, so the tree, chat and streams all start clean for it; this tab's chat
// copy is kept per server.
let chosenServer = '';
try { chosenServer = new URLSearchParams(location.search).get('server') || localStorage.getItem('webts_server') || ''; } catch (e) {}
let SERVER_SCOPE = chosenServer ? ':' + chosenServer : '';
let serverList = [];                    // [{ id, name }], only when there are several
const serverPicker = document.getElementById('server-picker');
function showServerPicker(canClose) {
    const list = document.getElementById('server-picker-list');
    list.innerHTML = '';
    serverList.forEach((s) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'server-choice' + (s.id === chosenServer && canClose ? ' current' : '');
        b.textContent = s.name;
        b.addEventListener('click', () => chooseServer(s.id));
        list.appendChild(b);
    });
    document.getElementById('server-picker-close').hidden = !canClose;
    serverPicker.dataset.closable = canClose ? '1' : '';
    if (!canClose) { // not connected anywhere yet: say so, not "Connecting..."
        hideBanner();
        tsContent.innerHTML = '<div class="ts-loading">Choose a server</div>';
    }
    serverPicker.classList.add('active');
}
function chooseServer(id) {
    if (id === chosenServer && socket.connected) { serverPicker.classList.remove('active'); return; }
    let remembered = false;
    try { localStorage.setItem('webts_server', id); remembered = localStorage.getItem('webts_server') === id; } catch (e) {}
    stopMic();
    socket.disconnect();
    if (remembered && !new URLSearchParams(location.search).has('server')) location.reload();
    else location.search = '?server=' + encodeURIComponent(id); // without storage: in the address
}
document.getElementById('server-picker-close').addEventListener('click', () => serverPicker.classList.remove('active'));
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && serverPicker.dataset.closable) serverPicker.classList.remove('active');
});
document.getElementById('server-switch').addEventListener('click', () => showServerPicker(true));

// ============================================
// CONNECT ANYWHERE (the bridge's ALLOW_ANY_SERVER)
// ============================================
// People type a server's address (and its password, if it has one) in the connect window, or pick a favourite or one of
// the suggested servers. Favourites are kept by the bridge, so they follow the person to their other devices; one of
// them (★) is connected to when the page opens. Server passwords stay in this browser: for this tab while it's open, and
// for good only when "Remember the password" is ticked. This tab's choice survives reloads (sessionStorage).
let anyServer = false;
let favorites = [];        // [{ address, name, auto }]
let connectAuth = {};      // { address, password } for a typed server, sent when connecting (not in the address bar)
let currentAddress = '';   // the typed server this page is on, as the bridge writes it
let everConnected = false;
const connectModal = document.getElementById('connect-modal');
const connectAddress = document.getElementById('connect-address');
const connectPassword = document.getElementById('connect-password');

function savedPasswords() {
    try { return JSON.parse(localStorage.getItem('webts_passwords') || '{}') || {}; } catch (e) { return {}; }
}
function rememberPassword(address, password, keep) {
    const all = savedPasswords();
    if (keep && password) all[address] = password;
    else delete all[address];
    try { localStorage.setItem('webts_passwords', JSON.stringify(all)); } catch (e) {}
}
// As the bridge writes addresses: lower case, the default port left out.
const plainAddress = (a) => String(a || '').trim().toLowerCase().replace(/^(\[[^\]]+\]|[^:]+):9987$/, '$1');

// Connecting to a favourite: its address, the password kept in this browser, and the nickname set for it.
const favoriteChoice = (f) => ({ address: f.address, password: savedPasswords()[f.address] || '', nick: f.nick || '' });

// This tab's chat copy follows the server it's on.
function useServerScope(scope) {
    if (scope === SERVER_SCOPE) return;
    SERVER_SCOPE = scope;
    try { localChatHistory = JSON.parse(sessionStorage.getItem('ts_chat_history' + scope) || '{}') || {}; } catch (e) { localChatHistory = {}; }
    try { privateTabs = JSON.parse(sessionStorage.getItem('ts_private_tabs' + scope) || '{}') || {}; } catch (e) { privateTabs = {}; }
}

// Connect to a typed server ({ address, password }) or a suggested one ({ server }). Already on a server: the page
// loads again for the new one, so its tree, chat and streams start clean.
function connectTo(choice) {
    try { sessionStorage.setItem('webts_choice', JSON.stringify(choice)); } catch (e) {}
    if (everConnected || socket.connected) {
        stopMic();
        socket.disconnect();
        location.reload();
        return;
    }
    connectModal.classList.remove('active');
    startOn(choice);
}
function startOn(choice) {
    if (choice.address) {
        connectAuth = { address: choice.address, password: choice.password || '' };
        currentAddress = plainAddress(choice.address);
        useServerScope(':addr:' + currentAddress);
        socket.io.opts.query = { nick: choice.nick || appSettings.nick }; // a favourite's own nickname, if it has one
    } else {
        connectAuth = {};
        currentAddress = '';
        chosenServer = choice.server;
        useServerScope(':' + choice.server);
        socket.io.opts.query = { nick: appSettings.nick, server: choice.server };
    }
    socket.connect();
}

async function loadFavorites() {
    try {
        const r = await fetch('/favorites', { credentials: 'same-origin', cache: 'no-store' });
        if (r.ok) favorites = (await r.json()).favorites || [];
    } catch (e) {}
}
// Saves the whole list; true when the bridge took it (it answers with the list as kept).
async function saveFavorites(list, quiet) {
    let ok = false;
    try {
        const r = await fetch('/favorites', {
            method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ favorites: list })
        });
        if (r.ok) { favorites = (await r.json()).favorites || []; ok = true; }
    } catch (e) {}
    if (!ok && !quiet) showBanner("The favourites couldn't be saved.", 'error', null, { hideAfterMs: 6000 });
    renderServerMenu();
    renderConnectLists();
    return ok;
}

function showConnect(canClose, error, address) {
    document.getElementById('connect-close').hidden = !canClose;
    connectModal.dataset.closable = canClose ? '1' : '';
    const err = document.getElementById('connect-error');
    err.textContent = error || '';
    err.hidden = !error;
    if (address !== undefined) connectAddress.value = address;
    const known = savedPasswords()[plainAddress(connectAddress.value)];
    connectPassword.value = known || (address && connectAuth.address === address ? connectAuth.password || '' : '');
    document.getElementById('connect-remember').checked = !!known;
    document.getElementById('connect-favorite').checked = false;
    document.getElementById('connect-favorite-row').hidden = favorites.some((f) => f.address === plainAddress(connectAddress.value));
    renderConnectLists();
    if (!canClose && !everConnected) { // not on any server yet: say so, not "Connecting..."
        hideBanner();
        tsContent.innerHTML = '<div class="ts-loading">Choose a server</div>';
    }
    connectModal.classList.add('active');
    setTimeout(() => connectAddress.focus(), 50);
}
function closeConnect() { connectModal.classList.remove('active'); }

function renderConnectLists() {
    const favEl = document.getElementById('connect-favorites');
    favEl.innerHTML = '';
    if (favorites.length) {
        const h = document.createElement('div');
        h.className = 'connect-heading';
        h.textContent = 'Favourites';
        favEl.appendChild(h);
    }
    favorites.forEach((f) => {
        const row = document.createElement('div');
        row.className = 'fav-row';
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'server-choice' + (f.address === currentAddress && everConnected ? ' current' : '');
        go.textContent = f.name || f.address;
        go.title = `${f.address} (right-click to edit)`;
        go.addEventListener('click', () => connectTo(favoriteChoice(f)));
        go.addEventListener('contextmenu', (e) => { e.preventDefault(); editFavorite(f); });
        const pen = document.createElement('button');
        pen.type = 'button';
        pen.className = 'fav-btn';
        pen.textContent = '✎';
        pen.title = 'Edit: name, address, nickname, password';
        pen.addEventListener('click', () => editFavorite(f));
        const star = document.createElement('button');
        star.type = 'button';
        star.className = 'fav-btn' + (f.auto ? ' on' : '');
        star.textContent = f.auto ? '★' : '☆';
        star.title = f.auto ? 'Connects automatically when WebTS opens (click to stop)' : 'Connect to this one automatically when WebTS opens';
        star.addEventListener('click', () => saveFavorites(favorites.map((x) => ({ ...x, auto: x.address === f.address ? !f.auto : false }))));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'fav-btn';
        remove.textContent = '×';
        remove.title = 'Remove from favourites';
        remove.addEventListener('click', () => saveFavorites(favorites.filter((x) => x.address !== f.address)));
        row.append(go, pen, star, remove);
        favEl.appendChild(row);
    });
    const srvEl = document.getElementById('connect-servers');
    srvEl.innerHTML = '';
    if (serverList.length) {
        const h = document.createElement('div');
        h.className = 'connect-heading';
        h.textContent = 'Servers';
        srvEl.appendChild(h);
    }
    serverList.forEach((s) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'server-choice' + (!currentAddress && s.id === chosenServer && everConnected ? ' current' : '');
        b.textContent = s.name;
        b.addEventListener('click', () => connectTo({ server: s.id }));
        srvEl.appendChild(b);
    });
}

// The menu: the favourites (one click connects), "Connect to...", and adding the server you're on.
function renderServerMenu() {
    const box = document.getElementById('menu-servers');
    box.innerHTML = '';
    if (!anyServer) return;
    const item = (text, onClick, title) => {
        const b = document.createElement('button');
        b.className = 'ts-dropdown-item';
        b.textContent = text;
        if (title) b.title = title;
        b.addEventListener('click', onClick);
        box.appendChild(b);
        return b;
    };
    favorites.forEach((f) => {
        const b = item((f.address === currentAddress ? '● ' : '★ ') + (f.name || f.address), () => connectTo(favoriteChoice(f)),
            `${f.address} (right-click to edit)`);
        b.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); editFavorite(f); });
    });
    item('Connect to...', () => showConnect(true, '', ''));
    if (currentAddress && everConnected && !favorites.some((f) => f.address === currentAddress)) {
        item('☆ Add to favourites', () => saveFavorites([...favorites, { address: currentAddress, name: '', auto: false }]));
    }
}

document.getElementById('connect-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const address = connectAddress.value.trim();
    if (!address) return connectAddress.focus();
    const password = connectPassword.value;
    rememberPassword(plainAddress(address), password, document.getElementById('connect-remember').checked);
    if (document.getElementById('connect-favorite').checked && !favorites.some((f) => f.address === plainAddress(address))) {
        await saveFavorites([...favorites, { address, name: '', auto: false }]);
    }
    connectTo({ address, password });
});
connectAddress.addEventListener('input', () => {
    const known = savedPasswords()[plainAddress(connectAddress.value)];
    if (known) { connectPassword.value = known; document.getElementById('connect-remember').checked = true; }
    document.getElementById('connect-favorite-row').hidden = favorites.some((f) => f.address === plainAddress(connectAddress.value));
});
document.getElementById('connect-close').addEventListener('click', closeConnect);

// Editing a favourite (right-click it, here or in the menu, or its ✎): its name, address, the nickname used there, the
// password (kept in this browser only) and whether it connects when WebTS opens. Changing the one you're on reconnects.
const favModal = document.getElementById('fav-modal');
let favEditing = null; // the favourite's address when the window opened
function editFavorite(f) {
    favEditing = f.address;
    document.getElementById('fav-name').value = f.name || '';
    document.getElementById('fav-name').placeholder = f.address;
    document.getElementById('fav-address').value = f.address;
    document.getElementById('fav-nick').value = f.nick || '';
    document.getElementById('fav-nick').placeholder = appSettings.nick || 'Your usual nickname';
    document.getElementById('fav-password').value = savedPasswords()[f.address] || '';
    document.getElementById('fav-auto').checked = !!f.auto;
    const err = document.getElementById('fav-error');
    err.textContent = '';
    err.hidden = true;
    userDropdown.classList.add('hidden');
    favModal.classList.add('active');
    setTimeout(() => document.getElementById('fav-name').focus(), 50);
}
function closeFavEdit() {
    favModal.classList.remove('active');
    favEditing = null;
}
document.getElementById('fav-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const old = favorites.find((x) => x.address === favEditing);
    if (!old) return closeFavEdit();
    const address = document.getElementById('fav-address').value.trim();
    const password = document.getElementById('fav-password').value;
    const passwordChanged = password !== (savedPasswords()[old.address] || '');
    const updated = {
        address,
        name: document.getElementById('fav-name').value.trim(),
        nick: document.getElementById('fav-nick').value.trim(),
        auto: document.getElementById('fav-auto').checked
    };
    const at = favorites.indexOf(old);
    const list = favorites.map((x) => (x === old ? updated : updated.auto ? { ...x, auto: false } : x));
    if (!(await saveFavorites(list, true))) {
        const err = document.getElementById('fav-error');
        err.textContent = "That couldn't be saved. Check the address (e.g. ts.example.com or 203.0.113.7:9987).";
        err.hidden = false;
        return;
    }
    const saved = favorites.find((x) => x.address === plainAddress(address)) || favorites[at];
    if (!saved) return closeFavEdit();
    if (saved.address !== old.address) rememberPassword(old.address, '', false);
    rememberPassword(saved.address, password, !!password);
    closeFavEdit();
    if (everConnected && old.address === currentAddress
        && (saved.address !== old.address || saved.nick !== (old.nick || '') || passwordChanged)) {
        connectTo(favoriteChoice(saved));
    }
});
document.getElementById('fav-delete').addEventListener('click', async () => {
    const address = favEditing;
    if (!address) return closeFavEdit();
    if (await saveFavorites(favorites.filter((x) => x.address !== address))) rememberPassword(address, '', false);
    closeFavEdit();
});
document.getElementById('fav-cancel').addEventListener('click', closeFavEdit);
document.getElementById('fav-close').addEventListener('click', closeFavEdit);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && favModal.classList.contains('active')) closeFavEdit();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && connectModal.dataset.closable) closeConnect();
});
document.getElementById('logout-btn').addEventListener('click', () => {
    if (!logoutUrl) return;
    stopMic();
    socket.disconnect();
    sessionStorage.clear(); // this tab's chat history
    window.location.href = logoutUrl;
});

// ============================================
// SETTINGS MODAL LOGIC (General / Playback / Capture)
// ============================================
const settingsModal = document.getElementById('settings-modal');
const openSettingsBtn = document.getElementById('open-settings');
const closeSettingsBtn = document.getElementById('close-settings');
const saveSettingsBtn = document.getElementById('save-settings');

// Inputs
const inputNick = document.getElementById('setting-nick');
const inputInVol = document.getElementById('setting-in-vol');       // voice volume in dB
const inputOutVol = document.getElementById('setting-out-vol');     // microphone volume
const inputVad = document.getElementById('setting-vad');
const inputTail = document.getElementById('setting-tail');          // seconds
const selectOutput = document.getElementById('setting-output-device');
const selectInput = document.getElementById('setting-input-device');
const pttKeyBtn = document.getElementById('setting-ptt-key');
const checkNoise = document.getElementById('setting-noise');
const checkEcho = document.getElementById('setting-echo');
const checkAgc = document.getElementById('setting-agc');
const micTestBtn = document.getElementById('mic-test');
const activationInputs = [...document.querySelectorAll('input[name="activation"]')];
const checkSounds = document.getElementById('setting-sounds');
const inputSoundVol = document.getElementById('setting-sound-vol');
const selectVideoConnection = document.getElementById('setting-video-connection');
let pendingPttKey = appSettings.pttKey;

// The microphone level meter
const meterFill = document.getElementById('vad-meter-fill');
const thresholdLine = document.getElementById('vad-threshold-line');

// Labels
const valInVol = document.getElementById('val-in-vol');
const valOutVol = document.getElementById('val-out-vol');
const valVad = document.getElementById('val-vad');
const valTail = document.getElementById('val-tail');

function selectedActivation() {
    const checked = activationInputs.find((el) => el.checked);
    return checked ? checked.value : appSettings.activation;
}

function updateSettingLabels() {
    const db = Number(inputInVol.value);
    valInVol.innerText = `${db > 0 ? '+' : ''}${db} dB`;
    valOutVol.innerText = Math.round(inputOutVol.value * 100) + '%';
    valVad.innerText = (inputVad.value * 100).toFixed(1) + '%';
    valTail.innerText = Number(inputTail.value).toFixed(1) + ' s';
    document.getElementById('val-sound-vol').innerText = Math.round(inputSoundVol.value * 100) + '%';
    pttKeyBtn.innerText = capturingPttKey ? 'Press a key…' : keyLabel(pendingPttKey);

    // Move the threshold line (0-0.1 scaled to 100 %)
    const activation = selectedActivation();
    if (thresholdLine) {
        const percent = (inputVad.value / 0.1) * 100;
        thresholdLine.style.left = Math.min(percent, 100) + '%';
        thresholdLine.style.display = activation === 'vad' ? '' : 'none';
    }
    document.getElementById('vad-group').classList.toggle('hidden', activation !== 'vad');
    document.getElementById('ptt-group').classList.toggle('hidden', activation !== 'ptt');
    // A phone has no keyboard: only the "Hold to talk" button there.
    pttKeyBtn.closest('label').classList.toggle('hidden', touchOnly);
    document.getElementById('ptt-key-desc').classList.toggle('hidden', touchOnly);
    document.getElementById('ptt-touch-desc').classList.toggle('hidden', !touchOnly);
}

// Called from the audio loop to draw the meter
function updateMeterUI(rms, isSpeaking) {
    if (settingsModal.classList.contains('active') && meterFill) {
        const percent = Math.min((rms / 0.1) * 100, 100);
        meterFill.style.width = percent + '%';
        // Blue while the microphone is "on", green otherwise
        meterFill.style.backgroundColor = isSpeaking ? '#38bdf8' : '#22c55e';
    }
}

// The device lists. Names show only after the microphone permission; '' = the system's default.
function fillSelect(select, devices, value) {
    select.innerHTML = '';
    const add = (id, label) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = label;
        select.appendChild(opt);
    };
    add('', 'System default');
    devices
        .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .forEach((d, i) => add(d.deviceId, d.label || `Device ${i + 1}`));
    if (value && ![...select.options].some((o) => o.value === value)) add(value, 'Saved device (not connected)');
    select.value = value;
}
async function fillDeviceLists() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        fillSelect(selectInput, devices.filter((d) => d.kind === 'audioinput'), selectInput.dataset.value ?? appSettings.inputDeviceId);
        if (canPickOutput) fillSelect(selectOutput, devices.filter((d) => d.kind === 'audiooutput'), selectOutput.dataset.value ?? appSettings.outputDeviceId);
    } catch (e) {
        console.warn('[Settings] Device list not available:', e.message);
    }
}
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
        if (settingsModal.classList.contains('active')) fillDeviceLists();
    });
}
selectInput.addEventListener('change', () => { selectInput.dataset.value = selectInput.value; });
// The output device is tried right away (the test sound plays there); closing without saving puts it back.
selectOutput.addEventListener('change', () => {
    selectOutput.dataset.value = selectOutput.value;
    setOutputDevice(selectOutput.value);
});
document.getElementById('output-device-group').classList.toggle('hidden', !canPickOutput);
document.getElementById('output-device-note').classList.toggle('hidden', canPickOutput);

// Tabs
const settingsTabs = [...document.querySelectorAll('.settings-tab')];
function showSettingsTab(name) {
    settingsTabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
    document.querySelectorAll('.settings-page').forEach((page) => page.classList.toggle('hidden', page.dataset.page !== name));
}
settingsTabs.forEach((tab) => tab.addEventListener('click', () => showSettingsTab(tab.dataset.tab)));

// "Play test sound": a short chime at the voice volume being tried, on the chosen output.
document.getElementById('play-test-sound').addEventListener('click', async () => {
    if (await playUiSound('testsound', dbToGain(Number(inputInVol.value)))) return;
    const ctx = ensurePlayback();
    const out = ctx.createGain();
    out.gain.value = dbToGain(Number(inputInVol.value));
    out.connect(ctx.destination);
    const start = ctx.currentTime + 0.05;
    [[660, 0], [880, 0.18]].forEach(([freq, delay]) => {
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        env.gain.setValueAtTime(0.0001, start + delay);
        env.gain.exponentialRampToValueAtTime(0.3, start + delay + 0.02);
        env.gain.exponentialRampToValueAtTime(0.0001, start + delay + 0.4);
        osc.connect(env);
        env.connect(out);
        osc.start(start + delay);
        osc.stop(start + delay + 0.45);
    });
    setTimeout(() => out.disconnect(), 1200);
});

// "Start test": the meter runs, you hear your own microphone, and nothing is sent.
function startMicTest() {
    if (!micStream || !audioCtx) {
        micTestBtn.innerText = 'No microphone';
        setTimeout(() => { if (!isMicTesting) micTestBtn.innerText = 'Start test'; }, 2000);
        return;
    }
    if (isMicMuted) {
        micTestBtn.innerText = 'Unmute the microphone first';
        setTimeout(() => { if (!isMicTesting) micTestBtn.innerText = 'Start test'; }, 2000);
        return;
    }
    isMicTesting = true;
    stopSending();
    const ctx = captureCtx || audioCtx;
    const source = ctx.createMediaStreamSource(micStream);
    const gain = ctx.createGain();
    gain.gain.value = Number(inputOutVol.value);
    source.connect(gain);
    gain.connect(ctx.destination);
    micTestMonitor = { source, gain };
    micTestBtn.innerText = 'Stop test';
    micTestBtn.classList.add('testing');
}
function stopMicTest() {
    if (micTestMonitor) {
        try { micTestMonitor.source.disconnect(); micTestMonitor.gain.disconnect(); } catch (e) {}
        micTestMonitor = null;
    }
    isMicTesting = false;
    if (micTestBtn) {
        micTestBtn.innerText = 'Start test';
        micTestBtn.classList.remove('testing');
    }
}
micTestBtn.addEventListener('click', () => (isMicTesting ? stopMicTest() : startMicTest()));
inputOutVol.addEventListener('input', () => { if (micTestMonitor) micTestMonitor.gain.gain.value = Number(inputOutVol.value); });

// Picking the push-to-talk key: the next key pressed (Esc cancels).
pttKeyBtn.addEventListener('click', () => {
    capturingPttKey = true;
    updateSettingLabels();
});
document.addEventListener('keydown', (e) => {
    if (!capturingPttKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code !== 'Escape') pendingPttKey = e.code;
    capturingPttKey = false;
    updateSettingLabels();
}, true);

function fillSettingsForm() {
    inputNick.value = appSettings.nick;
    inputInVol.value = gainToDb(appSettings.inVolume);
    inputOutVol.value = appSettings.outVolume;
    inputVad.value = appSettings.vadThreshold;
    inputTail.value = (appSettings.vadTailMs / 1000).toFixed(1);
    activationInputs.forEach((el) => { el.checked = el.value === appSettings.activation; });
    pendingPttKey = appSettings.pttKey;
    checkNoise.checked = appSettings.noiseSuppression;
    checkEcho.checked = appSettings.echoCancellation;
    checkAgc.checked = appSettings.autoGainControl;
    checkSounds.checked = appSettings.soundsEnabled;
    inputSoundVol.value = appSettings.soundVolume;
    selectVideoConnection.value = appSettings.videoConnection;
    delete selectInput.dataset.value;
    delete selectOutput.dataset.value;
    updateSettingLabels();
}

function closeSettings() {
    stopMicTest();
    capturingPttKey = false;
    setOutputDevice(appSettings.outputDeviceId); // back to the saved one if another was tried
    settingsModal.classList.remove('active');
}

// Open modal and load current settings
openSettingsBtn.addEventListener('click', () => {
    fillSettingsForm();
    fillDeviceLists();
    showSettingsTab('general');
    settingsModal.classList.add('active');
});

closeSettingsBtn.addEventListener('click', closeSettings);

// Update labels dynamically while dragging sliders
[inputInVol, inputOutVol, inputVad, inputTail, inputSoundVol, ...activationInputs].forEach(el => {
    el.addEventListener('input', updateSettingLabels);
});

// Applies settings that changed (from the form or from the bridge): volumes, devices, activation.
function applySettings(before) {
    if (masterInGain) masterInGain.gain.value = isAudioMuted ? 0 : appSettings.inVolume;
    if (before.outputDeviceId !== appSettings.outputDeviceId) setOutputDevice(appSettings.outputDeviceId);
    const captureChanged = ['inputDeviceId', 'noiseSuppression', 'echoCancellation', 'autoGainControl']
        .some((key) => before[key] !== appSettings[key]);
    if (captureChanged && (micStream || audioEncoder)) restartCapture();
    if (before.activation !== appSettings.activation) {
        pttKeyHeld = false;
        pttButtonHeld = false;
        stopSending();
    }
    if (before.videoConnection !== appSettings.videoConnection) {
        refreshOpenConnections();
        showRelayInfo();
    }
    showPttState();
}

// Save & Apply
saveSettingsBtn.addEventListener('click', () => {
    const before = { ...appSettings };

    appSettings.nick = inputNick.value.trim();
    appSettings.inVolume = dbToGain(Number(inputInVol.value));
    appSettings.outVolume = parseFloat(inputOutVol.value);
    appSettings.vadThreshold = parseFloat(inputVad.value);
    appSettings.vadTailMs = Math.round(Number(inputTail.value) * 1000);
    appSettings.activation = selectedActivation();
    appSettings.pttKey = pendingPttKey;
    appSettings.inputDeviceId = selectInput.value;
    if (canPickOutput) appSettings.outputDeviceId = selectOutput.value;
    appSettings.noiseSuppression = checkNoise.checked;
    appSettings.echoCancellation = checkEcho.checked;
    appSettings.autoGainControl = checkAgc.checked;
    appSettings.soundsEnabled = checkSounds.checked;
    appSettings.soundVolume = Number(inputSoundVol.value);
    appSettings.videoConnection = selectVideoConnection.value === 'relay' ? 'relay' : 'auto';

    storeSettings();
    closeSettings();
    applySettings(before);

    // A new nickname: reconnect with it
    if (before.nick !== appSettings.nick && socket) {
        console.log("[Settings] Nickname changed. Reconnecting WebSocket...");
        socket.disconnect();
        socket.io.opts.query = { nick: appSettings.nick, server: chosenServer };
        setTimeout(() => socket.connect(), 500);
    }
});

// --- UI ELEMENTS ---
const banner = document.getElementById('connection-banner');
const chatInput = document.getElementById('chat-input');
const tsContent = document.getElementById('ts-content');
const chatMessagesEl = document.getElementById('chat-messages');
const chatHeaderEl = document.getElementById('chat-header');

// ============================================
// WEBSOCKET CONNECTION & HANDLERS
// ============================================
// The bridge serves this page, so the voice connection goes to the same address.
const SOCKET_URL = window.location.origin;

const socket = io(SOCKET_URL, {
    withCredentials: true,
    transports: ['websocket', 'polling'],
    query: { nick: appSettings.nick, server: chosenServer },
    auth: (send) => send(connectAuth), // a typed server's address and password (connect anywhere)
    autoConnect: false // first the server list (startConnection)
});

// With several servers and none picked yet (or one that's no longer offered): the list first.
(async function startConnection() {
    let info = {};
    try {
        const r = await fetch('/servers', { credentials: 'same-origin', cache: 'no-store' });
        if (r.ok) info = await r.json();
    } catch (e) {}
    const list = (info.servers || []).filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string');
    anyServer = info.anyServer === true;
    if (anyServer) {
        // This tab's server (a reload), else the favourite marked ★, else the connect window.
        serverList = list;
        await loadFavorites();
        renderServerMenu();
        let pick = null;
        try { pick = JSON.parse(sessionStorage.getItem('webts_choice') || 'null'); } catch (e) {}
        const auto = favorites.find((f) => f.auto);
        if (!pick && auto) pick = favoriteChoice(auto);
        if (pick && pick.address) return startOn(pick);
        if (pick && pick.server && list.some((s) => s.id === pick.server)) return startOn(pick);
        return showConnect(false);
    }
    if (list.length > 1) serverList = list;
    if (serverList.length > 1 && !serverList.some((s) => s.id === chosenServer)) return showServerPicker(false);
    socket.connect();
})();
socket.on('connect_error', (err) => {
    const message = (err && err.message) || '';
    if (message === 'Unknown server' && serverList.length > 1) {
        socket.disconnect();
        showServerPicker(false);
    } else if (message.startsWith('Server: ')) {
        socket.disconnect();
        showConnect(everConnected, message.slice(8), connectAuth.address || '');
    }
});

showPttState();

// The bridge's settings that the page follows: sign-out and back links, and the picture limit.
socket.on('webts-config', (cfg) => {
    if (!cfg) return;
    logoutUrl = typeof cfg.logoutUrl === 'string' ? cfg.logoutUrl : '';
    // style.display, not hidden: these elements have their own display styles, which would win over hidden.
    const show = (el, on) => {
        if (el.dataset.display === undefined) el.dataset.display = el.style.display; // its own inline display, if any
        el.hidden = !on;
        el.style.display = on ? el.dataset.display : 'none';
    };
    show(document.getElementById('logout-btn'), !!logoutUrl);
    const back = document.getElementById('back-link');
    const hasBack = typeof cfg.backUrl === 'string' && /^https?:\/\//.test(cfg.backUrl);
    if (hasBack) {
        back.href = cfg.backUrl;
        back.textContent = cfg.backLabel || 'Back';
    }
    show(back, hasBack);
    if (Array.isArray(cfg.servers) && cfg.servers.length > 1) serverList = cfg.servers;
    anyServer = cfg.anyServer === true;
    if (anyServer && typeof cfg.server === 'string' && cfg.server.startsWith('addr:')) currentAddress = cfg.server.slice(5);
    show(document.getElementById('server-switch'), !anyServer && serverList.length > 1);
    show(document.getElementById('user-menu-btn'), hasBack || !!logoutUrl || serverList.length > 1 || anyServer);
    renderServerMenu();
    picturesEnabled = cfg.picturesEnabled !== false;
    if (Number(cfg.pictureMaxMb) > 0) PICTURE_MAX_BYTES = Number(cfg.pictureMaxMb) * 1024 * 1024;
    updatePictureButton();
});

// The banner at the top: a message, optionally with a button. "Connected!" hides itself; errors stay.
// A message can be closed with its ✕; `hideAfterMs` closes it by itself; `tag` lets the page close it later
// (e.g. a share warning when the share stops).
let bannerTimer = null;
let bannerTag = null;
function showBanner(text, kind, action, options = {}) {
    clearTimeout(bannerTimer);
    bannerTag = options.tag || null;
    banner.style.display = 'block';
    banner.className = 'connection-banner' + (kind === 'success' ? ' success' : kind === 'info' ? ' info' : '');
    banner.textContent = text;
    if (action) {
        const btn = document.createElement('button');
        btn.className = 'banner-btn';
        btn.textContent = action.label;
        btn.addEventListener('click', action.onClick);
        banner.appendChild(btn);
    }
    if (kind !== 'success') {
        const close = document.createElement('button');
        close.className = 'banner-close';
        close.title = 'Close';
        close.textContent = '×';
        close.addEventListener('click', hideBanner);
        banner.appendChild(close);
    }
    if (options.hideAfterMs) bannerTimer = setTimeout(hideBanner, options.hideAfterMs);
}
function hideBanner(tag) {
    if (typeof tag === 'string' && tag !== bannerTag) return;
    clearTimeout(bannerTimer);
    bannerTag = null;
    banner.style.display = 'none';
}

// Opened on another device: the bridge closed this connection (one connection per person).
let replacedElsewhere = false;
socket.on('session-replaced', () => {
    replacedElsewhere = true;
});

socket.on('ts-sound', (name) => {
    if (typeof name === 'string' && /^[a-z_]+$/.test(name)) playUiSound(name);
});

// The bridge's TeamSpeak connection was refused because our previous one is still on the server: reconnect by
// ourselves after the given time (at most 6 times in a row, about a minute).
let retryAfterMs = 0;
let retriesInARow = 0;
socket.on('ts-retry', (data) => {
    retriesInARow++;
    retryAfterMs = (data && data.afterMs) || 10000;
    showBanner((data && data.message) || 'Trying again shortly...', 'error');
});
socket.on('ts-state', (state) => { if (state && state.connected) retriesInARow = 0; });

// Phones (Android): while the microphone is open the volume buttons change the call volume, but the voices
// follow the media volume. A web page can't change that (playing them as call audio doesn't help), so a hint, once
// per browser, and the same line in Settings > Playback. Not in Firefox: there the voices are media, so the volume
// buttons and the phone's media controls work, also in the background.
const needsMediaVolumeHint = /Android/i.test(navigator.userAgent) && !/Firefox\//.test(navigator.userAgent);
const MEDIA_VOLUME_HINT = "Can't hear anyone? Voices follow the media volume: press a volume button, then ⋮ and turn up Media.";
let mediaHintPending = needsMediaVolumeHint;
try { if (localStorage.getItem('ts_media_volume_hint') === '1') mediaHintPending = false; } catch (e) {}
socket.on('ts-state', (state) => {
    if (!mediaHintPending || !state || !state.connected) return;
    mediaHintPending = false;
    setTimeout(() => {
        if (banner.style.display !== 'none') { mediaHintPending = true; return; } // something else is shown: next time
        showBanner(MEDIA_VOLUME_HINT, 'info', null, { tag: 'media-volume' });
        try { localStorage.setItem('ts_media_volume_hint', '1'); } catch (e) {}
    }, 3000);
});
document.getElementById('media-volume-note').classList.toggle('hidden', !needsMediaVolumeHint);

socket.on('ts-error', (data) => {
    console.warn('[TeamSpeak]', data && data.message);
    showBanner((data && data.message) || "Couldn't connect to the TeamSpeak server.", 'error');
    // A typed server that refused (wrong password, not reachable...): the connect window, to fix it or pick another.
    if (anyServer && connectAuth.address) showConnect(true, (data && data.message) || '', connectAuth.address);
});

socket.on('connect', () => {
    everConnected = true;
    console.log("[WebSocket] Connected!");
    replacedElsewhere = false;
    showBanner("Connected!", 'success');

    setTimeout(() => {
        if (banner.classList.contains('success')) banner.style.display = 'none';
    }, 1500);

    socket.emit('request-state');
    if (needsWasmDecoder() || needsWasmEncoder()) loadWasmOpus().catch(() => {});

    if (audioCtx || audioEncoder) stopMic();
    initMic().catch(err => console.warn("[Voice] Mic not available:", err.message));

    socket.emit('load-settings', { deviceId: deviceId });
    relayAsked = false;
    requestRelay();
});

// Otetaan vastaan palvelimelta laitekohtaiset asetukset (the bridge's copy wins over this browser's)
socket.on('settings-loaded', (savedSettings) => {
    const saved = pickSettings(savedSettings);
    if (!Object.keys(saved).length) return;
    const before = { ...appSettings };
    Object.assign(appSettings, saved);
    if (!appSettings.nick) appSettings.nick = before.nick;
    try { localStorage.setItem('ts_settings', JSON.stringify(appSettings)); } catch (e) {}
    if (settingsModal.classList.contains('active')) fillSettingsForm();
    applySettings(before);
});

socket.on('disconnect', (reason) => {
    console.warn("[WebSocket] Connection lost:", reason);
    stopShare(true);
    if (reason !== 'io client disconnect') playUiSound(replacedElsewhere ? 'disconnected' : 'connection_lost');
    stopMic();
    closeVideoStream();
    chatInput.disabled = true;
    chatInput.placeholder = "Waiting for connection...";
    updatePictureButton();
    if (replacedElsewhere) {
        // Not reconnected by itself: the other device would be thrown out in turn.
        showBanner("You're connected on another device.", 'error', {
            label: 'Use here',
            onClick: () => { showBanner("Connecting...", 'error'); socket.connect(); }
        });
        tsContent.innerHTML = '<div class="ts-loading">Connected on another device</div>';
        return;
    }
    showBanner("Connection lost. Reconnecting...", 'error');
    tsContent.innerHTML = '<div class="ts-loading" style="color: #ef4444;">Server connection lost</div>';
    // A disconnect by the bridge isn't retried by Socket.IO itself.
    if (reason === 'io server disconnect') {
        const wait = retryAfterMs || 2000;
        retryAfterMs = 0;
        if (retriesInARow > 6) {
            showBanner("Couldn't get back into TeamSpeak. Reload the page to try again.", 'error');
            return;
        }
        setTimeout(() => { if (!socket.connected && !replacedElsewhere) socket.connect(); }, wait);
    }
});

// --- STATE MANAGEMENT ---
// --- CHAT HISTORY (Session Storage) ---
// The history stays in this tab until it is closed. When the bridge keeps a chat history (CHAT_HISTORY=on) it sends
// the days before at connect ('ts-history'); this copy is then only for reloads.
let chatKeep = 300; // lines per conversation (a bridge that keeps more raises it)
let localChatHistory = {};
try { localChatHistory = JSON.parse(sessionStorage.getItem('ts_chat_history' + SERVER_SCOPE) || '{}') || {}; } catch (e) {}

function saveChatHistory() {
    try { sessionStorage.setItem('ts_chat_history' + SERVER_SCOPE, JSON.stringify(localChatHistory)); } catch (e) {} // full: the bridge has it
}

// The chat follows the newest line while you are at the bottom; scrolled up to read older ones, a picture that
// finishes loading doesn't pull you back down.
let chatAtBottom = true;
chatMessagesEl.addEventListener('scroll', () => {
    chatAtBottom = chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight < 60;
});
function chatPictureLoaded() {
    if (chatAtBottom) chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}
// A whole conversation goes in first and scrolls down once, not once per line.
let chatBulk = false;
function renderMessages(list) {
    chatBulk = true;
    try { list.forEach((m) => renderSingleMessage(m)); } finally { chatBulk = false; }
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    chatAtBottom = true;
}

// Private chats: one tab per person, by their TeamSpeak identity (uid), so a reconnect keeps the
// conversation. History lives like the channel chat's: in this browser tab and in the bridge while it runs.
let privateTabs = {}; // uid -> { name, unread }
try { privateTabs = JSON.parse(sessionStorage.getItem('ts_private_tabs' + SERVER_SCOPE) || '{}') || {}; } catch (e) {}
function savePrivateTabs() {
    try { sessionStorage.setItem('ts_private_tabs' + SERVER_SCOPE, JSON.stringify(privateTabs)); } catch (e) {}
}
let chatView = { type: 'channel' };   // or { type: 'pm', uid }
let activeChannelName = '';
let pictureBusy = false;               // a picture is being sent
let picturesEnabled = true;            // the bridge's PICTURES setting
let pendingPicture = null;             // a pasted picture waiting for Send: { file, url }
let channelChatReady = false;          // a channel has been picked (its chat can be written to)

// Files a message under its channel or its private conversation; false if it was already there. From the history:
// no private chat tab is opened for it (opening a chat with that person shows it), and the caller sorts and trims.
function fileMessage(msg, fromHistory = false) {
    if (!msg) return null;
    let key = null;
    if (msg.targetmode === 2 && msg.cid) key = msg.cid;
    if (msg.targetmode === 1 && msg.partnerUid) {
        key = 'pm:' + msg.partnerUid;
        const tab = privateTabs[msg.partnerUid];
        if (!fromHistory) {
            if (!tab) privateTabs[msg.partnerUid] = { name: msg.partnerName || 'Private chat', unread: 0 };
            else if (msg.partnerName && !msg.outgoing) tab.name = msg.partnerName;
        }
    }
    if (key === null) return null;
    if (!localChatHistory[key]) localChatHistory[key] = [];
    // No duplicates (each message has its own id)
    if (localChatHistory[key].find(m => m.id === msg.id)) return null;
    localChatHistory[key].push(msg);
    // At most chatKeep messages per conversation
    if (!fromHistory && localChatHistory[key].length > chatKeep) localChatHistory[key].shift();
    return key;
}

function viewKey() {
    return chatView.type === 'pm' ? 'pm:' + chatView.uid : activeChannelId;
}

function clientByUid(uid) {
    return latestState ? (latestState.clients || []).find((c) => c.uid === uid && c.clid !== selfClid) : undefined;
}

// The tabs above the chat: the channel, then each private conversation (unread dot, close).
function renderChatTabs() {
    chatHeaderEl.innerHTML = '';
    const tab = (label, prefix, active, onClick) => {
        const btn = document.createElement('button');
        btn.className = 'chat-tab' + (active ? ' active' : '');
        const pre = document.createElement('span');
        pre.className = 'tab-prefix';
        pre.textContent = prefix;
        const name = document.createElement('span');
        name.textContent = label;
        btn.append(pre, name);
        btn.addEventListener('click', onClick);
        chatHeaderEl.appendChild(btn);
        return btn;
    };
    tab(activeChannelName || 'Select a channel', '#', chatView.type === 'channel', () => showChatView({ type: 'channel' }));
    Object.entries(privateTabs).forEach(([uid, info]) => {
        const btn = tab(info.name, '@', chatView.type === 'pm' && chatView.uid === uid, () => showChatView({ type: 'pm', uid }));
        if (info.unread) {
            const dot = document.createElement('span');
            dot.className = 'unread-dot';
            dot.title = `${info.unread} unread`;
            btn.appendChild(dot);
        }
        const close = document.createElement('span');
        close.className = 'tab-close';
        close.title = 'Close this chat';
        close.textContent = '×';
        close.addEventListener('click', (e) => {
            e.stopPropagation();
            delete privateTabs[uid];
            savePrivateTabs();
            if (chatView.type === 'pm' && chatView.uid === uid) showChatView({ type: 'channel' });
            else renderChatTabs();
        });
        btn.appendChild(close);
    });
}

// The message box follows the view: the channel once picked, a person only while they're online.
function updateChatInput() {
    if (!socket.connected) return;
    if (chatView.type === 'pm') {
        const info = privateTabs[chatView.uid] || {};
        const person = clientByUid(chatView.uid);
        chatInput.disabled = !person;
        chatInput.placeholder = person ? `Message to ${person.nickname}...` : `${info.name || 'They'} is offline`;
    } else {
        chatInput.disabled = !channelChatReady;
        chatInput.placeholder = channelChatReady ? `Message to ${activeChannelName}...` : 'Select a channel first...';
    }
    updatePictureButton();
}

function renderActiveChat() {
    if (chatView.type === 'pm') {
        chatMessagesEl.innerHTML = '';
        const history = localChatHistory['pm:' + chatView.uid] || [];
        if (history.length === 0) {
            chatMessagesEl.innerHTML = '<div class="chat-empty" style="color: #80848e; text-align: center; margin-top: 40px; font-size: 0.9rem;">No private messages yet.</div>';
        }
        renderMessages(history);
    } else if (activeChannelId !== null) {
        renderChatForChannel(activeChannelId);
    }
}

function showChatView(view) {
    if (view.type === 'pm' && !privateTabs[view.uid]) view = { type: 'channel' };
    chatView = view;
    if (view.type === 'pm' && privateTabs[view.uid].unread) {
        privateTabs[view.uid].unread = 0;
        savePrivateTabs();
    }
    renderChatTabs();
    renderActiveChat();
    updateChatInput();
}

function openPrivateChat(person) {
    if (!person || !person.uid) return;
    if (!privateTabs[person.uid]) privateTabs[person.uid] = { name: person.nickname, unread: 0 };
    else privateTabs[person.uid].name = person.nickname;
    savePrivateTabs();
    showChatView({ type: 'pm', uid: person.uid });
    chatInput.focus();
}

const cleanChannelName = (name) => String(name || '').replace(/^\[.*spacer.*\]/i, '');

// The channel chat is the channel we sit in, like in the desktop client: right from the start (it used to say
// "Select a channel" until one was clicked), and after any move (ours, an admin's). A channel just clicked
// gets a few seconds for the move to happen before the real channel wins again.
let pendingMoveCid = null;
let pendingMoveAt = 0;
function followOwnChannel(state) {
    const own = ownChannelId(state);
    if (own === null) return;
    if (pendingMoveCid !== null) {
        if (own !== pendingMoveCid && Date.now() - pendingMoveAt < 3000) return;
        pendingMoveCid = null;
    }
    const channel = (state.channels || []).find((c) => c.cid === own);
    const name = channel ? cleanChannelName(channel.name) : activeChannelName;
    if (own === activeChannelId && channelChatReady && name === activeChannelName) return;
    activeChannelId = own;
    activeChannelName = name;
    channelChatReady = true;
    renderChatTabs();
    if (chatView.type === 'channel') renderActiveChat();
}

// TeamSpeak shows what the page's mute buttons say: after a reload or a reconnect (a new TeamSpeak connection
// starts unmuted), and when a press came before the connection was up. Re-sent at most every 3 s.
let muteSentAt = 0;
function syncMuteToTeamSpeak(state) {
    if (!state.connected) return;
    const me = (state.clients || []).find((c) => c.clid === state.selfClid);
    if (!me) return;
    const update = {};
    if (!!me.inputMuted !== isMicMuted) update.inputMuted = isMicMuted;
    if (!!me.outputMuted !== isAudioMuted) update.outputMuted = isAudioMuted;
    if (!Object.keys(update).length || Date.now() - muteSentAt < 3000) return;
    muteSentAt = Date.now();
    socket.emit('client-update', update);
}

// --- STATE MANAGEMENT ---
socket.on('ts-state', (state) => {
    latestState = state;
    selfClid = state.selfClid || 0;
    leaveStreamIfApart(state);
    followOwnChannel(state);
    syncMuteToTeamSpeak(state);
    if (serverInfoModal.classList.contains('active')) renderServerInfo();
    // The bridge listens for the relay request only once its TeamSpeak connection is up, so the request sent at
    // connect is lost: ask again with the first state that says connected.
    if (state.connected && !relayAsked) {
        relayAsked = true;
        requestRelay();
    }

    // The bridge's history into this tab's copy
    if (state.messages) {
        let changed = false;
        state.messages.forEach(msg => { if (fileMessage(msg) !== null) changed = true; });
        if (changed) {
            saveChatHistory();
            savePrivateTabs();
            renderChatTabs();
            renderActiveChat();
        }
    }
    updateChatInput();
    renderChannelTree();
});

// The days before, from the bridge's chat history: filed like the messages, without sounds or unread marks, each
// conversation in time order.
socket.on('ts-history', (list) => {
    if (!Array.isArray(list)) return;
    const touched = new Set();
    const counts = {};
    list.forEach((m) => {
        const key = fileMessage(m, true);
        if (key !== null) touched.add(key);
        if (m) { const c = m.targetmode === 1 ? 'pm:' + m.partnerUid : m.cid; counts[c] = (counts[c] || 0) + 1; }
    });
    chatKeep = Math.max(chatKeep, ...Object.values(counts));
    if (!touched.size) return;
    touched.forEach((key) => {
        const msgs = localChatHistory[key];
        if (msgs.every((m) => typeof m.time === 'number')) msgs.sort((a, b) => a.time - b.time);
        if (msgs.length > chatKeep) msgs.splice(0, msgs.length - chatKeep);
    });
    saveChatHistory();
    renderActiveChat();
});

socket.on('ts-message', (msgObj) => {
    const key = fileMessage(msgObj);
    if (key === null) return;
    saveChatHistory();

    // A message for the conversation on screen is shown at once
    if (key === viewKey()) {
        renderSingleMessage(msgObj);
    } else if (msgObj.targetmode === 1 && !msgObj.outgoing) {
        privateTabs[msgObj.partnerUid].unread = (privateTabs[msgObj.partnerUid].unread || 0) + 1;
    }
    if (msgObj.targetmode === 1) {
        playUiSound(msgObj.outgoing ? 'chat_message_outbound' : 'chat_message_inbound');
        savePrivateTabs();
        renderChatTabs();
    } else if (msgObj.targetmode === 2 && !msgObj.event) { // a join/leave line has the bridge's own sound
        // Channel chat too, like the desktop app (only private messages had a sound).
        playUiSound(msgObj.invokerid === selfClid ? 'chat_message_outbound' : 'chat_message_inbound');
    }
});

// A join/leave line ("Alex joined coming from Gaming"), kept with the messages like the TeamSpeak app does. Names
// and channels are bold; everything goes in as text, never as HTML.
function renderEventLine(msgObj) {
    const line = document.createElement('div');
    line.className = 'chat-event';
    const time = document.createElement('span');
    time.className = 'time';
    time.innerHTML = escapeHtml(messageTime(msgObj));
    line.appendChild(time);
    (Array.isArray(msgObj.event) ? msgObj.event : []).forEach((part) => {
        if (typeof part === 'string') line.appendChild(document.createTextNode(part));
        else if (part && typeof part.b === 'string') {
            const b = document.createElement('strong');
            b.textContent = part.b;
            line.appendChild(b);
        }
    });
    const empty = chatMessagesEl.querySelector('.chat-empty');
    if (empty) empty.remove();
    chatMessagesEl.appendChild(line);
    if (!chatBulk) chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function renderSingleMessage(msgObj) {
    if (msgObj.event) return renderEventLine(msgObj);
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-msg';
    
    // The message as HTML, and its links (a file from the TeamSpeak app: one tidy line; a
    // picture from a channel's files, [img]ts3image://…[/img]: the picture)
    const fileNote = mytsFileNote(msgObj.msg);
    const { pictures, rest } = fileNote !== null ? { pictures: [], rest: '' } : channelPictures(msgObj.msg);
    const { html, urls } = fileNote !== null ? { html: fileNote, urls: [] } : parseMessage(rest);
    
    let previewHtml = pictures.map(channelPictureHtml).join('');
    
    // A preview of the first link
    if (urls.length > 0) {
        const url = urls[0];
        // A direct picture link (.jpg, .png, .gif, .webp...)
        const isImage = /\.(jpeg|jpg|gif|png|webp)(\?.*)?$/i.test(url);
        
        if (isImage) {
            // Scroll the chat down once the picture has loaded
            previewHtml += `
            <div class="chat-link-preview">
                <img src="${url}" alt="" class="chat-preview-img" referrerpolicy="no-referrer" loading="lazy" onload="chatPictureLoaded()" onerror="this.parentElement.remove()">
            </div>`;
        } else {
            // Tavallisen linkin turvallinen infokortti
            try {
                const domain = new URL(url).hostname;
                previewHtml += `
                <div class="chat-link-preview">
                    <a href="${url}" target="_blank" rel="noopener noreferrer" class="preview-card">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                        Open: ${domain}
                    </a>
                </div>`;
            } catch(e) {
                // Not a valid address: no preview
            }
        }
    }

    // The parsed message (html is safe: parseMessage escaped it)
    msgEl.innerHTML = `
        <span class="time">${escapeHtml(messageTime(msgObj))}</span>
        <span class="sender">${avatarHtml(personByUid(msgObj.invokeruid), 'chat-avatar')}${escapeHtml(msgObj.invokername || 'System')}:</span>
        <span style="word-wrap: break-word;">${html}</span>
        ${previewHtml}
    `;

    const empty = chatMessagesEl.querySelector('.chat-empty'); // "No messages yet" goes with the first message
    if (empty) empty.remove();
    chatMessagesEl.appendChild(msgEl);
    if (!chatBulk) chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function renderChatForChannel(cid) {
    chatMessagesEl.innerHTML = '';
    const history = localChatHistory[cid] || [];
    
    if (history.length === 0) {
        chatMessagesEl.innerHTML = '<div class="chat-empty" style="color: #80848e; text-align: center; margin-top: 40px; font-size: 0.9rem;">No messages in this channel yet.</div>';
        return;
    }
    
    renderMessages(history);
}

document.getElementById('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = chatInput.value.trim();
    const picture = chatView.type === 'pm' ? null : pendingPicture; // a pasted picture goes with Enter too
    if (!msg && !picture) return;
    if (msg) {
        if (chatView.type === 'pm') {
            const person = clientByUid(chatView.uid);
            if (!person) return;
            socket.emit('send-message', { msg, targetmode: 1, target: person.clid });
        } else {
            socket.emit('send-message', { msg, targetmode: 2 });
        }
        chatInput.value = '';
    }
    if (picture) sendPendingPicture();
});

// ============================================
// PICTURES IN THE CHAT
// ============================================
// The picture button (or pasting, or dropping one on the chat) sends a picture to the channel chat: chat-pictures.js
// gets it ready (full quality up to 15 MB, hidden details removed), the bridge saves it in the channel's /webTS
// folder and writes the line the TeamSpeak app shows as the picture. Sent in 256 KB parts, each answered.
const PICTURE_PART_BYTES = 256 * 1024;
let pictureStatusTimer = null;

function updatePictureButton() {
    const btn = document.getElementById('chat-picture-btn');
    if (btn) {
        btn.hidden = !picturesEnabled;
        btn.disabled = pictureBusy || chatInput.disabled || chatView.type === 'pm';
    }
    const menu = document.getElementById('chat-picture-menu');
    if (menu && btn && btn.disabled) menu.hidden = true;
    if (pendingPicture && (chatInput.disabled || chatView.type === 'pm')) clearPendingPicture();
}

// A pasted picture isn't sent at once: it waits above the message box until Send (or Enter in the box), so a
// stray Ctrl+V sends nothing. ✕ or Esc throws it away; another paste replaces it.
function stagePicture(file) {
    if (!file) return;
    if (chatView.type === 'pm' || !channelChatReady || chatInput.disabled) {
        showPictureStatus('Pictures can be sent to a channel chat.', true);
        return;
    }
    clearPendingPicture();
    pendingPicture = { file, url: URL.createObjectURL(file) };
    const box = document.getElementById('chat-picture-pending');
    const img = box.querySelector('img');
    img.hidden = false;
    img.src = pendingPicture.url;
    const mb = file.size / 1048576;
    box.querySelector('.chat-picture-pending-text').textContent =
        `Picture ready to send (${mb >= 0.1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(file.size / 1024)) + ' KB'})`;
    box.hidden = false;
}

function clearPendingPicture() {
    if (!pendingPicture) return;
    URL.revokeObjectURL(pendingPicture.url);
    pendingPicture = null;
    const box = document.getElementById('chat-picture-pending');
    box.hidden = true;
    box.querySelector('img').removeAttribute('src');
}

function sendPendingPicture() {
    if (!pendingPicture || pictureBusy) return; // one at a time: it stays waiting while another is sending
    const { file } = pendingPicture;
    clearPendingPicture();
    sendPicture(file);
}

function showPictureStatus(text, isError) {
    const el = document.getElementById('chat-picture-status');
    clearTimeout(pictureStatusTimer);
    el.textContent = text;
    el.classList.toggle('error', !!isError);
    el.hidden = false;
    if (isError) pictureStatusTimer = setTimeout(hidePictureStatus, 8000);
}

function hidePictureStatus() {
    clearTimeout(pictureStatusTimer);
    document.getElementById('chat-picture-status').hidden = true;
}

// An event the bridge answers; the connection dropping (or no answer in time) counts as an error.
function emitWithAnswer(event, data, ms = 30000) {
    return new Promise((resolve, reject) => {
        socket.timeout(ms).emit(event, data, (err, answer) => {
            if (err) reject(new Error('The connection to the server was lost. Please try again.'));
            else resolve(answer || {});
        });
    });
}

async function sendPicture(file) {
    if (!file || pictureBusy) return;
    if (chatView.type === 'pm' || !channelChatReady || !socket.connected) {
        showPictureStatus('Pictures can be sent to a channel chat.', true);
        return;
    }
    pictureBusy = true;
    updatePictureButton();
    try {
        showPictureStatus('Getting the picture ready...');
        const bytes = await preparePicture(file);
        let answer = await emitWithAnswer('image-upload-start', { size: bytes.length });
        if (answer.error) throw new Error(answer.error);
        for (let pos = 0; pos < bytes.length; pos += PICTURE_PART_BYTES) {
            const part = bytes.slice(pos, pos + PICTURE_PART_BYTES);
            answer = await emitWithAnswer('image-upload-part', part.buffer);
            if (answer.error) throw new Error(answer.error);
            const done = Math.min(pos + PICTURE_PART_BYTES, bytes.length);
            showPictureStatus(`Sending the picture... ${Math.round(done / bytes.length * 100)}%`);
        }
        showPictureStatus('Saving it to TeamSpeak...');
        answer = await emitWithAnswer('image-upload-end', {}, 150000);
        if (answer.error) throw new Error(answer.error);
        hidePictureStatus();
    } catch (e) {
        showPictureStatus((e && e.message) || "The picture couldn't be sent.", true);
    } finally {
        pictureBusy = false;
        updatePictureButton();
    }
}

(() => {
    const btn = document.getElementById('chat-picture-btn');
    const menu = document.getElementById('chat-picture-menu');
    // A computer opens the file picker at once. A phone gets a choice first: Chrome on Android opens its photo
    // picker, which has no camera, so "Take a photo" opens the camera directly (capture).
    const isPhone = () => window.matchMedia('(pointer: coarse)').matches;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!isPhone()) document.getElementById('chat-picture-file').click();
        else menu.hidden = !menu.hidden;
    });
    menu.addEventListener('click', (e) => {
        const choice = e.target.closest('[data-pick]');
        if (!choice) return;
        menu.hidden = true;
        document.getElementById(choice.dataset.pick).click();
    });
    document.addEventListener('click', (e) => {
        if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
    });
    for (const id of ['chat-picture-file', 'chat-picture-camera']) {
        const input = document.getElementById(id);
        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            input.value = '';
            sendPicture(file);
        });
    }
    // Pasting a picture anywhere on the page, or into the message box (e.g. a screenshot): it waits for Send.
    // Other text fields (settings, nickname...) paste as usual.
    document.addEventListener('paste', (e) => {
        const target = e.target;
        if (target && target !== chatInput
            && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
        const item = [...((e.clipboardData && e.clipboardData.items) || [])]
            .find((i) => i.kind === 'file' && i.type.startsWith('image/'));
        if (!item) return;
        e.preventDefault();
        stagePicture(item.getAsFile());
    });
    document.getElementById('chat-picture-send').addEventListener('click', sendPendingPicture);
    document.getElementById('chat-picture-remove').addEventListener('click', clearPendingPicture);
    document.getElementById('chat-picture-pending').querySelector('img')
        .addEventListener('error', (e) => { e.target.hidden = true; }); // e.g. HEIC: no preview, still sendable
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && pendingPicture) clearPendingPicture();
    });
    // Dropping a picture on the chat.
    chatMessagesEl.addEventListener('dragover', (e) => {
        if ([...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files')) e.preventDefault();
    });
    chatMessagesEl.addEventListener('drop', (e) => {
        const file = [...((e.dataTransfer && e.dataTransfer.files) || [])].find((f) => f.type.startsWith('image/'));
        if (!file) return;
        e.preventDefault();
        sendPicture(file);
    });
    updatePictureButton();
})();

// A picture line in a message: the picture (tap for full size). The bridge fetches it with your own TeamSpeak
// connection, so right after the page opens it may not be ready yet: two more tries, then a short note.
function channelPictureHtml(picture) {
    const src = escapeHtml(channelPictureUrl(picture));
    const name = escapeHtml(picture.name);
    return `
            <div class="chat-link-preview chat-picture">
                <a href="${src}" target="_blank" rel="noopener" title="${name}"><img src="${src}" alt="${name}" class="chat-preview-img" loading="lazy" onload="chatPictureLoaded()" onerror="retryChannelPicture(this)"></a>
            </div>`;
}

// ============================================
// SERVER ICONS AND AVATARS
// ============================================
// Every icon comes from the TeamSpeak server itself (channels, the server, groups, people), through /server-icon,
// and avatars through /avatar: the bridge fetches them from the server's files with your own connection. Ids under
// 1000 are TeamSpeak's built-in group icons; those are drawn here (simple shields of our own, by colour).
const DEFAULT_CHANNEL_ICON = `<svg class="ts-channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
const BUILTIN_ICON_COLOURS = { 100: '#22c55e', 200: '#3b82f6', 300: '#ef4444', 500: '#94a3b8', 600: '#eab308' };
const failedIcons = new Set(); // icons the server didn't give: not asked again on every redraw

function serverIconHtml(id, title, cls, fallback = '') {
    id = Number(id) >>> 0;
    if (!id) return '';
    const tip = title ? ` title="${escapeHtml(title)}"` : '';
    if (id < 1000) {
        const colour = BUILTIN_ICON_COLOURS[id] || '#94a3b8';
        return `<svg class="${cls}" viewBox="0 0 16 16"${tip} aria-hidden="true"><path d="M8 1 2.5 3v4.2c0 3.4 2.3 6.3 5.5 7.8 3.2-1.5 5.5-4.4 5.5-7.8V3L8 1Z" fill="${colour}"/></svg>`;
    }
    if (failedIcons.has(id)) return fallback === 'channel' ? DEFAULT_CHANNEL_ICON : '';
    return `<img class="${cls}" src="/server-icon?id=${id}" alt=""${tip} data-icon="${id}" data-fallback="${fallback}" onerror="retryServerIcon(this)">`;
}

function retryServerIcon(img) {
    const tries = Number(img.dataset.tries || 0);
    if (tries >= 2) {
        failedIcons.add(Number(img.dataset.icon));
        if (img.dataset.fallback === 'channel') img.outerHTML = DEFAULT_CHANNEL_ICON;
        else img.remove();
        return;
    }
    img.dataset.tries = String(tries + 1);
    setTimeout(() => { img.src = img.src.replace(/&try=\d+$/, '') + `&try=${tries + 1}`; }, 3000);
}

// A person's badges: their channel group's icon, their server groups' icons (in the server's order), then their own.
function groupBadgesHtml(user) {
    if (!latestState) return '';
    const serverGroups = new Map((latestState.serverGroups || []).map((g) => [g.id, g]));
    const channelGroup = (latestState.channelGroups || []).find((g) => g.id === user.channelGroup);
    const list = (user.serverGroups || []).map((id) => serverGroups.get(id)).filter(Boolean)
        .sort((a, b) => a.sortId - b.sortId || a.id - b.id);
    if (channelGroup) list.unshift(channelGroup);
    let html = list.slice(0, 5).map((g) => serverIconHtml(g.iconId, g.name, 'ts-group-icon')).join('');
    if (user.iconId) html += serverIconHtml(user.iconId, '', 'ts-group-icon');
    return html;
}

// TeamSpeak's channel order: every channel names the one above it ("order", 0 = first); a broken chain falls back
// to the channel number, so nothing ever disappears.
function orderChannels(list) {
    const after = new Map();
    list.forEach((ch) => {
        const key = Number(ch.order) || 0;
        if (!after.has(key)) after.set(key, []);
        after.get(key).push(ch);
    });
    const out = [];
    const placed = new Set();
    let previous = 0;
    for (;;) {
        const next = (after.get(previous) || []).find((ch) => !placed.has(ch.cid));
        if (!next) break;
        out.push(next);
        placed.add(next.cid);
        previous = next.cid;
    }
    list.filter((ch) => !placed.has(ch.cid)).sort((a, b) => a.cid - b.cid).forEach((ch) => out.push(ch));
    return out;
}

// A spacer, as the TeamSpeak app decides it: a permanent top-level channel named [<kind>spacer<anything>]<text>.
// Kind c = centred, r = right, * = the text repeated across, else left. The texts ---, ..., -.-, ___ and -.. are lines.
// Returns { align, text, repeat } or { align, line }, or null for an ordinary channel.
function spacerInfo(channel) {
    if (!channel || channel.pid || channel.permanent === false) return null;
    const m = /^\[([^\]]*)spacer[^\]]*\](.*)$/.exec(String(channel.name || ''));
    if (!m) return null;
    const kind = m[1];
    const text = m[2];
    const align = kind === 'c' ? 'center' : kind === 'r' ? 'right' : 'left';
    const lines = { '---': 'dashed', '...': 'dotted', '-.-': 'dashed', '___': 'solid', '-..': 'dotted', '': 'solid' };
    if (Object.prototype.hasOwnProperty.call(lines, text)) return { align, line: lines[text] };
    return { align, text, repeat: kind === '*' };
}

// A channel banner's address for the page: an https picture as it is, or a picture in the server's files
// (ts3image://name?channel=…&path=…) through /channel-image. Anything else: none.
function bannerSrc(url) {
    if (typeof url !== 'string' || !url) return '';
    if (/^https:\/\/[^\s"'()<>\\]+$/i.test(url)) return url;
    const { pictures } = channelPictures(`[img]${url}[/img]`);
    return pictures.length ? channelPictureUrl(pictures[0]) : '';
}

function personByUid(uid) {
    return uid && latestState ? (latestState.clients || []).find((c) => c.uid === uid) : undefined;
}

// Their avatar, when they have one (the hash changes when they change it, so the address does too).
function avatarHtml(person, cls) {
    if (!person || !person.uid || !person.avatar) return '';
    const params = `uid=${encodeURIComponent(person.uid)}&v=${encodeURIComponent(person.avatar)}`
        + (person.avatarName ? `&name=${encodeURIComponent(person.avatarName)}` : '');
    return `<img class="${cls}" src="/avatar?${escapeHtml(params)}" alt="" onerror="retryAvatar(this)">`;
}

// Once more after 2 s (the connection may have been a moment late), then left out.
function retryAvatar(img) {
    if (img.dataset.tried) return img.remove();
    img.dataset.tried = '1';
    setTimeout(() => { img.src += '&try=1'; }, 2000);
}

function retryChannelPicture(img) {
    const tries = Number(img.dataset.tries || 0);
    if (tries >= 2) {
        const box = img.closest('.chat-picture');
        if (box) box.classList.add('failed');
        return;
    }
    img.dataset.tries = String(tries + 1);
    setTimeout(() => { img.src = img.src.replace(/&try=\d+$/, '') + `&try=${tries + 1}`; }, 4000);
}

// ============================================
// PERSON MENU: right-click, or press and hold on a phone
// ============================================
const personMenu = document.getElementById('person-menu');
const personVol = document.getElementById('person-menu-vol');
const personVolVal = document.getElementById('person-menu-vol-val');
let personMenuClid = 0;
let personMenuOpenedAt = 0;

function showPersonVolume() {
    personVolVal.innerText = Math.round(Number(personVol.value) * 100) + '%';
}

function openPersonMenu(clid, x, y) {
    const person = clientByClid(clid);
    if (!person || person.clid === selfClid || person.isSelf) return;
    // A phone's long press can also fire "contextmenu": open once.
    if (personMenuClid === clid && Date.now() - personMenuOpenedAt < 700) return;
    personMenuClid = clid;
    personMenuOpenedAt = Date.now();
    document.getElementById('person-menu-name').innerHTML = avatarHtml(person, 'person-menu-avatar') + escapeHtml(person.nickname);
    personVol.value = personVolume(person.uid);
    showPersonVolume();
    personMenu.classList.remove('hidden');
    const box = personMenu.getBoundingClientRect();
    personMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8)) + 'px';
    personMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) + 'px';
}

function closePersonMenu() {
    personMenu.classList.add('hidden');
    personMenuClid = 0;
}

function clidOfRow(target) {
    const row = target.closest && target.closest('.ts-user');
    return row ? Number(row.id.replace('ts-user-', '')) : 0;
}

// The channel tree is redrawn often, so the listeners sit on its container.
tsContent.addEventListener('contextmenu', (e) => {
    const clid = clidOfRow(e.target);
    if (!clid) return;
    e.preventDefault();
    openPersonMenu(clid, e.clientX, e.clientY);
});
let pressTimer = null;
let pressStart = null;
tsContent.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const clid = clidOfRow(e.target);
    if (!clid) return;
    pressStart = { x: e.clientX, y: e.clientY };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
        pressTimer = null;
        openPersonMenu(clid, pressStart.x, pressStart.y);
    }, 500);
});
['pointerup', 'pointercancel'].forEach((type) => tsContent.addEventListener(type, () => {
    clearTimeout(pressTimer);
    pressTimer = null;
}));
tsContent.addEventListener('pointermove', (e) => {
    if (pressTimer && pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) {
        clearTimeout(pressTimer);
        pressTimer = null;
    }
});
document.addEventListener('pointerdown', (e) => {
    if (!personMenu.classList.contains('hidden') && !personMenu.contains(e.target) && Date.now() - personMenuOpenedAt > 300) closePersonMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePersonMenu(); });
window.addEventListener('resize', closePersonMenu);

// Volume for you: heard right away while dragging, saved (per device) when let go.
personVol.addEventListener('input', () => {
    const person = clientByClid(personMenuClid);
    if (!person || !person.uid) return;
    const vol = Number(personVol.value);
    if (vol === 1) delete appSettings.clientVolumes[person.uid];
    else appSettings.clientVolumes[person.uid] = vol;
    const node = speakerGains.get(person.clid);
    if (node) node.gain.value = vol;
    showPersonVolume();
});
personVol.addEventListener('change', storeSettings);

document.getElementById('person-menu-chat').addEventListener('click', () => {
    const person = clientByClid(personMenuClid);
    closePersonMenu();
    openPrivateChat(person);
});

// --- POKE ---
const pokeModal = document.getElementById('poke-modal');
const pokeMsg = document.getElementById('poke-msg');
let pokeTargetClid = 0;
document.getElementById('person-menu-poke').addEventListener('click', () => {
    const person = clientByClid(personMenuClid);
    closePersonMenu();
    if (!person) return;
    pokeTargetClid = person.clid;
    document.getElementById('poke-title').textContent = `Poke ${person.nickname}`;
    pokeMsg.value = '';
    pokeModal.classList.add('active');
    pokeMsg.focus();
});
function closePoke() { pokeModal.classList.remove('active'); }
document.getElementById('poke-cancel').addEventListener('click', closePoke);
document.getElementById('poke-close').addEventListener('click', closePoke);
document.getElementById('poke-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (pokeTargetClid) socket.emit('poke', { clid: pokeTargetClid, msg: pokeMsg.value.trim().slice(0, 100) });
    closePoke();
});

// --- SERVER INFO ---
// The server's name opens its info, like the desktop app: banner, welcome message, users, channels, uptime,
// age, website and version, from what the bridge passes on (parts the server didn't give are left out).
const serverInfoModal = document.getElementById('server-info-modal');
const serverInfoBody = document.getElementById('server-info-body');

function spanText(ms) {
    const min = Math.max(0, Math.floor(ms / 60000));
    if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
    const hours = Math.floor(min / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
    const days = Math.floor(hours / 24);
    if (days < 60) return `${days} day${days === 1 ? '' : 's'}`;
    const months = Math.floor(days / 30.44);
    if (months < 24) return `${months} months`;
    return `${Math.floor(days / 365.25)} years`;
}

function renderServerInfo() {
    const info = (latestState && latestState.serverInfo) || {};
    const users = ((latestState && latestState.clients) || []).length;
    const channels = ((latestState && latestState.channels) || []).length;
    document.getElementById('server-info-title').textContent = info.name || 'Server info';
    const parts = [];
    if (info.bannerImage) {
        const img = `<img class="server-banner" src="${escapeHtml(info.bannerImage)}" alt="" referrerpolicy="no-referrer" onerror="this.closest('.server-banner-wrap').remove()">`;
        parts.push(`<div class="server-banner-wrap">${info.bannerLink
            ? `<a href="${escapeHtml(info.bannerLink)}" target="_blank" rel="noopener noreferrer">${img}</a>` : img}</div>`);
    }
    // The welcome message may carry TeamSpeak's [b]…[/b] style tags: shown as plain text with its links.
    const welcome = String(info.welcomeMessage || '').replace(/\[\/?[a-z*]+(=[^\]]*)?\]/gi, '').trim();
    if (welcome) parts.push(`<div class="server-welcome">${parseMessage(welcome).html}</div>`);
    const stats = [['Users', info.maxClients ? `${users} / ${info.maxClients}` : String(users)], ['Channels', String(channels)]];
    if (info.startedAt) stats.push(['Uptime', spanText(Date.now() - info.startedAt)]);
    if (info.created) stats.push(['Created', `${spanText(Date.now() - info.created * 1000)} ago`]);
    parts.push(`<div class="server-stats">${stats.map(([k, v]) => `<div class="server-stat"><span>${k}</span>${escapeHtml(v)}</div>`).join('')}</div>`);
    if (info.websiteUrl) {
        parts.push(`<a class="server-website" href="${escapeHtml(info.websiteUrl)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(info.websiteName || info.websiteUrl)}</strong><span>${escapeHtml(info.websiteUrl)}</span></a>`);
    }
    const version = [String(info.version || '').replace(/\s*\[Build:[^\]]*\]/i, ''), info.platform].filter(Boolean).join(' • ');
    if (version) parts.push(`<div class="server-version">${escapeHtml(version)}</div>`);
    serverInfoBody.innerHTML = parts.join('');
}

function closeServerInfo() { serverInfoModal.classList.remove('active'); }
document.getElementById('server-name-display').addEventListener('click', () => {
    if (!latestState) return;
    renderServerInfo();
    serverInfoModal.classList.add('active');
});
document.getElementById('server-info-close').addEventListener('click', closeServerInfo);
serverInfoModal.addEventListener('click', (e) => { if (e.target === serverInfoModal) closeServerInfo(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeServerInfo(); });

// Pokes received: a card each, until dismissed (the five newest are kept).
const pokeStack = document.getElementById('poke-stack');
socket.on('ts-poke', (poke) => {
    playUiSound('you_were_poked');
    const card = document.createElement('div');
    card.className = 'poke-card';
    const title = document.createElement('div');
    title.className = 'poke-title';
    title.textContent = `${(poke && poke.invokername) || 'Someone'} poked you`;
    card.appendChild(title);
    if (poke && poke.msg) {
        const msg = document.createElement('div');
        msg.className = 'poke-msg';
        msg.textContent = poke.msg;
        card.appendChild(msg);
    }
    const actions = document.createElement('div');
    actions.className = 'poke-actions';
    const time = document.createElement('span');
    time.textContent = poke ? messageTime(poke) : '';
    const dismiss = document.createElement('button');
    dismiss.className = 'secondary-btn';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => card.remove());
    actions.append(time, dismiss);
    card.appendChild(actions);
    pokeStack.appendChild(card);
    while (pokeStack.children.length > 5) pokeStack.firstElementChild.remove();
});

// --- INCOMING VOICE (MULTI-DECODER) ---
socket.on('ts-voice', function(packet) {
    if (isAudioMuted || !packet.data || !audioCtx) return;
    
    // --- PUHE-INDIKAATTORI MUILLE ---
    setTalkingState(packet.clid, true);
    if (talkTimers.has(packet.clid)) clearTimeout(talkTimers.get(packet.clid));
    talkTimers.set(packet.clid, setTimeout(() => {
        setTalkingState(packet.clid, false);
    }, 300)); // the glow goes off after 300 ms of silence

    if (needsWasmDecoder()) return playWasmVoice(packet);

    try {
        const producerId = packet.producerId;
        decoderClids.set(producerId, packet.clid);
        
        // The speaker's own decoder, or a new one
        let decoder = decoders.get(producerId);
        
        if (!decoder) {
            decoder = new AudioDecoder({
                output: (audioData) => {
                    if (!audioCtx) return;
                    const buffer = audioCtx.createBuffer(audioData.numberOfChannels, audioData.numberOfFrames, audioData.sampleRate);
                    
                    for (let i = 0; i < audioData.numberOfChannels; i++) {
                        const f32Array = new Float32Array(audioData.numberOfFrames);
                        audioData.copyTo(f32Array, { planeIndex: i });
                        buffer.getChannelData(i).set(f32Array);
                    }
                    
                    const source = audioCtx.createBufferSource();
                    source.buffer = buffer;
                    source.connect(speakerOutput(decoderClids.get(producerId))); // their volume, then the voice volume
                    
                    let pt = nextPlayTimes.get(producerId) || audioCtx.currentTime;
                    if (pt < audioCtx.currentTime) {
                        pt = audioCtx.currentTime + 0.05; 
                    }
                    source.start(pt);
                    nextPlayTimes.set(producerId, pt + buffer.duration);
                    audioData.close();
                },
                error: (e) => {
                    console.error(`[Voice] Decoder error for ${producerId}:`, e);
                    decoders.delete(producerId);
                }
            });
            decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
            decoders.set(producerId, decoder);
        }

        if (decoder.state === "configured") {
            const chunk = new EncodedAudioChunk({
                type: 'key',
                timestamp: performance.now() * 1000,
                data: packet.data
            });
            decoder.decode(chunk);
        }
    } catch (e) {
        console.error("[Voice] Decode error:", e);
    }
});

// ============================================
// DOM RENDERING
// ============================================
function renderChannelTree() {
    if (!latestState) return;
    // The server's name
    const serverNameEl = document.getElementById('server-name-display');
    if (serverNameEl && latestState.serverInfo && latestState.serverInfo.name) {
        // With the server's own icon; only redrawn when either changes.
        const key = `${latestState.serverInfo.iconId || 0}|${latestState.serverInfo.name}`;
        if (serverNameEl.dataset.key !== key) {
            serverNameEl.dataset.key = key;
            serverNameEl.innerHTML = serverIconHtml(latestState.serverInfo.iconId, '', 'server-name-icon') + escapeHtml(latestState.serverInfo.name);
        }
    }

    const channels = latestState.channels || [];
    const clients = latestState.clients || [];

    if (channels.length === 0) {
        tsContent.innerHTML = '<div class="ts-loading" style="color: #ef4444;">Server offline</div>';
        return;
    }

    const clientsByCid = new Map();
    clients.forEach(c => {
        if (!clientsByCid.has(c.cid)) clientsByCid.set(c.cid, []);
        clientsByCid.get(c.cid).push(c);
    });

    const channelMap = {};
    const rootChannels = [];

    channels.forEach(ch => {
        ch.subchannels = [];
        ch.users = clientsByCid.get(ch.cid) || [];
        channelMap[ch.cid] = ch;
    });

    channels.forEach(ch => {
        if (ch.pid === 0 || !ch.pid) {
            rootChannels.push(ch);
        } else if (channelMap[ch.pid]) {
            channelMap[ch.pid].subchannels.push(ch);
        } else {
            rootChannels.push(ch);
        }
    });
    // In TeamSpeak's order: each channel's "order" is the channel it comes after.
    const orderedRoots = orderChannels(rootChannels);
    rootChannels.length = 0;
    rootChannels.push(...orderedRoots);
    channels.forEach(ch => { ch.subchannels = orderChannels(ch.subchannels); });

    const tempContainer = document.createElement('div');

    function renderChannelNode(channel, depth) {
        const wrapper = document.createElement('div');
        const channelGroup = document.createElement('div');
        channelGroup.className = 'ts-channel-group';

        if (channel.cid === activeChannelId) {
            channelGroup.style.borderColor = 'rgba(59, 130, 246, 0.5)';
            channelGroup.style.boxShadow = '0 0 10px rgba(59, 130, 246, 0.15)';
        }

        if (depth > 0) {
            channelGroup.style.marginLeft = (depth * 15) + 'px';
            channelGroup.style.borderLeft = '2px solid rgba(255, 255, 255, 0.05)';
        }

        let cleanName = cleanChannelName(channel.name);
        // The channel's own icon from the server, else the plain note.
        let iconHTML = (channel.iconId && serverIconHtml(channel.iconId, '', 'ts-custom-channel-icon', 'channel')) || DEFAULT_CHANNEL_ICON;
        // A spacer is drawn as TeamSpeak draws it (text left/centre/right, a repeated pattern or a line, no icon);
        // a banner goes behind the row. The name is made safe: channel names come from the server.
        const spacer = spacerInfo(channel);
        const banner = bannerSrc(channel.bannerUrl);
        const titleClasses = ['ts-channel-title'];
        let titleInner = `${iconHTML} ${escapeHtml(cleanName)}`;
        if (spacer) {
            titleClasses.push('ts-spacer', `ts-spacer-${spacer.align}`);
            titleInner = spacer.line
                ? `<span class="ts-spacer-line ts-spacer-line-${spacer.line}"></span>`
                : `<span class="ts-spacer-text${spacer.repeat ? ' ts-spacer-repeat' : ''}">${escapeHtml(spacer.repeat
                    ? spacer.text.repeat(Math.ceil(160 / Math.max(1, spacer.text.length))) : spacer.text)}</span>`;
        }
        // The banner as the TeamSpeak app shows it: the picture at its own size (at most 500 px wide), from the left,
        // centred up and down, fading out on the right, with a shade behind the name (not stretched to the row).
        let bannerHTML = '';
        if (banner) {
            titleClasses.push('ts-has-banner');
            bannerHTML = `<img class="ts-banner-img" src="${escapeHtml(banner)}" alt="" referrerpolicy="no-referrer" onerror="this.parentElement.classList.remove('ts-has-banner'); this.remove()">`
                + `<span class="ts-banner-shade${spacer && spacer.align === 'center' ? ' centered' : spacer && spacer.align === 'right' ? ' right' : ''}"></span>`;
        }

        channelGroup.innerHTML = `
            <div class="${titleClasses.join(' ')}" data-cid="${channel.cid}">
                ${bannerHTML}${titleInner}
            </div>
            <div class="ts-user-list"></div>
        `;

        const titleElement = channelGroup.querySelector('.ts-channel-title');
        titleElement.addEventListener('click', () => {
            activeChannelId = channel.cid;
            activeChannelName = cleanName;
            channelChatReady = true;
            pendingMoveCid = channel.cid;
            pendingMoveAt = Date.now();

            // Clear every glow: we no longer hear the old channel
            talkTimers.forEach(timer => clearTimeout(timer));
            talkTimers.clear();
            isSpeakingVAD = false;

            showChatView({ type: 'channel' });

            console.log(`[WebSocket] Moving to channel CID: ${channel.cid}`);
            socket.emit('move-channel', { cid: channel.cid });
            renderChannelTree();
        });

        const userListDiv = channelGroup.querySelector('.ts-user-list');

        channel.users.forEach(user => {
            let userClass = 'ts-user';
            let badgesHTML = '';

            let isActuallyTalking = user.isTalking;
            
            // The server says they stopped talking: drop their glow timer
            if (!isActuallyTalking && talkTimers.has(user.clid)) {
                clearTimeout(talkTimers.get(user.clid));
                talkTimers.delete(user.clid);
            }
            
            if (user.clid === selfClid && isSpeakingVAD) isActuallyTalking = true;
            if (talkTimers.has(user.clid)) isActuallyTalking = true;

            if (isActuallyTalking) {
                userClass += ' is-talking';
            }

            if (user.outputMuted) {
                badgesHTML += `<svg class="ts-icon-muted" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a9 9 0 0 0-9 9v4.5c0 1.38 1.12 2.5 2.5 2.5h2.5V13.5H5.5v-1.5a6.5 6.5 0 0 1 13 0v1.5h-2.5V19h2.5c1.38 0 2.5-1.12 2.5-2.5V12a9 9 0 0 0-9-9z"/><path d="M4.27 3L3 4.27l18 18L22.27 21 4.27 3z"/></svg>`;
            } else if (user.inputMuted) {
                badgesHTML += `<svg class="ts-icon-muted" viewBox="0 0 24 24" fill="currentColor"><path d="M6.7 3.3a1 1 0 0 0-1.4 1.4l15 15a1 1 0 0 0 1.4-1.4l-15-15ZM15 10a1 1 0 0 0-2 0v2.6l2 2V10ZM12 17c-2.4 0-4.3-1.6-4.8-3.9a1 1 0 1 0-2 .4A7 7 0 0 0 11 19.9V22a1 1 0 1 0 2 0v-2.1c.3 0 .5-.1.8-.1l-1.8-1.8V17Z"/><path d="M12 4a3 3 0 0 0-3 3v.6l5.7 5.7A3 3 0 0 0 15 10V7a3 3 0 0 0-3-3ZM17.2 13.5a1 1 0 0 0-1.5 1.4c.6.7 1 1.5 1.1 2.4a1 1 0 0 0 2 .2 7 7 0 0 0-1.6-4Z"/></svg>`;
            } else if (user.canTalk === false) {
                // Not enough talk power to be heard in this channel (e.g. AFK), as the desktop app shows it.
                badgesHTML += `<svg class="ts-icon-notalk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><title>Can't talk in this channel</title><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/><circle cx="18" cy="18" r="4.5" fill="#2b2d31"/><path d="M15 21l6-6"/></svg>`;
            }
            // The stream icon and the WATCH button. Like the desktop client, a stream can be watched only from the same
            // channel: the icon shows in every channel, WATCH only in your own.
            if (user.isStreaming) {
                if (!user.isSelf && user.cid === ownChannelId(latestState)) {
                    badgesHTML += `<button class="watch-btn" onclick="watchStream(${user.clid}, '${escapeHtml(user.nickname)}')">WATCH</button>`;
                }
                badgesHTML += `<svg style="width: 15px; height: 15px; vertical-align: middle; margin-right: 6px; color: #22c55e;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2" ry="2"></rect><polygon points="10 9 15 12 10 15 10 9" fill="currentColor"></polygon></svg>`;
            }

            if (user.away) {
                userClass += ' ts-user-afk';
                badgesHTML += `<span class="ts-afk-tag">AFK</span>`;
            }

            if (user.isSelf) {
                badgesHTML += `<span class="ts-afk-tag" style="border-color:#a855f7;color:#c084fc;">You</span>`;
            }
            badgesHTML += groupBadgesHtml(user); // their groups' icons and their own, as in the TeamSpeak app

            const userDiv = document.createElement('div');
            // The id lets the talking glow find the row
            userDiv.id = `ts-user-${user.clid}`; 
            userDiv.className = userClass;
            userDiv.innerHTML = `<span class="ts-username">${escapeHtml(user.nickname)}</span><div class="ts-badges">${badgesHTML}</div>`;
            userListDiv.appendChild(userDiv);
        });

        wrapper.appendChild(channelGroup);
        channel.subchannels.forEach(sub => wrapper.appendChild(renderChannelNode(sub, depth + 1)));
        
        return wrapper;
    }

    rootChannels.forEach(root => tempContainer.appendChild(renderChannelNode(root, 0)));
    tsContent.innerHTML = '';
    tsContent.appendChild(tempContainer);
}

// --- UTILITY ---
// A message's time in the viewer's own format (the bridge sends the moment; older messages only a text), with the day
// like the TeamSpeak app: just the time today, "21:36 - Mon" in the six days before, "21:36 - 6 Oct" earlier.
function messageTime(msg) {
    if (msg && Number(msg.time) > 0) {
        try {
            const at = Number(msg.time);
            const d = new Date(at);
            const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const now = new Date();
            if (at >= new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) return time;
            if (at >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime()) {
                return `${time} - ${d.toLocaleDateString([], { weekday: 'short' })}`;
            }
            return `${time} - ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
        } catch (e) {}
    }
    return (msg && msg.timestamp) || '';
}
function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// A file sent from the TeamSpeak app (e.g. an image pasted in its chat) arrives as a small JSON note
// ({"msg_type":"ts.file.myts","file_name":…}). The file itself is on myTeamSpeak and reaches only the apps that
// were in the channel when it was sent; WebTS can't get it, so the note is one short line instead of code.
// Returns the line's HTML, or null when the message is ordinary text.
function mytsFileNote(text) {
    if (typeof text !== 'string' || !text.startsWith('{') || !text.includes('"ts.file')) return null;
    let note;
    try { note = JSON.parse(text); } catch (e) { return null; }
    if (!note || typeof note.msg_type !== 'string' || !note.msg_type.startsWith('ts.file')) return null;
    const rawName = [note.file_name, note.body].find((v) => typeof v === 'string' && v.trim());
    const isImage = /\.(jpe?g|png|gif|webp|bmp|heic|avif)$/i.test(rawName ? rawName.trim() : '');
    return `${isImage ? '🖼️' : '📎'} <span class="chat-file-hint">TeamSpeak ${isImage ? 'images' : 'files'} aren't supported in WebTS</span>`;
}

function parseMessage(text) {
    if (!text) return { html: '', urls: [] };
    
    // 1. Safety first: escape the raw text, so nobody can inject HTML or scripts
    let parsed = escapeHtml(text);
    
    // 2. The links
    const urls = [];
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    parsed = parsed.replace(urlRegex, (url) => {
        urls.push(url);
        return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${url}</a>`;
    });

    // 3. TeamSpeak Markdown -muotoilut
    parsed = parsed.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>'); // Bold
    parsed = parsed.replace(/\*(.*?)\*/g, '<em>$1</em>');             // Italic
    parsed = parsed.replace(/\+\+(.*?)\+\+/g, '<u>$1</u>');           // Underscore (Underline)
    parsed = parsed.replace(/~~(.*?)~~/g, '<s>$1</s>');               // Strikethrough

    return { html: parsed, urls: urls };
}

// ============================================
// WEBRTC VIDEO STREAMING
// ============================================
let peerConnection = null;
let currentStreamId = null;
let watchingClid = null; // the streamer being watched (or asked for), for the same-channel rule
let pendingRemoteIceCandidates = [];
let videoRejected = false;

const videoModal = document.getElementById('video-modal');
const videoTitle = document.getElementById('video-title');
const videoRoute = document.getElementById('video-route');
function showVideoRoute(route) {
    videoRoute.textContent = route || '';
    videoRoute.classList.toggle('hidden', !route);
    videoRoute.title = route === 'Relay' ? 'Through the relay' : route === 'Direct' ? 'Straight between you and the streamer' : '';
}
const streamVideo = document.getElementById('stream-video');
const videoLoading = document.getElementById('video-loading');

// 1. WATCH pressed
window.watchStream = function(clid, nickname) {
    if (peerConnection) closeVideoStream();
    
    videoTitle.innerText = `${nickname}'s stream`;
    videoModal.classList.add('active');
    wakePlayerUi();
    videoLoading.style.display = 'block';
    videoLoading.innerText = 'Requesting access...';
    streamVideo.srcObject = null;
    currentStreamId = null;
    watchingClid = clid;

    console.log(`[WebRTC] Requesting to watch clid: ${clid}`);
    socket.emit('watch-stream', { clid: clid });
};

// What the browser sees during a stream, also sent to the bridge's stream log.
function streamDiagnostics(stage, detail) {
    console.log(`[WebRTC] ${stage}: ${detail}`);
    socket.emit('stream-diagnostics', { stage, detail });
}

// TeamSpeak sends H.264 as Constrained High (profile-level-id 640cXX), which no browser lists, so a browser
// turns the video down. A Constrained High stream is a valid High stream: the offer is shown to the browser
// under an H.264 profile this browser lists (High for Chrome and Edge, Constrained Baseline for Firefox), and
// TeamSpeak's own value is put back in the answer, which must match its offer. (Suggested by the
// ts6-manager session; the same relabelling plays in Edge and Firefox in its sidecar.)
function browserH264Profile() {
    const listed = ((window.RTCRtpReceiver && RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video')) || { codecs: [] }).codecs
        .map((c) => ((c.sdpFmtpLine || '').match(/profile-level-id=([0-9a-f]{4})/i) || [])[1])
        .filter(Boolean)
        .map((p) => p.toLowerCase());
    return ['6400', '42e0', '4200'].find((p) => listed.includes(p)) || null;
}

// Does the offer also have a video format this browser plays as-is (AV1, VP9, VP8)? The desktop client
// offers those next to H.264, and they're the safer choice: a relabelled High stream may not decode
// everywhere (Firefox's H.264 decoder in particular). Only an H.264-only offer (the ts6-manager bot) is relabelled.
function offerHasOtherPlayableVideo(sdp) {
    const playable = ((window.RTCRtpReceiver && RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video')) || { codecs: [] }).codecs
        .map((c) => (c.mimeType || '').toLowerCase());
    return ['AV1', 'VP9', 'VP8'].some((name) => playable.includes(`video/${name.toLowerCase()}`)
        && new RegExp(`^a=rtpmap:\\d+ ${name}/`, 'im').test(sdp));
}

// The offer relabelled for the browser, and per payload type TeamSpeak's original value.
function relabelOfferH264(sdp) {
    const original = {};
    const profile = browserH264Profile();
    if (!profile || offerHasOtherPlayableVideo(sdp)) return { sdp, original };
    const out = sdp.replace(/^(a=fmtp:(\d+) .*profile-level-id=)640c([0-9a-f]{2})/gim, (line, head, pt, level) => {
        original[pt] = `640c${level}`;
        return `${head}${profile}${level}`;
    });
    return { sdp: out, original };
}

// The browser's answer with TeamSpeak's own H.264 value back on each relabelled payload type.
function restoreAnswerH264(sdp, original) {
    return sdp.replace(/^(a=fmtp:(\d+) .*profile-level-id=)([0-9a-f]{6})/gim,
        (line, head, pt) => (original[pt] ? `${head}${original[pt]}` : line));
}

// Firefox writes its answer differently from Chrome: the DTLS fingerprint and ice-options once at the top
// (session level) instead of in every media section, a session-level direction, and its own origin line. It also
// leaves out the AV1 settings line (and VP9's profile) that Chrome repeats from the offer. So the answer goes to
// TeamSpeak in Chrome's layout, with those lines copied in from the offer; Chrome's and Edge's answers pass
// unchanged. (What kept the TeamSpeak app from connecting to Firefox was the answer's session version: see
// withOfferSessionVersion.)
function chromeShapedAnswer(sdp, offerSdp = '') {
    const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
    const lines = sdp.split(/\r?\n/);
    const firstMedia = lines.findIndex((l) => l.startsWith('m='));
    if (firstMedia < 0) return sdp;
    const moved = lines.slice(0, firstMedia).filter((l) => /^a=(fingerprint|ice-options):/.test(l));
    if (!moved.some((l) => l.startsWith('a=fingerprint:'))) return sdp;
    const session = lines.slice(0, firstMedia)
        .filter((l) => !/^a=(fingerprint|ice-options):/.test(l) && !/^a=(sendrecv|sendonly|recvonly|inactive)$/.test(l))
        .map((l) => (l.startsWith('o=') ? l.replace(/^o=\S+/, 'o=-') : l));
    const media = [];
    for (const line of lines.slice(firstMedia)) {
        media.push(line);
        // Right after each media section's connection line, like Chrome's ordering puts them early.
        if (line.startsWith('c=')) {
            const has = (prefix) => media.slice(media.map((l) => l.startsWith('m=')).lastIndexOf(true)).some((l) => l.startsWith(prefix));
            for (const m of moved) if (!has(m.split(':')[0] + ':')) media.push(m);
        }
        const codec = line.match(/^a=rtpmap:(\d+) (AV1|VP9)\//i);
        if (codec && !lines.some((l) => l.startsWith(`a=fmtp:${codec[1]} `))) {
            const fromOffer = offerSdp.split(/\r?\n/).find((l) => l.startsWith(`a=fmtp:${codec[1]} `));
            if (fromOffer) media.push(fromOffer);
        }
    }
    return [...session, ...media].join(eol);
}

// The answer's session version (third field of its o= line) set to the offer's. The TeamSpeak 6.0.0-beta5 app
// applies an answer only when that number equals its own offer's and silently drops it otherwise (it rewrites its
// own answers the same way). Chrome and Edge start at 2, like the app, so they passed by coincidence; Firefox starts
// at 0, so the app never took its answer and never checked or nominated a connection to it. Only the text sent to
// TeamSpeak changes, copied as digits.
const sessionVersion = (sdp) => (/^o=\S+ \S+ (\d+) /m.exec(sdp || '') || [])[1] || '?';
function withOfferSessionVersion(answerSdp, offerSdp) {
    const version = /^o=\S+ \S+ (\d+) /m.exec(offerSdp || '');
    if (!version) return answerSdp;
    return answerSdp.replace(/^(o=\S+ \S+ )\d+ /m, `$1${version[1]} `);
}

// Firefox writes the protocol in capitals ("UDP"); Chrome, and what the desktop client sees from it, in small letters.
function chromeShapedCandidate(candidate) {
    return candidate.replace(/^(candidate:\S+ \d+ )(UDP|TCP)( )/, (m, head, proto, tail) => `${head}${proto.toLowerCase()}${tail}`);
}

// A short summary of an SDP: the video line's port (0 = video switched off) and its codecs.
function describeSdp(sdp) {
    const video = (sdp || '').split(/\r?\n/m).reduce((acc, line) => {
        const m = line.match(/^m=(\w+) (\d+)/);
        if (m) acc.media = m[1];
        if (m && m[1] === 'video') acc.port = m[2];
        const r = acc.media === 'video' && line.match(/^a=rtpmap:\d+ ([\w-]+)\//);
        if (r && !/^(rtx|red|ulpfec)$/i.test(r[1])) acc.codecs.add(r[1]);
        const f = acc.media === 'video' && line.match(/profile-level-id=([0-9a-f]{6})/i);
        if (f) acc.codecs.add(`H264-${f[1]}`);
        return acc;
    }, { media: '', port: null, codecs: new Set() });
    return { videoPort: video.port, codecs: [...video.codecs] };
}

// 2. Close the stream
function closeVideoStream() {
    // Leave full screen and the pop-out window first, otherwise they stay open showing nothing.
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    if (streamVideo.webkitDisplayingFullscreen && streamVideo.webkitExitFullscreen) streamVideo.webkitExitFullscreen();
    if (document.pictureInPictureElement && document.exitPictureInPicture) document.exitPictureInPicture().catch(() => {});
    videoModal.classList.remove('active');
    showVideoRoute(null);
    streamVideo.pause();
    streamVideo.srcObject = null;
    if (currentStreamId || peerConnection || watchingClid !== null) socket.emit('stop-watching');
    watchingClid = null;
    
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    currentStreamId = null;
    pendingRemoteIceCandidates = [];
    if (iceWatchTimer) { clearInterval(iceWatchTimer); iceWatchTimer = null; }
}

document.getElementById('close-video').addEventListener('click', closeVideoStream);

// The viewer's controls: the stream's sound, picture-in-picture, full screen; Esc closes.
const videoMuteBtn = document.getElementById('video-mute');
const videoVolume = document.getElementById('video-volume');
function showStreamSound() { videoMuteBtn.innerText = streamVideo.muted || streamVideo.volume === 0 ? '🔇' : '🔊'; }
videoMuteBtn.addEventListener('click', () => { streamVideo.muted = !streamVideo.muted; showStreamSound(); });
videoVolume.addEventListener('input', () => { streamVideo.volume = Number(videoVolume.value); streamVideo.muted = streamVideo.volume === 0; showStreamSound(); });
document.getElementById('video-pip').addEventListener('click', async () => {
    try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else if (streamVideo.requestPictureInPicture) await streamVideo.requestPictureInPicture();
    } catch (e) { console.warn('[WebRTC] Picture-in-picture not available:', e.message); }
});
// Full screen takes the whole player (picture and its controls), not only the video element.
const streamStage = document.getElementById('stream-stage');
document.getElementById('video-fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (streamStage.requestFullscreen) streamStage.requestFullscreen().catch(() => {});
});
streamVideo.addEventListener('dblclick', () => document.getElementById('video-fullscreen').click());

// The player's title, close button and controls fade out after 3 s without the mouse moving, and come
// back on movement (a tap on a phone shows them again).
let playerIdleTimer = null;
function wakePlayerUi() {
    streamStage.classList.add('show-ui');
    clearTimeout(playerIdleTimer);
    playerIdleTimer = setTimeout(() => {
        // Not while the pointer is on a control (e.g. dragging the volume).
        if (!streamStage.querySelector('.stream-controls:hover, .stream-close:hover')) streamStage.classList.remove('show-ui');
        else wakePlayerUi();
    }, 3000);
}
['mousemove', 'pointerdown', 'touchstart', 'keydown'].forEach((type) => streamStage.addEventListener(type, wakePlayerUi, { passive: true }));
streamStage.addEventListener('focusin', wakePlayerUi);

// The streamer stopped, or the connection is gone: say so briefly, then close the player by itself.
function endVideoStream(message) {
    videoLoading.style.display = 'block';
    videoLoading.innerText = message;
    const pc = peerConnection;
    setTimeout(() => { if (pc === peerConnection) closeVideoStream(); }, 2500);
}
// The channel we sit in, from our own entry in the user list (the one marked YOU). The state's currentChannelId
// is only the channel joined at start and doesn't follow moves (fixed in the bridge too).
function ownChannelId(state) {
    const self = ((state && state.clients) || []).find((c) => c.clid === (state.selfClid || selfClid));
    return self ? self.cid : null;
}

// You or the streamer moved to another channel (or the streamer left): the watching ends, as in the desktop client.
function leaveStreamIfApart(state) {
    if (watchingClid === null || !videoModal.classList.contains('active')) return;
    const streamer = (state.clients || []).find((c) => c.clid === watchingClid);
    const own = ownChannelId(state);
    if (own === null || (streamer && streamer.cid === own)) return; // no own entry yet (e.g. reconnecting): wait
    watchingClid = null; // once
    streamDiagnostics('ended', 'not in the same channel any more');
    endVideoStream('Stream ended (you are no longer in the same channel).');
}
socket.on('stream-ended', (data) => {
    if (data && data.streamId && data.streamId !== currentStreamId) return;
    streamDiagnostics('ended', 'the streamer stopped');
    endVideoStream('Stream ended.');
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && videoModal.classList.contains('active') && !document.fullscreenElement) closeVideoStream();
});

// 3. The offer from TeamSpeak, and our answer
// --- Connection-check diagnostics (for troubleshooting stream connections) ---
// Logged to the bridge (stream log): what the offer
// and the answer say about the connection setup, the kinds of addresses the streamer sent, and every 2 s for
// 30 s the browser's own record of the connection checks (each route tried: its state, whether a route was
// chosen, the checks each way). Only read and logged: nothing sent to the streamer changes.
const remoteCandidateKinds = new Map(); // "host/udp" -> how many the streamer sent
let iceWatchTimer = null;

function iceSetupSummary(sdp) {
    const lines = (sdp || '').split(/\r?\n/);
    const firstMedia = lines.findIndex((l) => l.startsWith('m='));
    const session = firstMedia < 0 ? lines : lines.slice(0, firstMedia);
    const value = (prefix) => { const l = lines.find((x) => x.startsWith(prefix)); return l === undefined ? '-' : l.slice(prefix.length); };
    const where = (prefix) => (session.some((l) => l.startsWith(prefix)) ? 'session' : lines.some((l) => l.startsWith(prefix)) ? 'media' : 'none');
    const ufrag = value('a=ice-ufrag:');
    return [
        `lite=${lines.includes('a=ice-lite') ? 'yes' : 'no'}`,
        `options=${value('a=ice-options:')}`,
        `setup=${value('a=setup:')}`,
        `bundle=${value('a=group:BUNDLE ')}`,
        `ufrag=${ufrag === '-' ? 0 : ufrag.length}ch@${where('a=ice-ufrag:')}`,
        `fingerprint@${where('a=fingerprint:')}`,
        `candidates=${lines.filter((l) => l.startsWith('a=candidate:')).length}`,
        `end-of-candidates=${lines.includes('a=end-of-candidates') ? 'yes' : 'no'}`,
        `rtcp-mux=${lines.includes('a=rtcp-mux') ? 'yes' : 'no'}`
    ].join(' ');
}

function noteRemoteCandidate(candidate) {
    const m = String(candidate || '').match(/^candidate:\S+ \d+ (\w+) \d+ \S+ \d+ typ (\w+)/i);
    const kind = m ? `${m[2]}/${m[1].toLowerCase()}` : 'unreadable';
    remoteCandidateKinds.set(kind, (remoteCandidateKinds.get(kind) || 0) + 1);
}

function watchIceChecks(pc) {
    if (iceWatchTimer) clearInterval(iceWatchTimer);
    const started = Date.now();
    const stop = () => { clearInterval(iceWatchTimer); iceWatchTimer = null; };
    iceWatchTimer = setInterval(async () => {
        if (pc !== peerConnection || pc.signalingState === 'closed' || Date.now() - started > 31000) return stop();
        let report;
        try { report = await pc.getStats(); } catch (e) { return; }
        const byId = new Map();
        const pairs = [];
        let role = '-';
        report.forEach((st) => {
            byId.set(st.id, st);
            if (st.type === 'transport' && st.iceRole) role = st.iceRole;
            if (st.type === 'candidate-pair') pairs.push(st);
        });
        const cand = (id) => {
            const c = byId.get(id);
            return c ? `${c.candidateType || '?'}/${String(c.protocol || '?').toLowerCase()}` : '?';
        };
        const n = (v) => (v === undefined ? '-' : v);
        const rank = { succeeded: 0, 'in-progress': 1, waiting: 2, frozen: 3, failed: 4 };
        pairs.sort((a, b) => (b.nominated ? 1 : 0) - (a.nominated ? 1 : 0) || (rank[a.state] ?? 5) - (rank[b.state] ?? 5));
        const kinds = [...remoteCandidateKinds].map(([k, v]) => `${k}x${v}`).join(',') || 'none';
        const policy = (pc.getConfiguration && pc.getConfiguration().iceTransportPolicy) || '?';
        streamDiagnostics('ice-stats', `t=${Math.round((Date.now() - started) / 1000)}s ice=${pc.iceConnectionState} gathering=${pc.iceGatheringState} role=${role} policy=${policy} pairs=${pairs.length} streamer-cands=${kinds}`);
        // Each route: ours > the streamer's, state, NOM(inated) / SEL(ected), our checks sent/answered,
        // the streamer's checks received/answered, bytes received. Two per line (the bridge keeps 400 characters).
        const lines = pairs.slice(0, 6).map((p) => `${cand(p.localCandidateId)}>${cand(p.remoteCandidateId)} ${p.state}`
            + `${p.nominated ? ' NOM' : ''}${p.selected ? ' SEL' : ''} out ${n(p.requestsSent)}/${n(p.responsesReceived)}`
            + ` in ${n(p.requestsReceived)}/${n(p.responsesSent)} rx ${n(p.bytesReceived)}`);
        for (let i = 0; i < lines.length; i += 2) streamDiagnostics('ice-pairs', lines.slice(i, i + 2).join(' | '));
        if (['connected', 'completed'].includes(pc.iceConnectionState)) stop(); // one record of the working route is enough
    }, 2000);
}

// Never change which formats the answer offers back: a Firefox answer without AV1 (VP8, VP9 only) crashed the
// streamer's whole TeamSpeak 6 client.
socket.on('webrtc-offer', async (data) => {
    console.log(`[WebRTC] Received offer for stream ${data.streamId}`);

    // A further offer for the stream we already watch (the desktop client sends a fuller one right after our
    // first answer): renegotiate on the same connection instead of replacing it, which would drop a
    // connection that has just come up.
    if (peerConnection && data.streamId === currentStreamId && peerConnection.signalingState !== 'closed') {
        const pc = peerConnection;
        const info = describeSdp(data.sdp);
        streamDiagnostics('re-offer', `video port=${info.videoPort} codecs=${info.codecs.join(',') || 'none'} state=${pc.signalingState}`);
        streamDiagnostics('re-offer-ice', iceSetupSummary(data.sdp));
        try {
            const relabel = relabelOfferH264(data.sdp);
            await pc.setRemoteDescription({ type: 'offer', sdp: relabel.sdp });
            while (pendingRemoteIceCandidates.length > 0) await pc.addIceCandidate(pendingRemoteIceCandidates.shift());
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            const localSdp = withOfferSessionVersion(chromeShapedAnswer(restoreAnswerH264(pc.localDescription.sdp, relabel.original), data.sdp), data.sdp);
            const answerInfo = describeSdp(localSdp);
            streamDiagnostics('re-answer', `video port=${answerInfo.videoPort} codecs=${answerInfo.codecs.join(',') || 'none'}`);
            socket.emit('webrtc-answer', { streamId: currentStreamId, sdp: localSdp });
        } catch (err) {
            streamDiagnostics('re-offer-error', String(err && err.message || err));
        }
        return;
    }

    currentStreamId = data.streamId;
    videoLoading.innerText = 'Negotiating WebRTC...';
    remoteCandidateKinds.clear();
    streamDiagnostics('offer-ice', iceSetupSummary(data.sdp));

    // TeamSpeak's own STUN servers (as WebSpeak3 uses), plus the relay when the bridge has one.
    peerConnection = new RTCPeerConnection(rtcConfig());
    const offerInfo = describeSdp(data.sdp);
    streamDiagnostics('offer', `video port=${offerInfo.videoPort} codecs=${offerInfo.codecs.join(',') || 'none'}`);

    // The connection's progress, shown in the video box and logged.
    const pc = peerConnection;
    pc.oniceconnectionstatechange = () => {
        streamDiagnostics('ice', pc.iceConnectionState);
        // The route can change (a reconnect), so it is read again whenever the connection is up.
        if (['connected', 'completed'].includes(pc.iceConnectionState)) {
            connectionRoute(pc).then((route) => {
                if (pc !== peerConnection || !route) return;
                if (route !== videoRoute.textContent) streamDiagnostics('route', route.toLowerCase());
                showVideoRoute(route);
            });
        }
    };
    showVideoRoute(null);
    // A connection still being checked after 15 s goes in the stream log (troubleshooting; the screen keeps
    // saying "Connecting...").
    setTimeout(() => {
        if (pc === peerConnection && ['new', 'checking'].includes(pc.iceConnectionState)) {
            streamDiagnostics('check-timeout', pc.iceConnectionState);
        }
    }, 15000);
    pc.onconnectionstatechange = () => {
        streamDiagnostics('connection', pc.connectionState);
        if (pc !== peerConnection) return;
        const text = { new: 'Connecting...', connecting: 'Connecting...', connected: 'Connected, waiting for picture...', failed: 'Connection failed.', disconnected: 'Connection lost.', closed: 'Closed.' }[pc.connectionState];
        // A "failed" can come before every address has arrived (a relay refuses a home-network address
        // at once): 20 s for the later ones before the player closes.
        if (pc.connectionState === 'failed') {
            videoLoading.style.display = 'block';
            videoLoading.innerText = 'Connection problem, still trying...';
            setTimeout(() => { if (pc === peerConnection && pc.connectionState === 'failed') endVideoStream('Connection lost.'); }, 20000);
            return;
        }
        if (text && (videoLoading.style.display !== 'none' || pc.connectionState !== 'connected')) {
            videoLoading.style.display = 'block';
            videoLoading.innerText = text;
        }
    };
    videoRejected = false;
    streamVideo.onplaying = () => {
        streamDiagnostics('video', `playing ${streamVideo.videoWidth}x${streamVideo.videoHeight}`);
        if (!videoRejected) videoLoading.style.display = 'none';
    };

    peerConnection.ontrack = (event) => {
        console.log('[WebRTC] Track received!', event.track.kind);
        if (streamVideo.srcObject !== event.streams[0]) {
            // The picture hides the status text once it actually plays (onplaying), not before.
            streamVideo.srcObject = event.streams[0];
        }
    };

    peerConnection.onicecandidate = (event) => {
        // An empty candidate is the browser's "end of candidates" (Firefox sends one); a desktop TS6 client
        // never sends such a message, so it isn't passed on.
        if (event.candidate && event.candidate.candidate && currentStreamId) {
            socket.emit('webrtc-ice', {
                streamId: currentStreamId,
                candidate: chromeShapedCandidate(event.candidate.candidate),
                sdpMid: event.candidate.sdpMid ?? '0',
                sdpMLineIndex: event.candidate.sdpMLineIndex ?? 0
            });
        }
    };

    try {
        const relabel = relabelOfferH264(data.sdp);
        if (Object.keys(relabel.original).length) streamDiagnostics('h264', `offer relabelled for this browser: ${JSON.stringify(relabel.original)} -> ${browserH264Profile()}`);
        await peerConnection.setRemoteDescription(new RTCSessionDescription({
            type: 'offer',
            sdp: relabel.sdp
        }));

        while (pendingRemoteIceCandidates.length > 0) {
            await peerConnection.addIceCandidate(pendingRemoteIceCandidates.shift());
        }

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        // Send the browser-generated SDP unchanged. Removing extmap, RTX/FEC rtpmap,
        // fmtp, or rtcp-fb lines makes the payload list internally inconsistent.
        // What goes to the desktop client: the answer with TeamSpeak's own H.264 value back.
        const localSdp = withOfferSessionVersion(chromeShapedAnswer(restoreAnswerH264(peerConnection.localDescription.sdp, relabel.original), data.sdp), data.sdp);
        console.log(`[WebRTC] Sending Answer (${localSdp.length} bytes)`);
        const answerInfo = describeSdp(localSdp);
        streamDiagnostics('answer', `video port=${answerInfo.videoPort} codecs=${answerInfo.codecs.join(',') || 'none'} version=${sessionVersion(localSdp)} (browser's ${sessionVersion(peerConnection.localDescription.sdp)})`);
        if (answerInfo.videoPort === '0') {
            // The browser turned the video down: it can't play the format the streamer offered (TeamSpeak's
            // H.264 is a "High" variant browsers don't take). AV1, VP9 and VP8 play.
            videoRejected = true;
            videoLoading.style.display = 'block';
            videoLoading.innerText = `This browser can't play the stream's video format (${offerInfo.codecs.filter((c) => !/-/.test(c)).join(', ') || 'unknown'}). AV1, VP9 and VP8 work.`;
        }
        socket.emit('webrtc-answer', { streamId: currentStreamId, sdp: localSdp });
        streamDiagnostics('answer-ice', iceSetupSummary(localSdp));
        watchIceChecks(peerConnection);

    } catch (err) {
        console.error('[WebRTC] Error negotiating stream:', err);
        videoLoading.innerText = 'Failed to connect.';
    }
});

// 4. The streamer's connection addresses (ICE)
socket.on('webrtc-ice', async (data) => {
    if (data.streamId !== currentStreamId || !data.candidate) return;
    noteRemoteCandidate(data.candidate);

    const candidate = new RTCIceCandidate({
        candidate: data.candidate,
        sdpMid: data.sdpMid,
        sdpMLineIndex: data.sdpMLineIndex
    });

    if (!peerConnection || !peerConnection.remoteDescription) {
        pendingRemoteIceCandidates.push(candidate);
        return;
    }

    try {
        await peerConnection.addIceCandidate(candidate);
    } catch (err) {
        console.warn('[WebRTC] Error adding ICE candidate:', err);
    }
});

socket.on('webrtc-error', (data) => {
    videoLoading.style.display = 'block';
    videoLoading.innerText = data?.message || 'Failed to connect.';
});

// ============================================
// MOBILE AUTOPLAY FIX ("SILENT OSCILLATOR" KIKKA)
// ============================================
let audioUnlocked = false;

function unlockAudioContext() {
    if (audioUnlocked) return;
    
    // 1. Create the audio engines on the user's first tap, if not yet there
    ensurePlayback();
    ensureSoundCtx();

    // 2. Wake the engine up
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    // 3. Play a fraction of a second of silence:
    // the only way to tell iOS Safari and Firefox on phones that 
    // the user really wants sound.
    try {
        const osc = audioCtx.createOscillator();
        const silentGain = audioCtx.createGain();
        silentGain.gain.value = 0; // silence
        osc.connect(silentGain);
        silentGain.connect(audioCtx.destination);
        osc.start(0);
        osc.stop(audioCtx.currentTime + 0.1);
        
        audioUnlocked = true;
        console.log("[Voice] Mobile Audio hardware forcefully unlocked!");
        
        // Once awake, these listeners are no longer needed
        document.removeEventListener('click', unlockAudioContext);
        document.removeEventListener('touchstart', unlockAudioContext);
    } catch (e) {
        console.warn("[Voice] Failed to unlock audio:", e);
    }
}

// The user's first touch or click anywhere (e.g. on a channel or the mute button)
document.addEventListener('click', unlockAudioContext);
document.addEventListener('touchstart', unlockAudioContext, { passive: true });
// After a reconnect the audio engine is made anew outside a tap, and a phone may keep it paused:
// any later tap wakes it.
document.addEventListener('pointerdown', () => {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    if (soundCtx && soundCtx.state === 'suspended') soundCtx.resume().catch(() => {});
}, { passive: true });

// ============================================
// SCREEN SHARING: the browser captures, and every viewer gets their own connection from it
// (TeamSpeak's peer-to-peer mode). The publisher offers; a viewer answers (the mirror of watching).
// ============================================
// The size choices are ceilings: a smaller window keeps its own size and nothing is stretched.
const SHARE_BOXES = { '720': [1280, 720], '1080': [1920, 1080], '1440': [2560, 1440], '2160': [3840, 2160], source: null };
// kbit/s by size and frame rate; only 4K at 60 fps gets the full 10 Mbit/s (every viewer is a separate upload
// from the sharer). "Original size" takes the row of the captured size.
const SHARE_BITRATES = {
    '720': { 30: 2500, 60: 3500 }, '1080': { 30: 4000, 60: 6000 }, '1440': { 30: 6000, 60: 8000 },
    '2160': { 30: 8000, 60: 10000 }
};
function shareBitrate(resolution, fps, width, height) {
    let row = resolution;
    if (!SHARE_BITRATES[row]) {
        const short = Math.min(width || 1920, height || 1080);
        row = short <= 720 ? '720' : short <= 1080 ? '1080' : short <= 1440 ? '1440' : '2160';
    }
    return SHARE_BITRATES[row][fps];
}
let restrictOwnAudioFailed = false;
// A camera (a phone's back or front camera, or a PC's webcam): 30 fps, the size by quality, kbit/s. Every viewer
// is a separate upload, which on mobile data is about 0.45 GB (480p) or 0.9 GB (720p) per hour per viewer.
const CAMERA_SIZES = { '480': [854, 480], '720': [1280, 720] };
const CAMERA_BITRATES = { '480': 1000, '720': 2000 };

const shareBtn = document.getElementById('share-screen');
const shareModal = document.getElementById('share-modal');
const shareBar = document.getElementById('share-bar');
const shareStatus = document.getElementById('share-status');
const selectShareRes = document.getElementById('share-resolution');
const selectShareFps = document.getElementById('share-fps');
const checkShareAudio = document.getElementById('share-audio');
const selectShareSource = document.getElementById('share-source');
const selectCameraFacing = document.getElementById('camera-facing');
const selectCameraQuality = document.getElementById('camera-quality');
const checkCameraSound = document.getElementById('camera-sound');
const shareFlipBtn = document.getElementById('share-flip');
const sharePreview = document.getElementById('share-preview');

// The advice about a share's sound, for the browser in use. Chromium-based browsers (Chrome, Edge, Brave, Opera...)
// share sound from a tab or the entire screen, with switches in their own picker. Firefox (and Safari) give a screen
// or window share no sound at all: they return the picture without it and no error.
const CHROMIUM_BROWSERS = 'a Chromium-based browser (Chrome, Edge, Brave, Opera…)';
const SHARE_SOUND_HELP = (() => {
    const ua = navigator.userAgent;
    if (/Firefox\//.test(ua)) {
        const text = `Firefox can't share a screen's or window's sound. For sound, share from ${CHROMIUM_BROWSERS}.`;
        return { chromium: false, dialog: text, banner: `No sound is shared: ${text}` };
    }
    if (!/Chrome\//.test(ua)) {
        const text = `This browser can't share a screen's sound. For sound, share from ${CHROMIUM_BROWSERS}.`;
        return { chromium: false, dialog: text, banner: `No sound is shared: ${text}` };
    }
    const brands = ((navigator.userAgentData && navigator.userAgentData.brands) || []).map((b) => b.brand);
    const name = brands.includes('Microsoft Edge') || /Edg\//.test(ua) ? 'Edge'
        : brands.includes('Opera') || /OPR\//.test(ua) ? 'Opera'
        : brands.includes('Brave') || navigator.brave ? 'Brave'
        : brands.includes('Google Chrome') ? 'Chrome' : 'This browser';
    return {
        chromium: true,
        dialog: null, // the page's own text
        banner: `No sound is shared: ${name} shares sound only from a tab ("Also share tab audio") or an entire screen ("Also share system audio"). A window has no sound.`
    };
})();
if (SHARE_SOUND_HELP.dialog) document.getElementById('share-audio-desc').textContent = SHARE_SOUND_HELP.dialog;
let share = null; // { kind, stream, resolution, fps, bitrate, streamId, viewers: Map clid -> { pc, pending, answered }, codecs, timer, scale, facing }

// Phones can't share a screen from the browser, but can stream a camera (so can a PC with a webcam).
const canShareScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
const canShareCamera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
shareBtn.classList.toggle('hidden', !canShareScreen && !canShareCamera);
if (!canShareScreen) {
    shareBtn.title = 'Stream your camera';
    shareBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg>';
}

function showShareState() {
    shareBtn.classList.toggle('sharing', !!share);
    shareBar.classList.toggle('hidden', !share);
    shareFlipBtn.classList.toggle('hidden', !share || share.kind !== 'camera' || !share.canFlip);
    // The camera's preview: only on your own screen (no data), mirrored for the front camera like a selfie;
    // viewers get the true picture.
    const camera = !!share && share.kind === 'camera';
    sharePreview.classList.toggle('hidden', !camera);
    sharePreview.classList.toggle('mirror', camera && share.facing === 'user');
    if (!camera && sharePreview.srcObject) {
        sharePreview.srcObject = null;
        sharePreview.classList.remove('big');
    }
    if (!share) return;
    const n = share.viewers.size;
    const what = share.kind === 'camera' ? 'Camera' : 'Sharing';
    shareStatus.textContent = share.streamId ? `${what} · ${n} watching` : 'Starting the share…';
}

// The video format. H.264 first: the graphics card encodes it on nearly every PC (Edge's "hardware?" answer
// was "no" for every format on a PC that has hardware encoding, so that answer isn't trusted), and software VP8 was
// choppy at 4K. TeamSpeak's desktop client agreed to the browser's H.264 but showed a black picture
// ("NullVideoDecoder"): it decodes only its own Constrained High (640c). Constrained Baseline, which a browser
// sends, is a subset of it, so the offer shows H.264 to TeamSpeak as 640c (relabelShareOfferH264) and the
// answer is put back. Then AV1/VP9 if the browser says it encodes them in hardware, then VP8.
// Only one entry of each, as TeamSpeak's own offer has (a phone may list eight H.264 variants, all relabelled to the
// same 640c, and H.265, which TeamSpeak never offers). H.264 keeps its first packetization-mode=1 variant, the one
// TeamSpeak picks; other formats are left out.
function oneOfEachShareCodec(codecs) {
    const seen = new Set();
    return codecs.filter((codec) => {
        const name = ((codec.mimeType || '').split('/')[1] || '').toUpperCase();
        if (!['H264', 'AV1', 'VP9', 'VP8'].includes(name)) return ['RTX', 'RED', 'ULPFEC', 'FLEXFEC-03'].includes(name);
        if (name === 'H264' && !/packetization-mode=1/.test(codec.sdpFmtpLine || '')) return false;
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
    });
}

async function shareCodecPreferences(width, height, fps, bitrate) {
    const caps = (window.RTCRtpSender && RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities('video')) || null;
    if (!caps) return null;
    const mimes = ['H264', 'AV1', 'VP9', 'VP8'];
    const hardware = [];
    if (navigator.mediaCapabilities && navigator.mediaCapabilities.encodingInfo) {
        for (const mime of ['AV1', 'VP9']) {
            try {
                const info = await navigator.mediaCapabilities.encodingInfo({
                    type: 'webrtc',
                    video: { contentType: `video/${mime}`, width, height, bitrate: bitrate * 1000, framerate: fps }
                });
                if (info.supported && info.powerEfficient) hardware.push(mime);
            } catch (e) {}
        }
    }
    const order = ['H264', ...hardware, ...['VP8', 'VP9', 'AV1'].filter((m) => !hardware.includes(m))];
    const rank = (codec) => {
        const name = (codec.mimeType || '').split('/')[1] || '';
        const i = order.findIndex((m) => m.toLowerCase() === name.toLowerCase());
        return i < 0 ? mimes.length + 1 : i; // rtx, red and fec after the formats
    };
    streamDiagnostics('share', `hardware encode: ${hardware.join(',') || 'none'}; preferring ${order[0]}`);
    return oneOfEachShareCodec([...caps.codecs].sort((a, b) => rank(a) - rank(b)));
}

// Lines about formats a media section doesn't list (a=rtcp-fb / a=fmtp / a=rtpmap with a payload type missing from
// its m= line) taken out. Firefox keeps the rtcp-fb lines of the formats setCodecPreferences left out, and the
// TeamSpeak app then refuses the whole offer without a word (Chrome's WebRTC says "Failed to parse codecs
// correctly" for the same offer). Chrome's offers have none, so pass unchanged.
function withoutStrayPayloadLines(sdp) {
    const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
    let listed = null; // payload types of the current media section
    return sdp.split(/\r?\n/).filter((line) => {
        const m = line.match(/^m=\S+ \d+ \S+ (.*)$/);
        if (m) { listed = new Set(m[1].trim().split(/\s+/)); return true; }
        const pt = line.match(/^a=(?:rtcp-fb|fmtp|rtpmap):(\d+) /);
        return !(listed && pt && !listed.has(pt[1]));
    }).join(eol);
}

// Our offer as TeamSpeak sees it: every H.264 format as Constrained High (640c + the same level); `original`
// keeps each payload type's real value, which goes back into TeamSpeak's answer (the mirror of watching).
function relabelShareOfferH264(sdp) {
    const original = {};
    const h264 = new Set([...sdp.matchAll(/^a=rtpmap:(\d+) H264\//gim)].map((m) => m[1]));
    const out = sdp.replace(/^(a=fmtp:(\d+) .*profile-level-id=)([0-9a-f]{4})([0-9a-f]{2})/gim, (line, head, pt, profile, level) => {
        if (!h264.has(pt) || profile.toLowerCase() === '640c') return line;
        original[pt] = profile + level;
        return `${head}640c${level}`;
    });
    return { sdp: out, original };
}

// The TeamSpeak app answers H.264 at level 3.1 (profile-level-id ...1f), and Firefox sends no bigger picture than
// the viewer's level allows: 3.1 is at most 1280x720, so a 4K share reached the app as 720p.
// The app plays streams far above its label (Chrome's and Edge's 4K shares, which ignore the level), so the browser
// is told level 5.2 (34), enough for 4K at 60 fps, with level-asymmetry-allowed=1 so it applies to what it sends.
// Only the browser sees this: TeamSpeak still gets our 640c1f offer unchanged.
function withShareSendLevel(sdp) {
    const h264 = new Set([...sdp.matchAll(/^a=rtpmap:(\d+) H264\//gim)].map((m) => m[1]));
    return sdp.replace(/^(a=fmtp:(\d+) )(.*)$/gim, (line, head, pt, params) => {
        if (!h264.has(pt)) return line;
        const rest = params.split(';').map((p) => p.trim()).filter((p) => p && !/^level-asymmetry-allowed=/i.test(p))
            .map((p) => p.replace(/^(profile-level-id=[0-9a-f]{4})([0-9a-f]{2})$/i,
                (m, profile, level) => (parseInt(level, 16) < 0x34 ? `${profile}34` : m)));
        return `${head}${['level-asymmetry-allowed=1', ...rest].join(';')}`;
    });
}

// What the browser really encodes for a viewer (format, hardware or software, size, frame rate, and what
// limits it), into the bridge log: the browser's own "hardware?" answer proved unreliable.
async function reportShareEncoder(clid, pc) {
    try {
        const stats = await pc.getStats();
        stats.forEach((s) => {
            if (s.type !== 'outbound-rtp' || s.kind !== 'video') return;
            const codec = stats.get(s.codecId);
            streamDiagnostics('share', `viewer ${clid} encoder: ${codec ? codec.mimeType : '?'} ${s.encoderImplementation || '?'} `
                + `hw=${s.powerEfficientEncoder ?? '?'} ${s.frameWidth}x${s.frameHeight} ${Math.round(s.framesPerSecond || 0)}fps limit=${s.qualityLimitationReason || '?'}`);
        });
    } catch (e) {}
}

// How much the picture is scaled down to fit the chosen size (1 = as it is). Keeps the shape.
function shareScale() {
    const box = share.kind === 'camera' ? CAMERA_SIZES[share.resolution] : SHARE_BOXES[share.resolution];
    const s = share.stream.getVideoTracks()[0].getSettings();
    if (!box || !s.width || !s.height) return 1;
    return Math.max(1, Math.max(s.width, s.height) / box[0], Math.min(s.width, s.height) / box[1]);
}

// The real limits live on the connection, not in setupstream: bitrate, frame rate and the size. Keep the
// resolution when the encoder struggles (lower the frame rate instead), as WebSpeak3 measured.
async function applyShareParameters(pc) {
    for (const sender of pc.getSenders()) {
        if (!sender.track) continue;
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        if (sender.track.kind === 'video') {
            params.degradationPreference = 'maintain-resolution';
            params.encodings.forEach((e) => {
                e.maxBitrate = share.bitrate * 1000;
                e.maxFramerate = share.fps;
                e.scaleResolutionDownBy = share.scale;
            });
        } else {
            params.encodings.forEach((e) => { e.maxBitrate = 128000; });
        }
        try { await sender.setParameters(params); } catch (e) { console.warn('[Share] Send parameters not applied:', e.message); }
    }
}

// A window resized while shared: the size limit follows it.
function followShareSize() {
    if (!share || share.kind !== 'screen') return;
    const scale = shareScale();
    if (Math.abs(scale - share.scale) < 0.01) return;
    share.scale = scale;
    share.viewers.forEach((viewer) => applyShareParameters(viewer.pc));
}

function openShareDialog() {
    if (share) return;
    selectShareRes.value = appSettings.shareResolution;
    selectShareFps.value = String(appSettings.shareFps);
    checkShareAudio.checked = appSettings.shareAudio;
    selectShareSource.value = canShareScreen && canShareCamera ? appSettings.shareSource : canShareScreen ? 'screen' : 'camera';
    selectCameraFacing.value = appSettings.cameraFacing;
    selectCameraQuality.value = appSettings.cameraQuality;
    checkCameraSound.checked = appSettings.cameraSound;
    document.getElementById('share-source-group').classList.toggle('hidden', !(canShareScreen && canShareCamera));
    showShareSource();
    shareModal.classList.add('active');
}
// The dialog shows the choices of the chosen source: screen (size, frame rate, sound) or camera (which, quality).
function showShareSource() {
    const camera = selectShareSource.value === 'camera';
    shareModal.querySelectorAll('.share-screen-only').forEach((el) => el.classList.toggle('hidden', camera));
    shareModal.querySelectorAll('.share-camera-only').forEach((el) => el.classList.toggle('hidden', !camera));
    document.getElementById('share-title').textContent = camera ? 'Stream your camera' : 'Share your screen';
    document.getElementById('share-start').textContent = camera ? 'Start camera' : 'Choose what to share…';
}
selectShareSource.addEventListener('change', showShareSource);

// The screen stays on while the camera streams: a phone pauses the camera when the screen turns off.
let wakeLock = null;
async function keepScreenOn() {
    if (!share || share.kind !== 'camera' || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) {
        console.warn('[Share] Screen wake lock not available:', e.message);
    }
}
function letScreenSleep() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && share && share.kind === 'camera' && !wakeLock) keepScreenOn();
});

function cameraConstraints(facing, quality) {
    const [width, height] = CAMERA_SIZES[quality];
    return { video: { facingMode: { ideal: facing }, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30, max: 30 } }, audio: false };
}

function cameraError(e) {
    if (e.name === 'NotAllowedError') return "Couldn't start the camera: the browser wasn't allowed to use it.";
    if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') return 'No camera found.';
    if (e.name === 'NotReadableError') return "Couldn't start the camera: another app may be using it.";
    return `Couldn't start the camera (${e.message}).`;
}

// The camera, streamed like a share (TeamSpeak's stream type 1). Your voice goes to TeamSpeak as usual, so the
// stream itself has no sound (a second copy of the microphone would echo).
async function startCamera() {
    const facing = selectCameraFacing.value === 'user' ? 'user' : 'environment';
    const quality = selectCameraQuality.value === '480' ? '480' : '720';
    const wantSound = checkCameraSound.checked;
    closeShareDialog();
    appSettings.shareSource = 'camera';
    appSettings.cameraFacing = facing;
    appSettings.cameraQuality = quality;
    appSettings.cameraSound = wantSound;
    storeSettings();

    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(facing, quality));
    } catch (e) {
        streamDiagnostics('share-error', `camera ${e.name}: ${e.message} (${facing} ${quality}p)`);
        showBanner(cameraError(e), 'error');
        return;
    }
    if (!socket.connected) {
        stream.getTracks().forEach((t) => t.stop());
        return;
    }
    const video = stream.getVideoTracks()[0];
    video.contentHint = 'motion';
    video.addEventListener('ended', () => stopShare()); // the camera taken away (permission, another app)
    const soundTrack = wantSound ? await cameraSoundTrack() : null;
    if (soundTrack) stream.addTrack(soundTrack);
    else if (wantSound) showBanner("The stream has no sound: the microphone isn't available.", 'error', null, { tag: 'share-sound', hideAfterMs: 15000 });
    const settings = video.getSettings();
    share = { kind: 'camera', stream, resolution: quality, fps: 30, bitrate: CAMERA_BITRATES[quality], streamId: null, viewers: new Map(), codecs: null, scale: 1, facing, canFlip: false, soundTrack };
    updateCameraSound();
    share.scale = shareScale();
    streamDiagnostics('share', `camera ${facing} ${settings.width}x${settings.height} ${Math.round(settings.frameRate || 0)}fps`);
    share.codecs = await shareCodecPreferences(
        Math.round((settings.width || 1280) / share.scale), Math.round((settings.height || 720) / share.scale), 30, share.bitrate);
    if (!share) return; // stopped meanwhile
    // The switch button only with more than one camera (the labels are known once the camera is allowed).
    navigator.mediaDevices.enumerateDevices().then((devices) => {
        if (share && share.kind === 'camera') {
            share.canFlip = devices.filter((d) => d.kind === 'videoinput').length > 1;
            showShareState();
        }
    }).catch(() => {});
    keepScreenOn();
    showCameraPreview(video);
    showShareState();
    socket.emit('publish-start', { name: 'Camera', type: 1, bitrate: share.bitrate, audio: !!soundTrack });
}

// The camera stream's sound: the microphone with echo cancellation (friends' voices from the speaker stay out)
// and automatic level, but without noise suppression, so the surroundings are heard. If the phone won't open
// the microphone a second time with those settings, a copy of the voice microphone is used as it is.
async function cameraSoundTrack() {
    try {
        const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true };
        if (appSettings.inputDeviceId) audio.deviceId = { ideal: appSettings.inputDeviceId };
        const s = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        const track = s.getAudioTracks()[0];
        const got = track.getSettings();
        const voice = micStream && micStream.getAudioTracks()[0];
        const v = voice ? voice.getSettings() : null;
        streamDiagnostics('share', `camera sound: own microphone ec=${got.echoCancellation} ns=${got.noiseSuppression} agc=${got.autoGainControl}`
            + (v ? `; voice still ec=${v.echoCancellation} ns=${v.noiseSuppression} agc=${v.autoGainControl}` : ''));
        return track;
    } catch (e) {
        const voice = micStream && micStream.getAudioTracks()[0];
        streamDiagnostics('share', `camera sound: own microphone refused (${e.name}: ${e.message}); ${voice ? 'using a copy of the voice microphone' : 'none'}`);
        if (!voice) return null;
        const copy = voice.clone();
        copy.enabled = true;
        return copy;
    }
}

// Back <-> front while streaming: the old camera is closed first (a phone can't open both), then every viewer
// gets the new picture on the same connection (no new offer, so nobody drops).
let flipping = false;
async function flipCamera() {
    if (!share || share.kind !== 'camera' || flipping) return;
    flipping = true;
    shareFlipBtn.disabled = true;
    const current = share;
    const next = current.facing === 'user' ? 'environment' : 'user';
    const oldTrack = current.stream.getVideoTracks()[0];
    oldTrack.stop();
    let newTrack = null;
    for (const facing of [next, current.facing]) {
        try {
            const s = await navigator.mediaDevices.getUserMedia(cameraConstraints(facing, current.resolution));
            newTrack = s.getVideoTracks()[0];
            current.facing = facing;
            break;
        } catch (e) {
            streamDiagnostics('share-error', `camera switch to ${facing}: ${e.name}: ${e.message}`);
        }
    }
    flipping = false;
    shareFlipBtn.disabled = false;
    if (share !== current) { if (newTrack) newTrack.stop(); return; }
    if (!newTrack) {
        showBanner("Couldn't switch the camera.", 'error');
        stopShare();
        return;
    }
    newTrack.contentHint = 'motion';
    newTrack.addEventListener('ended', () => { if (share === current && !flipping) stopShare(); });
    current.stream.removeTrack(oldTrack);
    current.stream.addTrack(newTrack);
    current.scale = shareScale();
    for (const viewer of current.viewers.values()) {
        for (const sender of viewer.pc.getSenders()) {
            if (sender.track === oldTrack) {
                await sender.replaceTrack(newTrack).catch((e) => console.warn('[Share] Camera switch not applied:', e.message));
            }
        }
        applyShareParameters(viewer.pc);
    }
    appSettings.cameraFacing = current.facing;
    storeSettings();
    showCameraPreview(newTrack);
    showShareState();
    const s = newTrack.getSettings();
    streamDiagnostics('share', `camera switched to ${current.facing} ${s.width}x${s.height}`);
}
shareFlipBtn.addEventListener('click', flipCamera);

function showCameraPreview(track) {
    sharePreview.srcObject = new MediaStream([track]);
    sharePreview.play().catch(() => {});
}
sharePreview.addEventListener('click', () => sharePreview.classList.toggle('big'));

function closeShareDialog() { shareModal.classList.remove('active'); }

async function startShare() {
    if (selectShareSource.value === 'camera') return startCamera();
    const resolution = selectShareRes.value;
    const fps = Number(selectShareFps.value) === 60 ? 60 : 30;
    const wantAudio = checkShareAudio.checked;
    closeShareDialog();
    appSettings.shareResolution = resolution;
    appSettings.shareFps = fps;
    appSettings.shareAudio = wantAudio;
    appSettings.shareSource = 'screen';
    storeSettings();

    let stream;
    let canRestrict = false;
    try {
        // The browser's own picker: screen, window or tab. Called straight from the click, as browsers require.
        // restrictOwnAudio: this page's own sound (friends' voices, UI sounds) stays out of a system-sound
        // share, so viewers don't hear themselves (an echo otherwise).
        // Left out after a tab share timed out with it (Edge), to tell whether it was the cause.
        canRestrict = !restrictOwnAudioFailed && !!(navigator.mediaDevices.getSupportedConstraints && navigator.mediaDevices.getSupportedConstraints().restrictOwnAudio);
        stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: fps, max: fps } },
            audio: wantAudio
                ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(canRestrict ? { restrictOwnAudio: true } : {}) }
                : false,
            systemAudio: wantAudio ? 'include' : 'exclude',
            selfBrowserSurface: 'exclude'
        });
    } catch (e) {
        // Cancelled in the picker: nothing to say. Anything else goes to the log with what was asked.
        if (e.name === 'NotAllowedError') return;
        streamDiagnostics('share-error', `${e.name}: ${e.message} (sound=${wantAudio} restrictOwnAudio=${canRestrict} ${resolution}p${fps})`);
        if (/timeout/i.test(e.message || '')) {
            if (wantAudio && canRestrict) restrictOwnAudioFailed = true;
            showBanner(SHARE_SOUND_HELP.chromium
                ? "Couldn't start sharing: the browser timed out. If it was a tab, open that tab once (unused tabs can fall asleep) and try again; or share the entire screen with \"Also share system audio\"."
                : "Couldn't start sharing: the browser timed out. Try again.", 'error');
        } else {
            showBanner(`Couldn't start sharing (${e.message}).`, 'error');
        }
        return;
    }
    if (!socket.connected) {
        stream.getTracks().forEach((t) => t.stop());
        return;
    }
    const audioTrack = stream.getAudioTracks()[0];
    streamDiagnostics('share', `sound: asked=${wantAudio} got=${!!audioTrack}`
        + ` restrictOwnAudio=${audioTrack ? (audioTrack.getSettings().restrictOwnAudio ?? 'unsupported') : '-'}`
        + ` surface=${stream.getVideoTracks()[0].getSettings().displaySurface || '?'}`);
    if (wantAudio && !audioTrack) {
        showBanner(SHARE_SOUND_HELP.banner, 'error', null, { tag: 'share-sound', hideAfterMs: 15000 });
    }
    const video = stream.getVideoTracks()[0];
    video.contentHint = fps >= 60 ? 'motion' : 'detail';
    video.addEventListener('ended', () => stopShare()); // the browser's own "Stop sharing"
    const settings = video.getSettings();
    share = { kind: 'screen', stream, resolution, fps, bitrate: shareBitrate(resolution, fps, settings.width, settings.height), streamId: null, viewers: new Map(), codecs: null, scale: 1 };
    share.scale = shareScale();
    share.codecs = await shareCodecPreferences(
        Math.round((settings.width || 1920) / share.scale), Math.round((settings.height || 1080) / share.scale), fps, share.bitrate);
    if (!share) return; // stopped meanwhile
    share.timer = setInterval(followShareSize, 2000);
    showShareState();
    socket.emit('publish-start', {
        name: 'Screen',
        type: settings.displaySurface === 'monitor' ? 2 : 3,
        bitrate: share.bitrate,
        audio: stream.getAudioTracks().length > 0
    });
}

// fromServer: TeamSpeak already ended it (or the connection is gone), so nothing is sent.
function stopShare(fromServer) {
    hideBanner('share-sound');
    if (!share) return;
    const ended = share;
    share = null;
    clearInterval(ended.timer);
    ended.viewers.forEach((viewer) => viewer.pc.close());
    ended.stream.getTracks().forEach((t) => t.stop());
    if (ended.kind === 'camera') letScreenSleep();
    if (!fromServer && socket.connected) socket.emit('publish-stop');
    showShareState();
}

// After the offer has gone: the connection addresses that waited for it, then the rest straight away.
function sendHeldCandidates(viewer) {
    viewer.offerSent = true;
    for (const ice of viewer.outgoing.splice(0)) socket.emit('publish-ice', ice);
}

function dropShareViewer(clid) {
    if (!share) return;
    const viewer = share.viewers.get(clid);
    if (!viewer) return;
    share.viewers.delete(clid);
    viewer.pc.close();
    showShareState();
}

socket.on('publish-started', (data) => {
    if (!share) { socket.emit('publish-stop'); return; }
    share.streamId = data && data.streamId;
    streamDiagnostics('share', `live as ${share.streamId}`);
    showShareState();
});
socket.on('publish-error', (data) => {
    showBanner((data && data.message) || "TeamSpeak refused the share.", 'error');
    stopShare(true);
});
socket.on('publish-stopped', () => stopShare(true));
socket.on('publish-viewer-left', (data) => dropShareViewer(Number(data && data.clid)));

// Everyone may watch: each request is offered the stream right away.
socket.on('publish-viewer', async (data) => {
    const clid = Number(data && data.clid);
    if (!share || !share.streamId || !clid || share.viewers.has(clid)) return;
    const pc = new RTCPeerConnection(rtcConfig());
    // offerSent: TeamSpeak refuses a viewer's connection addresses sent before our offer lets them in (error 5636),
    // so they wait in outgoing until the offer (or a reconnect offer) has gone.
    const viewer = { pc, pending: [], answered: false, offerSent: false, outgoing: [] };
    share.viewers.set(clid, viewer);
    for (const track of share.stream.getTracks()) {
        const transceiver = pc.addTransceiver(track, { direction: 'sendonly', streams: [share.stream] });
        if (track.kind === 'video' && share.codecs && transceiver.setCodecPreferences) {
            try { transceiver.setCodecPreferences(share.codecs); } catch (e) { console.warn('[Share] Codec order not applied:', e.message); }
        }
    }
    // Without sound the offer still gets a sound line (with no track: nothing is sent). The TeamSpeak app 6.0.0-beta5
    // never answers a video-only offer: its log stops at HandleRemoteOffer, while the same share with sound is
    // answered at once.
    if (!share.stream.getAudioTracks().length) pc.addTransceiver('audio', { direction: 'sendonly' });
    pc.onicecandidate = (event) => {
        if (!event.candidate || !event.candidate.candidate) return;
        const ice = {
            clid,
            candidate: chromeShapedCandidate(event.candidate.candidate),
            sdpMid: event.candidate.sdpMid ?? '0',
            sdpMLineIndex: event.candidate.sdpMLineIndex ?? 0
        };
        if (viewer.offerSent) socket.emit('publish-ice', ice); else viewer.outgoing.push(ice);
    };
    pc.onconnectionstatechange = () => {
        streamDiagnostics('share', `viewer ${clid}: ${pc.connectionState}`);
        // Not given up at the first "failed": TeamSpeak's later addresses (or its "reconnect") get 20 s.
        if (pc.connectionState === 'failed') {
            setTimeout(() => {
                const viewer = share && share.viewers.get(clid);
                if (viewer && viewer.pc === pc && pc.connectionState === 'failed') dropShareViewer(clid);
            }, 20000);
        }
        if (pc.connectionState === 'connected') {
            setTimeout(() => reportShareEncoder(clid, pc), 5000);
            setTimeout(() => reportShareEncoder(clid, pc), 30000);
        }
    };
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await applyShareParameters(pc);
        const relabel = relabelShareOfferH264(withoutStrayPayloadLines(chromeShapedAnswer(pc.localDescription.sdp))); // Firefox's layout -> Chrome's
        viewer.h264Original = relabel.original;
        const sdp = relabel.sdp;
        streamDiagnostics('share', `offer to ${clid}: ${describeSdp(sdp).codecs.join(',')}`);
        socket.emit('publish-offer', { clid, sdp });
        sendHeldCandidates(viewer);
    } catch (e) {
        console.warn('[Share] Could not offer the stream:', e);
        dropShareViewer(clid);
    }
    showShareState();
});

socket.on('publish-signal', async (data) => {
    const viewer = share && share.viewers.get(Number(data && data.clid));
    if (!viewer) return;
    const args = data.args || {};
    if (data.cmd === 'answer') {
        const sdp = typeof args === 'string' ? args : (args.answer || args.sdp);
        if (!sdp) return;
        try {
            // TeamSpeak answered our 640c labels: the browser gets its own H.264 values back.
            await viewer.pc.setRemoteDescription({ type: 'answer', sdp: withShareSendLevel(restoreAnswerH264(sdp, viewer.h264Original || {})) });
            viewer.answered = true;
            for (const candidate of viewer.pending.splice(0)) await viewer.pc.addIceCandidate(candidate).catch(() => {});
        } catch (e) {
            console.warn('[Share] The viewer\'s answer was not accepted:', e);
            dropShareViewer(Number(data.clid));
        }
    } else if (data.cmd === 'iceCandidate') {
        const candidate = args.sdp || args.candidate;
        if (!candidate) return;
        // TeamSpeak trickles from the moment it has the offer, so candidates often come before its answer.
        const init = { candidate, sdpMid: args.mid != null ? String(args.mid) : undefined, sdpMLineIndex: typeof args.mLine === 'number' ? args.mLine : undefined };
        if (!viewer.answered) viewer.pending.push(init);
        else viewer.pc.addIceCandidate(init).catch(() => {});
    } else if (data.cmd === 'reconnect') {
        // The viewer's client lost or never got the connection: offer again with fresh connection details,
        // as a TeamSpeak publisher does ("reconnectOffer"; the answer comes back as a normal "answer").
        try {
            viewer.offerSent = false; // the new addresses wait for the reconnect offer too
            const offer = await viewer.pc.createOffer({ iceRestart: true });
            await viewer.pc.setLocalDescription(offer);
            await applyShareParameters(viewer.pc);
            const relabel = relabelShareOfferH264(withoutStrayPayloadLines(chromeShapedAnswer(viewer.pc.localDescription.sdp)));
            viewer.h264Original = relabel.original;
            viewer.answered = false;
            streamDiagnostics('share', `reconnect offer to ${data.clid}`);
            socket.emit('publish-reconnect-offer', { clid: Number(data.clid), sdp: relabel.sdp });
            sendHeldCandidates(viewer);
        } catch (e) {
            console.warn('[Share] Reconnect offer failed:', e);
            dropShareViewer(Number(data.clid));
        }
    } else {
        streamDiagnostics('share', `unhandled signal from ${data.clid}: ${data.cmd}`);
    }
});

shareBtn.addEventListener('click', () => (share ? stopShare() : openShareDialog()));
document.getElementById('share-stop').addEventListener('click', () => stopShare());
document.getElementById('share-cancel').addEventListener('click', closeShareDialog);
document.getElementById('share-close').addEventListener('click', closeShareDialog);
document.getElementById('share-start').addEventListener('click', startShare);

// ============================================
// RELAY FOR PEOPLE BEHIND STRICT NETWORKS (e.g. CG-NAT): a TURN relay, credentials from the bridge
// ============================================
// Browsers try direct routes first and use the relay only when nothing direct works. Credentials last 30 min;
// the page asks for new ones every 25 min and hands them to open connections. At the bridge's 950 GB cap
// (last 31 days) there are none. The setting "Video connection: Always through relay" uses only the relay
// (in case the automatic choice isn't working); without relay credentials it falls back to automatic.
const TS_STUN = [{ urls: 'stun:turn.teamspeak.com:3478' }, { urls: 'stun:turn2.teamspeak.com:3478' }];
let relayServers = [];
let relayInfo = null;
let relayTimer = null;
let relayAsked = false;           // asked again after the TeamSpeak connection came up (per connection)

function rtcConfig() {
    const config = { iceServers: [...TS_STUN, ...relayServers] };
    if (appSettings.videoConnection === 'relay' && relayServers.length) config.iceTransportPolicy = 'relay';
    return config;
}

// Which route a stream connection actually uses: "Relay" (through the TURN relay) or "Direct".
async function connectionRoute(pc) {
    try {
        const stats = await pc.getStats();
        let pair = null;
        stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
        if (!pair) stats.forEach((s) => { if (!pair && s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
        if (!pair) return null;
        const local = stats.get(pair.localCandidateId);
        const remote = stats.get(pair.remoteCandidateId);
        return (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay') ? 'Relay' : 'Direct';
    } catch (e) {
        return null;
    }
}

function requestRelay() {
    clearTimeout(relayTimer);
    if (socket.connected) socket.emit('relay-request');
    relayTimer = setTimeout(requestRelay, 25 * 60 * 1000);
}

// New credentials (or none) to the connections already open, so a relayed one keeps working.
function refreshOpenConnections() {
    const pcs = [peerConnection, ...(share ? [...share.viewers.values()].map((v) => v.pc) : [])].filter(Boolean);
    for (const pc of pcs) {
        try { pc.setConfiguration(rtcConfig()); } catch (e) { console.warn('[Relay] Could not update a connection:', e.message); }
    }
}

function showRelayInfo() {
    const el = document.getElementById('relay-info');
    if (!el) return;
    if (!relayInfo || !relayInfo.configured) { el.textContent = 'Relay: off.'; return; }
    const used = relayInfo.usageGB === null ? '?' : relayInfo.usageGB;
    el.textContent = `Relay: ${used} GB of ${relayInfo.capGB} GB in the last ${relayInfo.windowDays} days`
        + (relayInfo.available ? '.' : ' (paused).');
}

socket.on('relay-credentials', (data) => {
    relayServers = Array.isArray(data && data.iceServers) ? data.iceServers : [];
    relayInfo = data && data.status;
    streamDiagnostics('relay', `credentials ${relayServers.length ? 'received' : 'none'}; ${JSON.stringify(relayInfo)}`);
    refreshOpenConnections();
    showRelayInfo();
});
socket.on('relay-status', (status) => {
    relayInfo = status;
    if (status && !status.available && relayServers.length) {
        relayServers = [];
        refreshOpenConnections();
    }
    showRelayInfo();
});
document.getElementById('open-settings').addEventListener('click', showRelayInfo);
