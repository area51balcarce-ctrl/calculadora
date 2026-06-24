import formidable from 'formidable';
import fs from 'fs';
import pdfParse from 'pdf-parse';

export const config = {
  api: {
    bodyParser: false
  }
};

const VERSION = 'pdf-parse-final-codigos-v10';

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalize(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

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
      // Formato AR: 2.209.997,65
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // Formato PDF/US: 2,209,997.65 / 922,735.09
      s = s.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    // 2209997,65
    s = s.replace(',', '.');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// Importe completo con 2 decimales. Evita capturar pedazos de números.
const MONEY_REGEX = /(?<![\d.,])-?\$?\s*\d[\d.,]*[.,]\d{2}(?![\d.,])/g;

function moneyValues(text) {
  return (String(text || '').match(MONEY_REGEX) || [])
    .map(parseMoney)
    .filter(n => Number.isFinite(n));
}

function lastMoney(text) {
  const values = moneyValues(text);
  return values.length ? values[values.length - 1] : 0;
}

function findLine(lines, regex) {
  return lines.find(line => regex.test(line)) || '';
}

function findAmountByCode(lines, code, fallbackRegex) {
  const exact = findLine(lines, new RegExp(`\\b${code}\\b`));
  if (exact) {
    const value = lastMoney(exact);
    if (value > 0) return round2(value);
  }

  const fallback = findLine(lines, fallbackRegex);
  if (fallback) {
    const value = lastMoney(fallback);
    if (value > 0) return round2(value);
  }

  return 0;
}

/**
 * Fila final de totales:
 * Hab. c/Ap. | Hab. s/Ap. | Desc.
 *
 * Ejemplos reales:
 * 1900998.51 255208.69 1434909.57
 * 2209997.65 1202135.41 2095517.06
 */
function findTotalsRow(lines) {
  let best = null;

  for (const line of lines) {
    const values = moneyValues(line);

    if (values.length >= 3) {
      const lastThree = values.slice(-3);
      const haberesConAporte = lastThree[0];
      const haberesSinAporte = lastThree[1];
      const totalDescuentos = lastThree[2];

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

function fallbackHaberesByCodes(lines) {
  let total = 0;

  for (const line of lines) {
    const codeMatch = line.match(/\b(\d{5})\b/);
    if (!codeMatch) continue;

    const code = Number(codeMatch[1]);

    // En estos recibos, códigos menores a 60000 son Hab. c/Ap.
    // Presentismo y horas extras 61000/620xx van a Hab. s/Ap., no se suman.
    if (code >= 10000 && code < 60000) {
      const value = lastMoney(line);
      if (value > 0) total += value;
    }

    if (code === 70000) break;
  }

  return round2(total);
}

function calculateFromText(rawText) {
  const text = normalize(rawText);
  const lines = text.split('\n').map(clean).filter(Boolean);

  const totals = findTotalsRow(lines);

  const haberes = totals?.haberesConAporte || fallbackHaberesByCodes(lines);
  const totalDescuentosRecibo = totals?.totalDescuentos || 0;

  const ips = findAmountByCode(lines, '70000', /i\.?\s*p\.?\s*s|ips\s*14/i);
  const ioma = findAmountByCode(lines, '70020', /i\.?\s*o\.?\s*m\.?\s*a|ioma/i);

  const descuentosDebajoIoma = round2(totalDescuentosRecibo - ips - ioma);
  const resultadoX = round2(haberes - ips - ioma);
  const base75 = round2(resultadoX * 0.75);
  const cupoFinal = round2(base75 - descuentosDebajoIoma);

  const manualReview = !haberes || !ips || !ioma || !totalDescuentosRecibo;

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
      formula: '((Hab. c/Ap. - IPS - IOMA) * 0.75) - (Total descuentos recibo - IPS - IOMA)',
      fuente_haberes: totals ? 'fila_totales' : 'suma_codigos_menores_60000',
      fuente_descuentos: 'total_descuentos_recibo_menos_ips_ioma',
      totals_row: totals,
      resumen: {
        haberes: round2(haberes),
        ips: round2(ips),
        ioma: round2(ioma),
        resultado_x: resultadoX,
        base_75: base75,
        total_descuentos: descuentosDebajoIoma,
        total_descuentos_recibo: round2(totalDescuentosRecibo)
      },
      lineas_detectadas: {
        ips_line: findLine(lines, /\b70000\b|i\.?\s*p\.?\s*s|ips\s*14/i),
        ioma_line: findLine(lines, /\b70020\b|i\.?\s*o\.?\s*m\.?\s*a|ioma/i),
        totals_line: totals?.raw || ''
      }
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
    const parsed = await pdfParse(buffer);
    const text = parsed.text || '';

    if (!String(text).trim()) {
      return res.status(422).json({
        success: false,
        message: 'El PDF no tiene texto seleccionable. Usá el PDF original, no una foto o escaneo.'
      });
    }

    return res.status(200).json(calculateFromText(text));
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error al procesar el PDF.',
      error: error.message
    });
  }
}
