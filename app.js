/* ─────────────────────────────────────────
   GhostComms — app.js  (v2 — reliable sync)
   Ultrasonic binary messenger

   PROTOCOL
   ─────────────────────────────────────────
   Slot duration : 100 ms  (matches original)
   Frequencies   : 18 000 Hz = 0  |  20 000 Hz = 1
   Preamble      : 8 slots of 19 000 Hz  ("SYNC")
   Stop marker   : 8 slots of 17 000 Hz  ("END")

   The receiver samples once per slot (at the
   midpoint) so it is immune to frame-rate jitter
   and doesn't accumulate noise bits between slots.
   ───────────────────────────────────────── */

// ── Constants ──
const SLOT_MS       = 100;          // must match sender
const FREQ_ZERO     = 18000;        // Hz → bit 0
const FREQ_ONE      = 20000;        // Hz → bit 1
const FREQ_SYNC     = 19000;        // preamble tone
const FREQ_END      = 17000;        // stop marker
const PREAMBLE_SLOTS = 8;           // how many sync slots
const END_SLOTS      = 8;           // how many end slots
const AMPLITUDE_THRESHOLD = 28;     // ignore silence (0–255 scale)
const FREQ_TOLERANCE      = 600;    // ±Hz band for each tone

// ── Audio context ──
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// ── State ──
let isListening   = false;
let mediaStream   = null;
let animFrameId   = null;
let analyserNode  = null;
let toastTimer    = null;

// Receiver state machine
const RX = {
  state: 'idle',   // idle | sync | data | end
  syncCount: 0,
  endCount: 0,
  bits: '',
  lastSlotTime: 0,
};

// ── DOM refs ──
const messageEl           = document.getElementById('message');
const charCountEl         = document.getElementById('charCount');
const clearBtn            = document.getElementById('clearBtn');
const statusBadge         = document.getElementById('statusBadge');
const statusLabel         = document.getElementById('statusLabel');
const sendBtn             = document.getElementById('sendBtn');
const sendBtnText         = document.getElementById('sendBtnText');
const listenBtn           = document.getElementById('listenBtn');
const listenBtnText       = document.getElementById('listenBtnText');
const listenIcon          = document.getElementById('listenIcon');
const outputEl            = document.getElementById('output');
const outputPlaceholder   = document.getElementById('outputPlaceholder');
const outputBox           = document.getElementById('outputBox');
const copyBtn             = document.getElementById('copyBtn');
const progressContainer   = document.getElementById('progressContainer');
const progressBar         = document.getElementById('progressBar');
const progressPct         = document.getElementById('progressPct');
const logList             = document.getElementById('logList');
const canvas              = document.getElementById('waveformCanvas');
const visualizerIdle      = document.getElementById('visualizerIdle');
const visualizerContainer = document.getElementById('visualizerContainer');
const toast               = document.getElementById('toast');

// ── Canvas setup ──
let ctx2d = null;
let dpr   = window.devicePixelRatio || 1;

function setupCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.round(rect.width  * dpr);
  canvas.height = Math.round(rect.height * dpr);
  canvas.style.width  = rect.width  + 'px';
  canvas.style.height = rect.height + 'px';
  ctx2d = canvas.getContext('2d');
  ctx2d.scale(dpr, dpr);
}
window.addEventListener('resize', setupCanvas);
setupCanvas();

// ── Char counter & clear button ──
messageEl.addEventListener('input', () => {
  const len = messageEl.value.length;
  charCountEl.textContent = len;
  const counter = charCountEl.parentElement;
  counter.className = 'char-counter' +
    (len > 180 ? ' danger' : len > 140 ? ' warn' : '');
  clearBtn.classList.toggle('visible', len > 0);
});

// ── Encode / Decode helpers ──
function textToBinary(text) {
  return text.split('').map(c =>
    c.charCodeAt(0).toString(2).padStart(8, '0')
  ).join('');
}

function binaryToText(binary) {
  const clean = binary.substring(0, binary.length - (binary.length % 8));
  if (!clean) return '';
  return clean.match(/.{1,8}/g)
    .map(b => String.fromCharCode(parseInt(b, 2)))
    .join('');
}

// ── Frequency helpers ──
function near(f, target) {
  return Math.abs(f - target) <= FREQ_TOLERANCE;
}

/** Return the peak frequency and its magnitude from a frequency-data buffer. */
function peakFreq(freqData, sampleRate, fftSize) {
  let maxVal = 0, maxIdx = 0;
  for (let i = 0; i < freqData.length; i++) {
    if (freqData[i] > maxVal) { maxVal = freqData[i]; maxIdx = i; }
  }
  const freq = maxIdx * sampleRate / fftSize;
  return { freq, magnitude: maxVal };
}

// ── Status badge ──
function setStatus(state, label) {
  statusBadge.className = 'status-badge ' + state;
  statusLabel.textContent = label;
}

// ── Toast notification ──
function showToast(message, duration = 2800) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

// ── Shake ──
function shake(el) {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  el.addEventListener('animationend', () => el.classList.remove('shake'), { once: true });
}

// ══════════════════════════════════════════
//  SEND — Text → Ultrasonic audio
//  Now includes preamble + stop marker so
//  the receiver knows when to start / stop.
// ══════════════════════════════════════════

/** Schedule a single tone burst (one slot). */
function scheduleTone(freq, startTime, durationSec) {
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.frequency.value = freq;

  // Tiny fade in/out (5 ms) to avoid clicks
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(1, startTime + 0.005);
  gain.gain.setValueAtTime(1, startTime + durationSec - 0.005);
  gain.gain.linearRampToValueAtTime(0, startTime + durationSec);

  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(startTime);
  osc.stop(startTime + durationSec);
}

function sendMessage() {
  const text = messageEl.value.trim();

  if (!text) {
    shake(messageEl);
    messageEl.focus();
    showToast('⚠️  Please type a message first.');
    return;
  }

  if (audioCtx.state === 'suspended') audioCtx.resume();

  const binary    = textToBinary(text);
  const slotSec   = SLOT_MS / 1000;

  // Total slots: preamble + data + end
  const totalSlots = PREAMBLE_SLOTS + binary.length + END_SLOTS;
  const totalSecs  = totalSlots * slotSec;

  // UI → transmitting
  sendBtn.disabled = true;
  sendBtnText.textContent = 'Transmitting…';
  setStatus('transmitting', 'Transmitting');
  progressContainer.style.display = 'flex';
  progressBar.style.width = '0%';
  progressPct.textContent = '0%';

  let t = audioCtx.currentTime;

  // 1. Preamble (SYNC tones)
  for (let i = 0; i < PREAMBLE_SLOTS; i++) {
    scheduleTone(FREQ_SYNC, t, slotSec);
    t += slotSec;
  }

  // 2. Data bits
  for (const bit of binary) {
    scheduleTone(bit === '1' ? FREQ_ONE : FREQ_ZERO, t, slotSec);
    t += slotSec;
  }

  // 3. End marker
  for (let i = 0; i < END_SLOTS; i++) {
    scheduleTone(FREQ_END, t, slotSec);
    t += slotSec;
  }

  // Animate progress bar
  const startAudioTime = audioCtx.currentTime;
  const tick = setInterval(() => {
    const elapsed = audioCtx.currentTime - startAudioTime;
    const pct = Math.min((elapsed / totalSecs) * 100, 100);
    progressBar.style.width = pct + '%';
    progressPct.textContent = Math.round(pct) + '%';

    if (pct >= 100) {
      clearInterval(tick);
      setTimeout(() => {
        progressContainer.style.display = 'none';
        progressBar.style.width = '0%';
        sendBtn.disabled = false;
        sendBtnText.textContent = 'Transmit Message';
        setStatus('idle', 'Idle');
        addLog('sent', text);
        showToast('✅  Transmitted: "' + (text.length > 40 ? text.slice(0, 40) + '…' : text) + '"');
      }, 300);
    }
  }, 80);
}

// ══════════════════════════════════════════
//  RECEIVE — Microphone → slot-sampled decode
//
//  State machine:
//    idle  → waiting for SYNC preamble
//    sync  → counting consecutive SYNC slots
//    data  → collecting data bits
//    end   → counting END slots (commit message)
// ══════════════════════════════════════════

async function toggleListening() {
  isListening ? stopListening() : await startListening();
}

async function startListening() {
  try {
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    isListening = true;

    const source = audioCtx.createMediaStreamSource(mediaStream);
    analyserNode = audioCtx.createAnalyser();

    // Larger FFT → better frequency resolution at ultrasonic range
    analyserNode.fftSize = 4096;
    // No smoothing — we need crisp slot boundaries
    analyserNode.smoothingTimeConstant = 0.1;

    source.connect(analyserNode);

    const freqData = new Uint8Array(analyserNode.frequencyBinCount);
    const timeData = new Uint8Array(analyserNode.frequencyBinCount);

    // Reset RX state machine
    RX.state = 'idle';
    RX.syncCount = 0;
    RX.endCount = 0;
    RX.bits = '';
    RX.lastSlotTime = performance.now();

    // UI → listening state
    listenBtn.classList.add('active');
    listenBtnText.textContent = 'Stop Listening';
    listenIcon.classList.add('pulsing');
    visualizerIdle.classList.add('hidden');
    visualizerContainer.classList.add('active');
    setStatus('listening', 'Listening');

    function detect(now) {
      if (!isListening) return;
      animFrameId = requestAnimationFrame(detect);

      analyserNode.getByteFrequencyData(freqData);
      analyserNode.getByteTimeDomainData(timeData);

      // Waveform draw (every frame)
      drawWaveform(timeData);

      // ── Slot-based sampling ──
      // Only evaluate frequency once per slot (at each slot boundary).
      const elapsed = now - RX.lastSlotTime;
      if (elapsed < SLOT_MS) return;           // wait for slot boundary
      RX.lastSlotTime = now;

      const { freq, magnitude } = peakFreq(freqData, audioCtx.sampleRate, analyserNode.fftSize);

      // Below threshold → treat as silence (don't advance state machine)
      if (magnitude < AMPLITUDE_THRESHOLD) {
        // If we were mid-stream and hear enough silence, reset
        if (RX.state === 'data') {
          // Don't reset immediately — could be a momentary dip
          // Only reset if we have no data yet
          if (!RX.bits) { RX.state = 'idle'; RX.syncCount = 0; }
        }
        return;
      }

      // ── State machine ──
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
              // Preamble confirmed — start collecting data
              RX.state = 'data';
              RX.bits = '';
              RX.endCount = 0;
              showToast('📡  Signal locked — receiving…', 60000);
            }
          } else {
            // Lost sync tone — restart
            RX.syncCount = 0;
            RX.state = 'idle';
          }
          break;

        case 'data':
          if (near(freq, FREQ_END)) {
            // Possible end marker
            RX.endCount++;
            if (RX.endCount >= END_SLOTS) {
              commitMessage();
            }
          } else if (near(freq, FREQ_ZERO)) {
            RX.bits += '0';
            RX.endCount = 0;
            updateLiveOutput();
          } else if (near(freq, FREQ_ONE)) {
            RX.bits += '1';
            RX.endCount = 0;
            updateLiveOutput();
          } else if (near(freq, FREQ_SYNC)) {
            // Spurious re-sync — ignore, keep collecting
          } else {
            // Unknown frequency — treat as noise, don't advance endCount
          }
          break;
      }
    }

    requestAnimationFrame(detect);
    showToast('🎙️  Microphone active — listening for signals…');

  } catch (err) {
    console.error('Microphone error:', err);
    isListening = false;

    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      showToast('🚫  Microphone permission denied. Please allow access.', 4000);
    } else if (err.name === 'NotFoundError') {
      showToast('🚫  No microphone found on this device.', 4000);
    } else {
      showToast('🚫  Microphone error: ' + err.message, 4000);
    }
  }
}

/** Show partially decoded text in real time while receiving. */
function updateLiveOutput() {
  const text = binaryToText(RX.bits);
  if (text) {
    outputEl.textContent = text;
    outputPlaceholder.style.display = 'none';
    outputBox.classList.add('has-output');
    copyBtn.style.display = 'flex';
  }
}

/** End-of-transmission: log the complete message. */
function commitMessage() {
  const text = binaryToText(RX.bits);

  // Reset state machine for next message
  RX.state = 'idle';
  RX.syncCount = 0;
  RX.endCount = 0;
  RX.bits = '';

  if (text && text.trim()) {
    outputEl.textContent = text;
    outputPlaceholder.style.display = 'none';
    outputBox.classList.add('has-output');
    copyBtn.style.display = 'flex';
    addLog('received', text);
    showToast('✅  Message received!');
  } else {
    showToast('⚠️  Signal detected but could not decode. Try again.', 4000);
  }
}

function stopListening() {
  isListening = false;

  if (animFrameId) cancelAnimationFrame(animFrameId);
  if (mediaStream)  mediaStream.getTracks().forEach(t => t.stop());

  // If we had partial data in-flight, commit it
  if (RX.state === 'data' && RX.bits.length >= 8) {
    const text = binaryToText(RX.bits);
    if (text && text.trim()) addLog('received', text);
  }

  // Reset state
  RX.state = 'idle';
  RX.syncCount = 0;
  RX.endCount = 0;
  RX.bits = '';

  // UI → idle
  listenBtn.classList.remove('active');
  listenBtnText.textContent = 'Start Listening';
  listenIcon.classList.remove('pulsing');
  visualizerIdle.classList.remove('hidden');
  visualizerContainer.classList.remove('active');
  setStatus('idle', 'Idle');

  if (ctx2d) {
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    ctx2d.clearRect(0, 0, w, h);
  }

  showToast('⏹  Stopped listening.');
}

// ══════════════════════════════════════════
//  WAVEFORM DRAWING
// ══════════════════════════════════════════
function drawWaveform(timeData) {
  if (!ctx2d) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;

  ctx2d.clearRect(0, 0, W, H);

  const gradient = ctx2d.createLinearGradient(0, 0, 0, H);
  gradient.addColorStop(0, 'rgba(176,110,243,0.18)');
  gradient.addColorStop(1, 'rgba(176,110,243,0)');

  ctx2d.beginPath();
  const sliceW = W / timeData.length;
  let x = 0;
  for (let i = 0; i < timeData.length; i++) {
    const v = timeData[i] / 128.0;
    const y = (v * H) / 2;
    i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
    x += sliceW;
  }
  ctx2d.lineTo(W, H / 2);
  ctx2d.lineTo(W, H);
  ctx2d.lineTo(0, H);
  ctx2d.closePath();
  ctx2d.fillStyle = gradient;
  ctx2d.fill();

  ctx2d.beginPath();
  x = 0;
  for (let i = 0; i < timeData.length; i++) {
    const v = timeData[i] / 128.0;
    const y = (v * H) / 2;
    i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
    x += sliceW;
  }
  ctx2d.lineTo(W, H / 2);
  ctx2d.strokeStyle = '#b06ef3';
  ctx2d.lineWidth   = 2;
  ctx2d.shadowColor = '#b06ef3';
  ctx2d.shadowBlur  = 8;
  ctx2d.stroke();
  ctx2d.shadowBlur  = 0;
}

// ══════════════════════════════════════════
//  CLEAR / COPY
// ══════════════════════════════════════════
function clearMessage() {
  messageEl.value = '';
  charCountEl.textContent = '0';
  charCountEl.parentElement.className = 'char-counter';
  clearBtn.classList.remove('visible');
  messageEl.focus();
}

function clearOutput() {
  outputEl.textContent = '';
  outputPlaceholder.style.display = '';
  outputBox.classList.remove('has-output');
  copyBtn.style.display = 'none';
  RX.bits = '';
}

async function copyOutput() {
  const text = outputEl.textContent;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.classList.add('copied');
    copyBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
    setTimeout(() => {
      copyBtn.classList.remove('copied');
      copyBtn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy';
    }, 2000);
    showToast('📋  Copied to clipboard!');
  } catch {
    showToast('⚠️  Could not copy — try selecting manually.');
  }
}

// ══════════════════════════════════════════
//  TRANSMISSION LOG
// ══════════════════════════════════════════
function addLog(type, message) {
  const empty = document.getElementById('logEmpty');
  if (empty) empty.remove();

  const item  = document.createElement('div');
  item.className = 'log-item ' + type;

  const badge = document.createElement('span');
  badge.className = 'log-badge';
  badge.textContent = type === 'sent' ? 'Sent' : 'Received';

  const msg = document.createElement('span');
  msg.className = 'log-message';
  msg.textContent = message;
  msg.title = message;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  item.append(badge, msg, time);
  logList.insertBefore(item, logList.firstChild);
}

function clearLog() {
  logList.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'log-empty';
  empty.id = 'logEmpty';
  empty.textContent = 'No transmissions yet';
  logList.appendChild(empty);
}

// ── Ctrl+Enter to transmit ──
messageEl.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    sendMessage();
  }
});
