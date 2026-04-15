import express from 'express';

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'growth-api', version: '0.1.0' });
});

app.get('/', (_req, res) => {
  res.json({ message: 'growth API  AI Revenue System by AxisOne' });
});

app.listen(PORT, () => {
  console.log(`growth-api listening on port ${PORT}`);
});
