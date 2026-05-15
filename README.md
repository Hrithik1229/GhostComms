# GhostComms

**GhostComms** is a browser-based ultrasonic messenger that encodes text as inaudible audio tones and decodes received ultrasonic signals via the microphone.

## Features

- Transmit secret messages using ultrasonic audio frequencies
- Receive and decode inaudible signals in real time
- Clean, responsive UI with transmit/receive panels
- Progressive Web App support via `manifest.json`
- Service worker registration in `index.html`

## Files

- `index.html` — main application UI
- `style.css` — visual styling and layout
- `app.js` — application logic for encoding, decoding, and interaction
- `sw.js` — service worker registration script
- `manifest.json` — PWA metadata

## Usage

1. Open `index.html` in a modern browser.
2. Type a message in the `Transmit` panel.
3. Click **Transmit Message** to generate ultrasonic audio.
4. On another device or browser tab, open GhostComms and start listening.

## Notes

- Best experienced on desktops or devices with a microphone and speaker capable of ultrasonic frequencies.
- The browser may request microphone permissions for receiving messages.

## License

This project does not currently include a license file.
