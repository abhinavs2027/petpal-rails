// Local run: node server.js  (state kept in memory unless Upstash env vars are set)
const app = require('./app');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PetPal rails server on http://localhost:${PORT}`));
