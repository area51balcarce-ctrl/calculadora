# Fix PDF Reader V8

Esta versión deja de usar pdf-parse y usa pdfreader para reconstruir filas por coordenadas,
similar a pdftotext -layout del proyecto viejo.

Reemplazar:
- api/process-receipt.js
- package.json

Luego commit y redeploy en Vercel.
