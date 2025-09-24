const express = require('express');
const app = express();

app.get('/test', (req, res) => {
  console.log('Test route hit!');
  res.json({ message: 'Working!' });
});

app.listen(3001, () => {
  console.log('Simple test server running on port 3001');
});