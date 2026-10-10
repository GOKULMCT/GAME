// Client configuration.
//
// By default the page talks to the same server that delivered it, which is what
// you want when Node serves both the frontend and Socket.IO (the recommended setup).
//
// Only set SERVER_URL if you host the static files somewhere else and the Socket.IO
// backend on a different domain, e.g. "https://snake-api.example.com". See README.md
// ("Hosting frontend and backend separately").
window.SNAKE_CONFIG = {
  SERVER_URL: '',
};
