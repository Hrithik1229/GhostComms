self.addEventListener('install', e => {
  e.waitUntil(
    caches.open('ghostcomms').then(cache => {
      return cache.addAll([
        '/',
        '/index.html',
        '/style.css',
        '/app.js'
      ]);
    })
  );
});