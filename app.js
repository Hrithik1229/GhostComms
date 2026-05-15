// GhostComms — Stable Audio Messenger

const SLOT_MS = 180;

const FREQ_ZERO = 1200;
const FREQ_ONE = 2400;
const FREQ_SYNC = 1800;
const FREQ_END = 900;

const PREAMBLE_SLOTS = 6;
const END_SLOTS = 6;

const AMPLITUDE_THRESHOLD = 15;
const FREQ_TOLERANCE = 250;

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

let isListening = false;
let mediaStream = null;
let analyserNode = null;
let animFrameId = null;

const RX = {
  state: 'idle',
  syncCount: 0,
  endCount: 0,
  bits: '',
  lastSlotTime: 0,
};

const messageEl = document.getElementById('message');
const outputEl = document.getElementById('output');
const outputPlaceholder = document.getElementById('outputPlaceholder');
const sendBtn = document.getElementById('sendBtn');
const listenBtn = document.getElementById('listenBtn');
const statusLabel = document.getElementById('statusLabel');

function setStatus(text) {
  statusLabel.textContent = text;
}

function textToBinary(text) {
  return text
    .split('')
    .map(c => c.charCodeAt(0).toString(2).padStart(8, '0'))
    .join('');
}

function binaryToText(binary) {
  const clean = binary.substring(0, binary.length - (binary.length % 8));

  if (!clean) return '';

  return clean.match(/.{1,8}/g)
    .map(byte => String.fromCharCode(parseInt(byte, 2)))
    .join('');
}

function near(freq, target) {
  return Math.abs(freq - target) <= FREQ_TOLERANCE;
}

function peakFreq(freqData, sampleRate, fftSize) {
  let maxVal = 0;
  let maxIdx = 0;

  for (let i = 0; i < freqData.length; i++) {
    if (freqData[i] > maxVal) {
      maxVal = freqData[i];
      maxIdx = i;
    }
  }

  return {
    freq: maxIdx * sampleRate / fftSize,
    magnitude: maxVal
  };
}

function scheduleTone(freq, startTime, durationSec) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.frequency.value = freq;

  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(1.5, startTime + 0.01);
  gain.gain.setValueAtTime(1.5, startTime + durationSec - 0.01);
  gain.gain.linearRampToValueAtTime(0, startTime + durationSec);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start(startTime);
  osc.stop(startTime + durationSec);
}

function sendMessage() {
  const text = messageEl.value.trim();

  if (!text) {
    alert('Type a message');
    return;
  }

  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  const binary = textToBinary(text);

  const slotSec = SLOT_MS / 1000;

  let t = audioCtx.currentTime;

  setStatus('Transmitting');

  sendBtn.disabled = true;

  // Sync
  for (let i = 0; i < PREAMBLE_SLOTS; i++) {
    scheduleTone(FREQ_SYNC, t, slotSec);
    t += slotSec;
  }

  // Data
  for (const bit of binary) {
    if (bit === '1') {
      scheduleTone(FREQ_ONE, t, slotSec);
    } else {
      scheduleTone(FREQ_ZERO, t, slotSec);
    }

    t += slotSec;
  }

  // End
  for (let i = 0; i < END_SLOTS; i++) {
    scheduleTone(FREQ_END, t, slotSec);
    t += slotSec;
  }

  const totalDuration = (
    PREAMBLE_SLOTS +
    binary.length +
    END_SLOTS
  ) * SLOT_MS;

  setTimeout(() => {
    setStatus('Idle');
    sendBtn.disabled = false;
  }, totalDuration + 500);
}

async function toggleListening() {
  if (isListening) {
    stopListening();
  } else {
    await startListening();
  }
}

async function startListening() {

  try {

    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true
    });

    analyserNode = audioCtx.createAnalyser();

    analyserNode.fftSize = 4096;
    analyserNode.smoothingTimeConstant = 0.3;

    const source = audioCtx.createMediaStreamSource(mediaStream);

    source.connect(analyserNode);

    isListening = true;

    listenBtn.innerText = 'Stop Listening';

    setStatus('Listening');

    RX.state = 'idle';
    RX.syncCount = 0;
    RX.endCount = 0;
    RX.bits = '';

    const freqData = new Uint8Array(analyserNode.frequencyBinCount);

    function detect(now) {

      if (!isListening) return;

      animFrameId = requestAnimationFrame(detect);

      analyserNode.getByteFrequencyData(freqData);

      const elapsed = now - RX.lastSlotTime;

      if (elapsed < SLOT_MS) return;

      RX.lastSlotTime = now;

      const { freq, magnitude } = peakFreq(
        freqData,
        audioCtx.sampleRate,
        analyserNode.fftSize
      );

      if (magnitude < AMPLITUDE_THRESHOLD) return;

      switch (RX.state) {

        case 'idle':

          if (near(freq, FREQ_SYNC)) {
            RX.syncCount = 1;
            RX.state = 'sync';
          }

          break;

        case 'sync':

          if (near(freq, FREQ_SYNC)) {

            RX.syncCount++;

            if (RX.syncCount >= PREAMBLE_SLOTS) {

              RX.state = 'data';
              RX.bits = '';
              RX.endCount = 0;
            }

          } else {

            RX.state = 'idle';
            RX.syncCount = 0;
          }

          break;

        case 'data':

          if (near(freq, FREQ_ZERO)) {

            RX.bits += '0';
            RX.endCount = 0;
          }

          else if (near(freq, FREQ_ONE)) {

            RX.bits += '1';
            RX.endCount = 0;
          }

          else if (near(freq, FREQ_END)) {

            RX.endCount++;

            if (RX.endCount >= END_SLOTS) {

              const text = binaryToText(RX.bits);

              if (text) {

                outputPlaceholder.style.display = 'none';
                outputEl.textContent = text;
              }

              RX.state = 'idle';
              RX.syncCount = 0;
              RX.endCount = 0;
              RX.bits = '';
            }
          }

          break;
      }
    }

    requestAnimationFrame(detect);

  } catch (err) {

    console.error(err);

    alert('Microphone permission denied');
  }
}

function stopListening() {

  isListening = false;

  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
  }

  listenBtn.innerText = 'Start Listening';

  setStatus('Idle');
}

function clearMessage() {
  messageEl.value = '';
}

function clearOutput() {
  outputEl.textContent = '';
  outputPlaceholder.style.display = 'block';
}

async function copyOutput() {

  const text = outputEl.textContent;

  if (!text) return;

  await navigator.clipboard.writeText(text);

  alert('Copied');
}