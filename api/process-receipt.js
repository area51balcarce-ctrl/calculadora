import formidable from 'formidable';
import fs from 'fs';
import { PdfReader } from 'pdfreader';

export const config = {
  api: {
    bodyParser: false
  }
};

const VERSION = 'pdfreader-layout-v8';

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Lee importes en estos formatos:
 * 2.209.997,65
 * 2209997.65
 * 2,209,997.65
 * 898,382.79
 * 898.382,79
 */
function parseMoney(raw) {
  if (!raw) return 0;

  let s = String(raw)
    .replace(/\$/g, '')
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '');

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      // Formato argentino: 2.209.997,65
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // Formato inglés que sale de algunos PDFs: 2,209,997.65
      s = s.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    // 2209997,65
    s = s.replace(',', '.');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

const MONEY_REGEX = /-?\$?\s*\d[\d.,]*[.,]\d{2}/g;

function moneyValues(text) {
  const src = String(text || '');
  const values = [];

  for (const match of src.matchAll(MONEY_REGEX)) {
    const raw = match[0];
    const start = match.index || 0;
    const end = start + raw.length;
    const before = src[start - 1] || '';
    const after = src[end] || '';

    // Evita capturar pedazos dentro de números largos.
    if (/[\d.,]/.test(before) || /[\d.,]/.test(after)) continue;

    const value = parseMoney(raw);
    if (Number.isFinite(value)) values.push(value);
  }

  return values;
}

function lastMoney(text) {
  const values = moneyValues(text);
  return values.length ? values[values.length - 1] : 0;
}

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

async function extractRowsFromPdf(buffer) {
  return await new Promise((resolve, reject) => {
    const rows = new Map();

    new PdfReader().parseBuffer(buffer, (err, item) => {
      if (err) {
        reject(err);
        return;
      }

      if (!item) {
        const result = [...rows.values()]
          .sort((a, b) => {
            if (a.page !== b.page) return a.page - b.page;
            return a.y - b.y;
          })
          .map(row => {
            row.items.sort((a, b) => a.x - b.x);
            return row.items.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim();
          })
          .filter(Boolean);

        resolve(result);
        return;
      }

      if (item.page) {
        return;
      }

      if (item.text) {
        const page = item.page || 1;
        const y = Math.round(Number(item.y || 0) * 100) / 100;
        const key = `${page}-${y}`;

        if (!rows.has(key)) {
          rows.set(key, { page, y, items: [] });
        }

        rows.get(key).items.push({
          x: Number(item.x || 0),
          text: String(item.text || '')
        });
      }
    });
  });
}

function findLineIndex(lines, regex) {
  return lines.findIndex(line => regex.test(line));
}

function findAmountByLine(lines, regex) {
  for (const line of lines) {
    if (regex.test(line)) {
      const value = lastMoney(line);
      if (value > 0) return round2(value);
    }
  }
  return 0;
}

function findTotalsRow(lines) {
  let best = null;

  for (const line of lines) {
    const values = moneyValues(line);

    if (values.length >= 3) {
      const [haberesConAporte, haberesSinAporte, totalDescuentos] = values.slice(-3);

      if (haberesConAporte > 100000 && totalDescuentos > 10000) {
        best = {
          haberesConAporte: round2(haberesConAporte),
          haberesSinAporte: round2(haberesSinAporte),
          totalDescuentos: round2(totalDescuentos),
          raw: line
        };
      }
    }
  }

  return best;
}

function findHaberesBySummingConcepts(lines) {
  const ipsIndex = findLineIndex(lines, /i\.?\s*p\.?\s*s|ips\s*14/i);
  if (ipsIndex <= 0) return 0;

  let total = 0;

  for (let i = 0; i < ipsIndex; i++) {
    const line = lines[i];

    // En los recibos del Hospital/Municipio, los conceptos con código menor a 60000 van en Hab. c/Ap.
    const codeMatch = line.match(/\b(\d{5})\b/);
    if (!codeMatch) continue;

    const code = Number(codeMatch[1]);
    if (code >= 10000 && code < 60000) {
      const amount = lastMoney(line);
      if (amount > 0) total += amount;
    }
  }

  return round2(total);
}

function isStopDiscountLine(line) {
  return /(son\s+pesos|liquido\s+a\s+pagar|líquido\s+a\s+pagar|neto\s+a\s+cobrar|neto|liquido|líquido|firma|recibi|recibí|banco|cuenta|cbu)/i.test(line);
}

function ignoreDiscountLine(line) {
  return /(i\.?\s*p\.?\s*s|ips|i\.?\s*o\.?\s*m\.?\s*a|ioma|total|totales|neto|liquido|líquido|son\s+pesos|hab\.?\s*c\/ap|haberes)/i.test(line);
}

function discountsBelowIomaByRows(lines, iomaIndex) {
  if (iomaIndex < 0) return [];

  const discounts = [];

  for (let i = iomaIndex + 1; i < lines.length; i++) {
    const line = cleanText(lines[i]);
    if (!line) continue;
    if (isStopDiscountLine(line)) break;
    if (ignoreDiscountLine(line)) continue;

    const amount = lastMoney(line);
    if (amount <= 0) continue;

    const concept = line.replace(MONEY_REGEX, '').replace(/\s+/g, ' ').trim() || 'Descuento detectado';

    discounts.push({
      concept,
      amount: round2(amount),
      raw: line
    });
  }

  return discounts;
}

function calculateFromRows(rows) {
  const lines = rows.map(cleanText).filter(Boolean);

  const totalsRow = findTotalsRow(lines);

  const haberesPorTotales = totalsRow?.haberesConAporte || 0;
  const haberesPorSuma = findHaberesBySummingConcepts(lines);

  let haberes = haberesPorTotales;
  let fuenteHaberes = 'fila_totales';

  if (!haberes || haberes < 500000) {
    haberes = haberesPorSuma;
    fuenteHaberes = 'suma_codigos_menores_60000';
  }

  const ips = findAmountByLine(lines, /i\.?\s*p\.?\s*s|ips\s*14/i);
  const iomaIndex = findLineIndex(lines, /i\.?\s*o\.?\s*m\.?\s*a|ioma/i);
  const ioma = iomaIndex >= 0 ? round2(lastMoney(lines[iomaIndex])) : 0;

  const discountsByRows = discountsBelowIomaByRows(lines, iomaIndex);
  const totalDiscountsByRows = round2(discountsByRows.reduce((acc, item) => acc + item.amount, 0));

  let descuentosDebajoIoma = totalDiscountsByRows;
  let fuenteDescuentos = 'lineas_debajo_ioma';

  // Regla blindada cuando existe total de descuentos:
  // descuentos debajo de IOMA = total descuentos recibo - IPS - IOMA
  if (totalsRow?.totalDescuentos > 0 && ips > 0 && ioma > 0) {
    descuentosDebajoIoma = round2(totalsRow.totalDescuentos - ips - ioma);
    fuenteDescuentos = 'total_descuentos_recibo_menos_ips_ioma';
  }

  const resultadoX = round2(haberes - ips - ioma);
  const base75 = round2(resultadoX * 0.75);
  const cupoFinal = round2(base75 - descuentosDebajoIoma);

  const manualReview = !haberes || !ips || !ioma || !descuentosDebajoIoma;

  return {
    success: true,
    version: VERSION,
    message: manualReview
      ? 'El recibo fue leído parcialmente. Requiere revisión manual antes de confirmar el cupo.'
      : 'Cupo calculado correctamente.',
    manual_review: manualReview,
    cupo_final: cupoFinal,
    debug: {
      version: VERSION,
      formula: '((Hab. c/Ap. - IPS - IOMA) * 0.75) - descuentos debajo de IOMA',
      fuente_haberes: fuenteHaberes,
      fuente_descuentos: fuenteDescuentos,
      totals_row: totalsRow,
      resumen: {
        haberes: round2(haberes),
        haberes_por_suma_codigos: haberesPorSuma,
        ips,
        ioma,
        resultado_x: resultadoX,
        base_75: base75,
        total_descuentos: descuentosDebajoIoma,
        total_descuentos_recibo: totalsRow?.totalDescuentos || 0
      },
      descuentos_detectados_por_filas: discountsByRows,
      filas_detectadas_preview: lines.slice(0, 80),
      filas_cercanas_ioma: lines.slice(Math.max(0, iomaIndex - 4), Math.min(lines.length, iomaIndex + 18))
    }
  };
}

async function parseForm(req) {
  const form = formidable({
    multiples: false,
    keepExtensions: true,
    maxFileSize: 15 * 1024 * 1024
  });

  return await new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: 'Método no permitido.'
    });
  }

  try {
    const { files } = await parseForm(req);
    const uploaded = files.recibo_pdf;
    const file = Array.isArray(uploaded) ? uploaded[0] : uploaded;

    if (!file) {
      return res.status(400).json({
        success: false,
        message: 'No se recibió ningún PDF.'
      });
    }

    const name = file.originalFilename || file.name || '';

    if (!name.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({
        success: false,
        message: 'Solo se aceptan archivos PDF.'
      });
    }

    const buffer = fs.readFileSync(file.filepath || file.path);
    const rows = await extractRowsFromPdf(buffer);

    if (!rows.length) {
      return res.status(422).json({
        success: false,
        message: 'El PDF no tiene texto seleccionable. Usá el PDF original, no una foto o escaneo.'
      });
    }

    return res.status(200).json(calculateFromRows(rows));
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error al procesar el PDF.',
      error: error.message
    });
  }
}
