import formidable from 'formidable';
import fs from 'fs';
import pdfParse from 'pdf-parse';

export const config = { api: { bodyParser: false } };

const VERSION = 'formula-exacta-v6-totales-globales';

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function normalizeText(text) {
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
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    s = s.replace(',', '.');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

const MONEY_REGEX = /-?\$?\s*\d[\d.,]*[.,]\d{2}/g;

function moneyMatches(text) {
  const source = String(text || '');
  const result = [];

  for (const match of source.matchAll(MONEY_REGEX)) {
    const raw = match[0];
    const index = match.index || 0;
    const end = index + raw.length;

    const before = source[index - 1] || '';
    const after = source[end] || '';

    // No capturar pedazos dentro de números largos.
    if (/[\d.,]/.test(before) || /[\d.,]/.test(after)) continue;

    const value = parseMoney(raw);
    if (Number.isFinite(value)) {
      result.push({ raw, value: round2(value), index });
    }
  }

  return result;
}

function firstAmountAfter(text, labelRegex, maxChars = 220) {
  const match = labelRegex.exec(text);
  if (!match) return 0;

  const start = match.index + match[0].length;
  const slice = text.slice(start, start + maxChars);
  const amounts = moneyMatches(slice).map(item => item.value).filter(v => v > 0);

  return amounts.length ? round2(amounts[0]) : 0;
}

function findTotalsRowGlobal(text) {
  const sonPesosIndex = text.search(/son\s+pesos/i);
  const searchText = sonPesosIndex >= 0 ? text.slice(0, sonPesosIndex) : text;
  const amounts = moneyMatches(searchText)
    .map(item => item.value)
    .filter(v => v > 0);

  // En estos recibos, justo antes de "Son Pesos" están:
  // Total Hab. c/Ap. | Total Hab. s/Ap. | Total Desc.
  if (amounts.length >= 3) {
    const [haberesConAporte, haberesSinAporte, totalDescuentos] = amounts.slice(-3);

    if (haberesConAporte > 100000 && totalDescuentos > 10000) {
      return {
        haberesConAporte: round2(haberesConAporte),
        haberesSinAporte: round2(haberesSinAporte),
        totalDescuentos: round2(totalDescuentos)
      };
    }
  }

  return null;
}

function fallbackHaberes(text) {
  const ipsIndex = text.search(/i\.?\s*p\.?\s*s|ips\s*14/i);
  if (ipsIndex <= 0) return 0;

  const beforeIps = text.slice(0, ipsIndex);
  const conceptRegex = /(SUELDO BASICO|SUELDO BÁSICO|JORNADA PROLONGADA|ANTIGÜEDAD|REFRIGERIO|HORARIO NOCTURNO)/gi;

  let total = 0;
  let match;

  while ((match = conceptRegex.exec(beforeIps)) !== null) {
    const amount = firstAmountAfter(beforeIps.slice(match.index), /(?:SUELDO BASICO|SUELDO BÁSICO|JORNADA PROLONGADA|ANTIGÜEDAD|REFRIGERIO|HORARIO NOCTURNO)/i, 120);
    if (amount > 0) total += amount;
  }

  return round2(total);
}

function calculateFromText(rawText) {
  const text = normalizeText(rawText);

  const totals = findTotalsRowGlobal(text);

  const haberes = totals?.haberesConAporte || fallbackHaberes(text);

  const ips = firstAmountAfter(text, /i\.?\s*p\.?\s*s\.?\s*14\s*%?|ips\s*14\s*%?/i, 180);
  const ioma = firstAmountAfter(text, /i\.?\s*o\.?\s*m\.?\s*a\.?\s*4,?8\s*%?|ioma\s*4,?8\s*%?/i, 180);

  const totalDescuentosRecibo = totals?.totalDescuentos || 0;

  let descuentosDebajoIoma = 0;
  let fuenteDescuentos = 'sin_total_descuentos';

  if (totalDescuentosRecibo > 0 && ips > 0 && ioma > 0) {
    descuentosDebajoIoma = round2(totalDescuentosRecibo - ips - ioma);
    fuenteDescuentos = 'total_descuentos_recibo_menos_ips_ioma';
  }

  const resultadoX = round2(haberes - ips - ioma);
  const base75 = round2(resultadoX * 0.75);
  const cupoFinal = round2(base75 - descuentosDebajoIoma);

  const manualReview = !totals || !haberes || !ips || !ioma || !totalDescuentosRecibo;

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
      fuente_descuentos: fuenteDescuentos,
      totals_row: totals,
      resumen: {
        haberes: round2(haberes),
        ips: round2(ips),
        ioma: round2(ioma),
        resultado_x: resultadoX,
        base_75: base75,
        total_descuentos: descuentosDebajoIoma,
        total_descuentos_recibo: totalDescuentosRecibo
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
